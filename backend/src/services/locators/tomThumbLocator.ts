import type { StoreLocation } from '../../types/index.ts';
import { TtlCache } from '../../utils/ttlCache.ts';
import { dedupeInFlight } from '../../utils/dedupeInFlight.ts';
import { withTimeout } from '../../utils/withTimeout.ts';
import { haversineDistanceMiles } from '../../utils/geocode.ts';
import { extractBalancedJson } from './albertsonsLocator.ts';
import { markStoreReady } from '../storeReadiness.ts';
import type { PreciseCoords, StoreLocator } from './types.ts';

/**
 * Tom Thumb is an Albertsons Companies banner (Southern division, Dallas-
 * Fort Worth) — but unlike albertsonsLocator.ts's directory-crawl approach
 * (Albertsons itself has no live "nearest store" API), Tom Thumb's own site
 * exposes a real, live, unauthenticated store-resolver endpoint. Confirmed
 * live by watching tomthumb.com's own "Find a Store" widget's network
 * traffic while entering a real ZIP (75035):
 *
 *   GET https://www.tomthumb.com/abs/pub/xapi/storeresolver/v2/all
 *       ?zipcode={zip}&size=10&radius=50&excludeBanners=none&includeNonMigratedStores=true
 *
 * An Azure API Management-fronted endpoint: calling it with no header at
 * all returns a 401 "missing subscription key," but it accepts the exact
 * same `ocp-apim-subscription-key` value the real site embeds, server-
 * rendered, in its own homepage HTML (`"wcax.xapi.apim.key"`, inside a
 * Next.js RSC payload — confirmed live by fetching the plain homepage HTML
 * and finding it in cleartext). Like Aldi's persisted-query hash or
 * Kroger's `chain` code, this is an API *contract* identifier baked into
 * every visitor's page load, not a login credential or per-user secret —
 * reaching it involves no account, cookie, or session. It IS a value the
 * real site could rotate on a future deploy, which would break this
 * locator until re-extracted from the homepage the same way — a real,
 * documented fragility, not a hidden one.
 *
 * The response bundles every Albertsons-family banner near that zip in one
 * call (`instore`/`delivery`/`pickup` sections, each a flat list already
 * sorted ascending by real `distance` in miles — confirmed live, not
 * assumed) — `polarisBannerName === 'tomthumb'` is what scopes this locator
 * to real Tom Thumb stores only, never a same-zip Albertsons/Market Street/
 * Randalls result from the same banner family (same filtering rationale as
 * krogerLocator.ts's `chain` scoping for Kroger vs. Harris Teeter).
 *
 * The store-resolver response carries a real address but NO lat/lng.
 * Coordinates come from a second real, public, unauthenticated source:
 * `local.tomthumb.com` (a Yext-powered store-locator site — the exact same
 * platform and JSON shape as `local.albertsons.com`, see
 * albertsonsLocator.ts's header comment; `extractBalancedJson` is reused
 * from there rather than re-implemented). robots.txt for local.tomthumb.com
 * disallows only the interactive `/locator` path — store detail pages and
 * the sitemap are unrestricted.
 *
 * Product SEARCH is a different story entirely — see
 * tomThumbLiveScraper.ts's header comment for why that stays unimplemented.
 */
const STORE_RESOLVER_URL = 'https://www.tomthumb.com/abs/pub/xapi/storeresolver/v2/all';
// See this file's header comment above — a public API-contract identifier
// embedded in every visitor's page load, not a secret credential.
const SUBSCRIPTION_KEY = '7bad9afbb87043b28519c4443106db06';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

// Only ever consulted for candidates already filtered to
// polarisBannerName === 'tomthumb' — re-ranking more than a handful of
// same-zip candidates by real GPS distance isn't worth an extra fetch each,
// same bounding rationale as traderJoesLocator.ts's MAX_FALLBACK_CANDIDATES.
const MAX_RERANK_CANDIDATES = 3;

