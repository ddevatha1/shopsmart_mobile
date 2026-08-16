import type { StoreLocation } from '../../types/index.ts';
import { TtlCache } from '../../utils/ttlCache.ts';
import { dedupeInFlight } from '../../utils/dedupeInFlight.ts';
import { withTimeout } from '../../utils/withTimeout.ts';
import { geocodeZip, haversineDistanceMiles } from '../../utils/geocode.ts';
import { markStoreReady } from '../storeReadiness.ts';
import type { PreciseCoords, StoreLocator } from './types.ts';

/**
 * Whole Foods Market (an Amazon subsidiary) — wholefoodsmarket.com has no
 * public "nearest store by zip" listing endpoint that returns a numeric
 * store ID. Its in-page "Find a store" widget is a bundled Amazon Location
 * component (`AmazonPhysicalLocationFinderService`, visible in its map-tile
 * request URLs); every real network trace of it, across multiple ZIPs,
 * showed only map-tile/style/glyph/sprite requests — never a plain,
 * inspectable same-origin XHR carrying a nearby-store list. That widget's
 * own data source could not be found.
 *
 * What DOES exist, real, live, and unauthenticated:
 *
 *   GET https://www.wholefoodsmarket.com/api/stores/{numericId}/summary
 *
 * Confirmed live: returns real `{storeId, displayName, status,
 * primaryLocation: {address, latitude, longitude}}` for a valid ID, a
 * plain 400 for an invalid one — no cookies, auth, or subscription key
 * needed. `/api/` is not disallowed by robots.txt (only /locations/,
 * /account/, /email/, /login/, /logout/, /preview, /cart, /grocery/cart,
 * /catering/cart are).
 *
 * Numeric IDs are not sequential/dense across all of Amazon's ID space,
 * but ARE densely clustered in one narrow band — confirmed live by probing
 * ~35 IDs spanning 9000-12000: every real store found fell between roughly
 * 10000 and 10860, and every probe outside that band came back 400. That
 * makes a one-time bounded scan of that band a real, complete store
 * directory — the same shape and cost as albertsonsLocator.ts's sitemap
 * crawl or traderJoesLocator.ts's directory crawl (~560 real stores
 * either way), just keyed by numeric ID instead of URL slug. Run with
 * bounded concurrency (CRAWL_CONCURRENCY) and cached 24h, same as those.
 *
 * This ALSO solves a second problem for free: search
 * (wholeFoodsLiveScraper.ts) needs this exact numeric ID to bootstrap a
 * store-bound session, and there is no other discovered public way to
 * resolve an arbitrary ZIP to one. Building the directory this way means
 * the locator and the search adapter share one real, verified ID — see
 * `findNearestStoreUncached`'s `WholeFoodsStore` return shape, exported
 * for exactly that reuse.
 *
 * Every store's own lat/lng comes directly from this endpoint — no
 * geocoding of candidates is needed (only the shopper's ZIP is geocoded,
 * purely to rank the already-real candidates, same reasoning as
 * krogerLocator.ts).
 */
const SUMMARY_URL = (id: number) => `https://www.wholefoodsmarket.com/api/stores/${id}/summary`;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

// Confirmed live (see header comment) — padded slightly beyond the
// observed 10000-10860 hit band in case new stores get numbered just
// outside what was observed at investigation time. This is a real,
// documented fragility: a store opening with an ID outside this range
// won't be found until the range is widened.
const ID_RANGE_START = 9950;
const ID_RANGE_END = 10950;
// Bounded concurrency so the one-time crawl doesn't fire ~1000 requests
// at once — a burst like that serves no purpose for a background warm-up
// task with no latency deadline, and is gentler on Whole Foods' servers.
const CRAWL_CONCURRENCY = 20;
const SUMMARY_TIMEOUT_MS = 6000;

interface StoreSummary {
  storeId?: number;
  token?: string;
  displayName?: string;
  status?: string;
  primaryLocation?: {
    address?: {
      STREET_ADDRESS_LINE1?: string;
      CITY?: string;
      STATE?: string;
      ZIP_CODE?: string;
    };
    latitude?: number;
    longitude?: number;
  };
}

export interface WholeFoodsStore {
  storeId: number;
  location: StoreLocation;
}

const directoryCache = new TtlCache<WholeFoodsStore[]>(24 * 60 * 60 * 1000);
const nearestStoreCache = new TtlCache<WholeFoodsStore>(60 * 60 * 1000);

export async function fetchStoreSummary(id: number): Promise<WholeFoodsStore | undefined> {
  try {
    const res = await withTimeout(
      fetch(SUMMARY_URL(id), { headers: { 'User-Agent': USER_AGENT } }),
      SUMMARY_TIMEOUT_MS,
      'Whole Foods store summary',
    );
    if (!res.ok) return undefined;
    const json = (await res.json()) as StoreSummary;
    return toWholeFoodsStore(json);
  } catch {
    return undefined;
  }
}

