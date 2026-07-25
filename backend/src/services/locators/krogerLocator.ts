import type { StoreLocation } from '../../types/index.ts';
import { TtlCache } from '../../utils/ttlCache.ts';
import { dedupeInFlight } from '../../utils/dedupeInFlight.ts';
import { geocodeAddress, haversineDistanceMiles } from '../../utils/geocode.ts';
import type { PreciseCoords, StoreLocator } from './types.ts';

/**
 * Kroger's own official Locations API (developer.kroger.com) — a real,
 * retailer-native "find nearby stores" endpoint. It already returns each
 * candidate's real address and coordinates, so no geocoding of candidates
 * is needed (only the shopper's ZIP is geocoded, purely to rank the
 * candidates the API itself returned — never to invent or choose a
 * different store). Requires an OAuth2 token from the same client that
 * calls the Products API, so the token is passed in rather than fetched
 * here — see krogerLiveScraper.ts's getToken().
 *
 * Kroger Co. operates many regional banners (Kroger, Harris Teeter, Ralphs,
 * Fred Meyer, King Soopers, ...) through this exact same API and OAuth
 * client — every location record carries a `chain` code (e.g. `"KROGER"`,
 * `"HART"`) identifying which banner it actually is. Verified live: a
 * Charlotte, NC search (`filter.zipCode.near=28202`) returns *only* `HART`
 * (Harris Teeter) results — `filter.chain=KROGER` for that same zip returns
 * a single non-consumer "Shed" (distribution) record, not a real storefront.
 * Before this file filtered by chain, `findNearestStore` would happily
 * resolve a Charlotte shopper's "Kroger" search to the nearest Harris
 * Teeter store and report it as a Kroger location — a real, live-confirmed
 * mislabeling bug, not a hypothetical one. `filter.chain` is a genuine
 * server-side Locations API parameter (confirmed live, not client-side
 * post-filtering) — every locator instance is now scoped to exactly one
 * banner's `chain` code, so "Kroger" and "Harris Teeter" (and any future
 * banner built the same way) can never cross-resolve into each other.
 */
const KROGER_API = 'https://api.kroger.com/v1';

export interface KrogerLocationRecord {
  locationId: string;
  name?: string;
  chain?: string;
  address?: { addressLine1?: string; city?: string; state?: string; zipCode?: string };
  geolocation?: { latitude?: number; longitude?: number };
}

const locationCache = new TtlCache<StoreLocation>(60 * 60 * 1000); // 1 hour

export function toStoreLocation(loc: KrogerLocationRecord, displayName: string): StoreLocation | undefined {
  const address = loc.address?.addressLine1;
  const city = loc.address?.city;
  const state = loc.address?.state;
  const zip = loc.address?.zipCode;
  if (!address || !city || !state || !zip) return undefined;
  return {
    name: loc.name ?? displayName,
    storeId: loc.locationId,
    address,
    city,
    state,
    zip,
    latitude: loc.geolocation?.latitude,
    longitude: loc.geolocation?.longitude,
    source: 'kroger-api',
    metadata: { locationId: loc.locationId, chain: loc.chain },
  };
}

// Ranks every candidate by actual great-circle distance to the shopper's
// ZIP code, rather than trusting whatever order the Locations API returns
// them in — the API's own sort order is not documented/guaranteed. Returns
// the full ranked list (not just the top pick) so the caller can fall back
// to the next-nearest candidate if the nearest one turns out to be missing
// required address fields, instead of abandoning the whole radius tier.
// Pure sort step, split out from rankByDistance so it's testable without a
// real geocode call — candidates missing coordinates sort last (Infinity)
// rather than being dropped, matching rankByDistance's behavior.
export function sortByDistanceFrom(
  userCoords: { latitude: number; longitude: number },
  candidates: KrogerLocationRecord[],
): KrogerLocationRecord[] {
  return candidates
    .map(loc => {
      const lat = loc.geolocation?.latitude;
      const lng = loc.geolocation?.longitude;
      const distanceMiles =
        lat != null && lng != null
          ? haversineDistanceMiles(userCoords, { latitude: lat, longitude: lng })
          : Infinity;
      return { loc, distanceMiles };
    })
    .sort((a, b) => a.distanceMiles - b.distanceMiles)
    .map(r => r.loc);
}

async function rankByDistance(
  zip: string,
  candidates: KrogerLocationRecord[],
  preciseCoords?: PreciseCoords,
): Promise<KrogerLocationRecord[]> {
  // Prefer the shopper's real GPS fix over the ZIP's geocoded centroid —
  // the centroid can genuinely be closer to a different real store than
  // where the shopper actually is (verified live for zip 75034: two real
  // Frisco, TX Krogers, and the nearer-to-centroid one isn't always the
  // nearer-to-shopper one). Falls back to geocoding the ZIP when no
  // precise fix is available (no permission granted, or a web client).
  const userCoords = preciseCoords ?? (await geocodeAddress(`${zip}, USA`));
  if (!userCoords) {
    console.log(`[KrogerLocator] Could not geocode ZIP ${zip} — using API's original order as a fallback.`);
    return candidates;
  }
  console.log(
    `[KrogerLocator] zip=${zip} -> ranking from ${preciseCoords ? 'precise GPS' : 'geocoded ZIP centroid'} ` +
      `(${userCoords.latitude}, ${userCoords.longitude})`,
  );
  const ranked = sortByDistanceFrom(userCoords, candidates);
  console.log(
    `[KrogerLocator] Candidates near ${zip}, ranked by distance:\n` +
      ranked.map(loc => `  ${loc.locationId} ${loc.name ?? ''} (${loc.address?.city}, ${loc.address?.state})`).join('\n'),
  );
  return ranked;
}