interface StoreResolverAddress {
  line1?: string;
  city?: string;
  state?: string;
  zipcode?: string;
}
export interface StoreResolverStore {
  locationId?: string;
  distance?: number;
  polarisBannerName?: string;
  domainName?: string;
  address?: StoreResolverAddress;
  localPage?: string;
}
interface StoreResolverSection {
  stores?: StoreResolverStore[];
}
interface StoreResolverResponse {
  instore?: StoreResolverSection;
}

const locationCache = new TtlCache<StoreLocation>(60 * 60 * 1000); // 1 hour
// Keyed by localPage URL — a store's real-world coordinates never move, so
// this is cached far longer than the resolved-location cache above (which
// expires purely to pick up new distance-ranked candidates over time).
const coordsCache = new TtlCache<{ latitude: number; longitude: number } | null>(24 * 60 * 60 * 1000);

async function fetchCoordsFromLocalPage(localPage: string): Promise<{ latitude: number; longitude: number } | undefined> {
  const cached = coordsCache.get(localPage);
  if (cached !== undefined) return cached ?? undefined;

  let coords: { latitude: number; longitude: number } | null = null;
  try {
    const res = await withTimeout(
      fetch(localPage, { headers: { 'User-Agent': USER_AGENT } }),
      8000,
      'Tom Thumb store detail',
    );
    const html = await res.text();
    const json = extractBalancedJson(html, 'Yext.Profile');
    if (json) {
      const profile = JSON.parse(json) as { geocodedCoordinate?: { lat?: number; long?: number } };
      const { lat, long } = profile.geocodedCoordinate ?? {};
      if (typeof lat === 'number' && typeof long === 'number') coords = { latitude: lat, longitude: long };
    }
  } catch (err) {
    console.warn(`[TomThumbLocator] store detail lookup failed for ${localPage}:`, err);
  }

  coordsCache.set(localPage, coords);
  return coords ?? undefined;
}

// Scopes a mixed-banner storeresolver response (Tom Thumb, Albertsons,
// Market Street, ... all bundled in one call — see this file's header
// comment) to real Tom Thumb stores only. Pure/no network — split out from
// findNearestStoreUncached so it's directly testable against a captured
// fixture without mocking fetch.
export function filterTomThumbCandidates(stores: StoreResolverStore[]): StoreResolverStore[] {
  return stores.filter(s => s.polarisBannerName === 'tomthumb');
}

export function toStoreLocation(store: StoreResolverStore, coords?: { latitude: number; longitude: number }): StoreLocation | undefined {
  const address = store.address?.line1;
  const city = store.address?.city;
  const state = store.address?.state;
  const zip = store.address?.zipcode;
  if (!address || !city || !state || !zip || !store.locationId) return undefined;
  return {
    name: `Tom Thumb - ${city}`,
    storeId: store.locationId,
    address,
    city,
    state,
    zip,
    latitude: coords?.latitude,
    longitude: coords?.longitude,
    source: 'tomthumb-storeresolver',
    metadata: { locationId: store.locationId, distanceMiles: store.distance },
  };
}

function cacheKey(zip: string, preciseCoords?: PreciseCoords): string {
  return preciseCoords
    ? `${zip}:${preciseCoords.latitude.toFixed(2)},${preciseCoords.longitude.toFixed(2)}`
    : zip;
}

export function createTomThumbLocator(): StoreLocator {
  return {
    // Deduped so a racing warm-up and a shopper's first real search for the
    // same zip share one resolution instead of each firing their own.
    async findNearestStore(zip: string, preciseCoords?: PreciseCoords): Promise<StoreLocation | undefined> {
      return dedupeInFlight(`tomthumb-locate:${cacheKey(zip, preciseCoords)}`, () =>
        findNearestStoreUncached(zip, preciseCoords),
      );
    },
  };
}