// Pure mapping, split out from fetchStoreSummary so it's directly testable
// against a captured fixture without mocking fetch (same convention as
// krogerLocator.ts's toStoreLocation / tomThumbLocator.ts's toStoreLocation).
export function toWholeFoodsStore(json: StoreSummary): WholeFoodsStore | undefined {
  // A permanently-closed or not-yet-open store would otherwise still
  // resolve a real-looking address — never treated as a viable candidate.
  if (json.status !== 'Open' || !json.storeId) return undefined;

  const address = json.primaryLocation?.address;
  const line1 = address?.STREET_ADDRESS_LINE1;
  const city = address?.CITY;
  const state = address?.STATE;
  const zipRaw = address?.ZIP_CODE;
  if (!line1 || !city || !state || !zipRaw) return undefined;

  return {
    storeId: json.storeId,
    location: {
      name: `Whole Foods Market - ${json.displayName ?? city}`,
      storeId: String(json.storeId),
      address: line1,
      city,
      state,
      // The API's ZIP_CODE carries a ZIP+4 suffix (e.g. "75093-2306") —
      // only the 5-digit ZIP is part of this app's shared StoreLocation
      // contract.
      zip: zipRaw.slice(0, 5),
      latitude: json.primaryLocation?.latitude,
      longitude: json.primaryLocation?.longitude,
      source: 'wholefoodsmarket-api',
      metadata: { storeId: json.storeId, token: json.token },
    },
  };
}

async function loadDirectoryUncached(): Promise<WholeFoodsStore[]> {
  const ids = Array.from({ length: ID_RANGE_END - ID_RANGE_START + 1 }, (_, i) => ID_RANGE_START + i);
  const stores: WholeFoodsStore[] = [];
  for (let i = 0; i < ids.length; i += CRAWL_CONCURRENCY) {
    const batch = ids.slice(i, i + CRAWL_CONCURRENCY);
    const results = await Promise.all(batch.map(fetchStoreSummary));
    for (const r of results) if (r) stores.push(r);
  }
  console.log(`[WholeFoodsLocator] Loaded store directory: ${stores.length} stores.`);
  return stores;
}

async function loadDirectory(): Promise<WholeFoodsStore[]> {
  const cached = directoryCache.get('all');
  if (cached) return cached;

  // Deduped so a racing warm-up and a shopper's first real search don't
  // both fire the same ~1000-request crawl at once.
  return dedupeInFlight('wholefoods-directory', async () => {
    const cachedInner = directoryCache.get('all');
    if (cachedInner) return cachedInner;
    const stores = await loadDirectoryUncached();
    directoryCache.set('all', stores);
    return stores;
  });
}

function cacheKey(zip: string, preciseCoords?: PreciseCoords): string {
  return preciseCoords
    ? `${zip}:${preciseCoords.latitude.toFixed(2)},${preciseCoords.longitude.toFixed(2)}`
    : zip;
}

export function createWholeFoodsLocator(): StoreLocator {
  return {
    async findNearestStore(zip: string, preciseCoords?: PreciseCoords): Promise<StoreLocation | undefined> {
      const store = await dedupeInFlight(`wholefoods-locate:${cacheKey(zip, preciseCoords)}`, () =>
        findNearestStoreUncached(zip, preciseCoords),
      );
      return store?.location;
    },
  };
}

/** Also called directly by wholeFoodsLiveScraper.ts, which needs the
 * numeric storeId (not just the StoreLocation) to bootstrap a search
 * session — see this file's header comment. */
export async function findNearestStoreUncached(zip: string, preciseCoords?: PreciseCoords): Promise<WholeFoodsStore | undefined> {
  const key = cacheKey(zip, preciseCoords);
  const cached = nearestStoreCache.get(key);
  if (cached) return cached;

  const zipGeo = await geocodeZip(zip);
  const userCoords = preciseCoords ?? (zipGeo ? { latitude: zipGeo.latitude, longitude: zipGeo.longitude } : undefined);
  if (!userCoords) {
    console.log(`[WholeFoodsLocator] Could not geocode zip ${zip}.`);
    return undefined;
  }

  const directory = await loadDirectory();
  if (directory.length === 0) {
    console.log('[WholeFoodsLocator] Store directory is empty — crawl may have failed.');
    return undefined;
  }

  let best: { store: WholeFoodsStore; distance: number } | undefined;
  for (const store of directory) {
    const { latitude, longitude } = store.location;
    if (latitude == null || longitude == null) continue;
    const distance = haversineDistanceMiles(userCoords, { latitude, longitude });
    if (!best || distance < best.distance) best = { store, distance };
  }
  if (!best) return undefined;

  nearestStoreCache.set(key, best.store);
  console.log(
    `[WholeFoodsLocator] zip=${zip} -> SELECTED storeId=${best.store.storeId} "${best.store.location.name}" ` +
      `${best.store.location.address}, ${best.store.location.city}, ${best.store.location.state} ${best.store.location.zip} ` +
      `(${best.distance.toFixed(1)} mi)`,
  );
  return best.store;
}

// This locator has no session/token of its own to establish — "ready"
// here means "the store directory crawl has completed at least once,"
// same shape as albertsonsLocator.ts's warmAlbertsonsDirectory /
// tomThumbLocator.ts's warmTomThumbLocator.
export async function warmWholeFoodsLocator(zip?: string): Promise<void> {
  await loadDirectory();
  if (zip) await findNearestStoreUncached(zip);
  markStoreReady('wholefoods');
}