// Cache is keyed by zip *and chain* — a precise fix can legitimately select
// a different store than the centroid would for the same zip (folded in via
// a coarse ~1km rounding), and two locator instances for different banners
// (e.g. Kroger vs. Harris Teeter) must never share a cache slot for the same
// zip, or one banner's resolved store would silently leak into the other's
// results.
function cacheKey(zip: string, chain: string, preciseCoords?: PreciseCoords): string {
  const base = preciseCoords
    ? `${zip}:${preciseCoords.latitude.toFixed(2)},${preciseCoords.longitude.toFixed(2)}`
    : zip;
  return `${chain}:${base}`;
}

/** `chain` scopes this locator to exactly one Kroger Co. banner's location
 * records (e.g. `"KROGER"`, `"HART"` for Harris Teeter) — see this file's
 * header comment for why that's required, not optional. `displayName` is
 * the human-readable store name used when a location record has no `name`
 * of its own. */
export function createKrogerLocator(getToken: () => Promise<string>, chain: string, displayName: string): StoreLocator {
  return {
    // Deduped so a racing warm-up and a shopper's first real search for the
    // same zip share one lookup (including the token fetch and every radius
    // attempt below) instead of each firing their own.
    async findNearestStore(zip: string, preciseCoords?: PreciseCoords): Promise<StoreLocation | undefined> {
      return dedupeInFlight(`kroger-locate:${cacheKey(zip, chain, preciseCoords)}`, () =>
        findNearestStoreUncached(zip, chain, displayName, getToken, preciseCoords),
      );
    },
  };
}

async function findNearestStoreUncached(
  zip: string,
  chain: string,
  displayName: string,
  getToken: () => Promise<string>,
  preciseCoords?: PreciseCoords,
): Promise<StoreLocation | undefined> {
  const key = cacheKey(zip, chain, preciseCoords);
  const cached = locationCache.get(key);
  if (cached) {
    console.log(`[KrogerLocator][${chain}] zip=${zip} -> cache hit: ${cached.name} (${cached.city}, ${cached.state})`);
    return cached;
  }

  const token = await getToken();

  // Try progressively wider radii so ZIP codes with no location for this
  // banner still find one.
  for (const radius of [15, 30, 50]) {
    const url = new URL(`${KROGER_API}/locations`);
    // IMPORTANT: the filter key is `filter.zipCode.near` — NOT
    // `filter.zipCode` (an easy, silent-failure mistake: Kroger's API
    // returns 200 OK either way, but `filter.zipCode` alone is either
    // unrecognized or an exact-match filter with no results, so the
    // API falls back to an arbitrary default page of locations from
    // an unrelated region — e.g. Georgia/South Carolina stores for a
    // Texas ZIP — with no error to indicate anything went wrong. This
    // was root-caused by directly A/B-testing both parameter names
    // against the live API for zip=75035: `filter.zipCode=75035`
    // returned Irmo/Columbia/Myrtle Beach, SC stores; `filter.zipCode.
    // near=75035` returned the real, correct Frisco/Plano/Allen, TX
    // stores. Never regress this back to the bare `filter.zipCode`.
    url.searchParams.set('filter.zipCode.near', zip);
    url.searchParams.set('filter.radiusInMiles', String(radius));
    // Verified live: `filter.chain` is a genuine server-side Locations API
    // parameter (not a client-side filter here) — scoping every request to
    // one banner's chain code is what keeps "Kroger" and "Harris Teeter"
    // (and any future banner) from ever resolving into each other's stores.
    url.searchParams.set('filter.chain', chain);
    url.searchParams.set('filter.limit', '10');

    console.log(`[KrogerLocator][${chain}] zip=${zip} -> GET ${url.toString()}`);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) {
      console.log(`[KrogerLocator][${chain}] zip=${zip} radius=${radius}mi -> HTTP ${res.status}, aborting radius escalation.`);
      break;
    }

    const json = await res.json();
    const candidates = (json.data ?? []) as KrogerLocationRecord[];
    console.log(`[KrogerLocator][${chain}] zip=${zip} radius=${radius}mi -> ${candidates.length} candidate(s) from API.`);
    if (candidates.length > 0) {
      // Walk the ranked list rather than only trying the single nearest —
      // if the closest candidate is missing required address fields (rare,
      // but seen for a handful of locationIds), fall back to the next-
      // nearest candidate at this SAME radius before giving up and
      // escalating to a wider radius, which could otherwise skip over a
      // real, valid, closer store in favor of a farther one.
      const ranked = await rankByDistance(zip, candidates, preciseCoords);
      for (const candidate of ranked) {
        const location = toStoreLocation(candidate, displayName);
        if (!location) {
          console.log(
            `[KrogerLocator][${chain}] zip=${zip} -> candidate locationId=${candidate.locationId} missing required ` +
              `address fields, trying next-nearest candidate at radius=${radius}mi.`,
          );
          continue;
        }
        locationCache.set(key, location);
        console.log(
          `[KrogerLocator][${chain}] zip=${zip} -> SELECTED locationId=${candidate.locationId} "${location.name}" ` +
            `${location.address}, ${location.city}, ${location.state} ${location.zip} ` +
            `(radius=${radius}mi; reason=closest candidate by haversine distance with a complete address)`,
        );
        return location;
      }
    }
  }

  console.log(`[KrogerLocator][${chain}] zip=${zip} -> no valid location found after trying radii [15, 30, 50]mi.`);
  return undefined;
}