export async function findNearestStoreUncached(zip: string, preciseCoords?: PreciseCoords): Promise<StoreLocation | undefined> {
  const key = cacheKey(zip, preciseCoords);
  const cached = locationCache.get(key);
  if (cached) return cached;

  const url = new URL(STORE_RESOLVER_URL);
  url.searchParams.set('zipcode', zip);
  url.searchParams.set('size', '10');
  url.searchParams.set('radius', '50');
  url.searchParams.set('excludeBanners', 'none');
  url.searchParams.set('includeNonMigratedStores', 'true');

  let json: StoreResolverResponse;
  try {
    const res = await withTimeout(
      fetch(url.toString(), {
        headers: { 'User-Agent': USER_AGENT, 'ocp-apim-subscription-key': SUBSCRIPTION_KEY },
      }),
      8000,
      'Tom Thumb store resolver',
    );
    // The real site's own widget gets a 206 (Partial Content) on success —
    // confirmed live, not a bug — so `res.ok` (2xx) is checked rather than
    // strictly requiring 200.
    if (!res.ok) {
      console.log(`[TomThumbLocator] zip=${zip} -> HTTP ${res.status} from store resolver.`);
      return undefined;
    }
    json = (await res.json()) as StoreResolverResponse;
  } catch (err) {
    console.warn(`[TomThumbLocator] zip=${zip} -> store resolver request failed:`, err);
    return undefined;
  }

  const candidates = filterTomThumbCandidates(json.instore?.stores ?? []);
  if (candidates.length === 0) {
    console.log(`[TomThumbLocator] zip=${zip} -> no Tom Thumb stores in range.`);
    return undefined;
  }

  // Candidates already arrive sorted ascending by real distance from the
  // zip (confirmed live). When a precise GPS fix is available, re-rank just
  // the closest few by real distance from THAT point instead — the zip
  // centroid the API ranked from can genuinely be closer to a different
  // real store than where the shopper actually is (same rationale as
  // krogerLocator.ts's own preciseCoords re-ranking).
  let ordered = candidates;
  if (preciseCoords) {
    const toRerank = candidates.slice(0, MAX_RERANK_CANDIDATES);
    const rest = candidates.slice(MAX_RERANK_CANDIDATES);
    const withDistance = await Promise.all(
      toRerank.map(async store => {
        const coords = store.localPage ? await fetchCoordsFromLocalPage(store.localPage) : undefined;
        const distanceMiles = coords ? haversineDistanceMiles(preciseCoords, coords) : Infinity;
        return { store, distanceMiles };
      }),
    );
    withDistance.sort((a, b) => a.distanceMiles - b.distanceMiles);
    ordered = [...withDistance.map(r => r.store), ...rest];
  }

  for (const store of ordered) {
    const coords = store.localPage ? await fetchCoordsFromLocalPage(store.localPage) : undefined;
    const location = toStoreLocation(store, coords);
    if (!location) {
      console.log(`[TomThumbLocator] zip=${zip} -> candidate locationId=${store.locationId} missing required fields, trying next.`);
      continue;
    }
    locationCache.set(key, location);
    console.log(
      `[TomThumbLocator] zip=${zip} -> SELECTED locationId=${store.locationId} "${location.name}" ` +
        `${location.address}, ${location.city}, ${location.state} ${location.zip} (${store.distance} mi from zip)`,
    );
    return location;
  }

  console.log(`[TomThumbLocator] zip=${zip} -> no Tom Thumb candidate had a complete address.`);
  return undefined;
}

// This locator has no session/token to establish (every call re-sends the
// same static subscription key — see this file's header comment), so
// "ready" here just means "we've confirmed the store resolver is
// reachable," same as albertsonsLocator.ts's warmAlbertsonsDirectory. Named
// distinctly from tomThumbLiveScraper.ts's own (unused, interface-
// completeness-only) `warmTomThumb` — this is the one warmupService.ts
// actually calls.
export async function warmTomThumbLocator(zip?: string): Promise<void> {
  if (zip) await findNearestStoreUncached(zip);
  markStoreReady('tomthumb');
}
