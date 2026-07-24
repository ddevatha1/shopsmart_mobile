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
 */
const KROGER_API = 'https://api.kroger.com/v1';

export interface KrogerLocationRecord {
  locationId: string;
  name?: string;
  address?: { addressLine1?: string; city?: string; state?: string; zipCode?: string };
  geolocation?: { latitude?: number; longitude?: number };
}

const locationCache = new TtlCache<StoreLocation>(60 * 60 * 1000); // 1 hour

export function toStoreLocation(loc: KrogerLocationRecord): StoreLocation | undefined {
  const address = loc.address?.addressLine1;
  const city = loc.address?.city;
  const state = loc.address?.state;
  const zip = loc.address?.zipCode;
  if (!address || !city || !state || !zip) return undefined;
  return {
    name: loc.name ?? 'Kroger',
    storeId: loc.locationId,
    address,
    city,
    state,
    zip,
    latitude: loc.geolocation?.latitude,
    longitude: loc.geolocation?.longitude,
    source: 'kroger-api',
    metadata: { locationId: loc.locationId },
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

// Cache is keyed by zip alone for a ZIP-centroid lookup, but a precise fix
// can legitimately select a different store than the centroid would for
// the same zip — folding a coarse (~1km) rounding of the coordinates into
// the key keeps that case from being served someone else's cached answer,
// while still caching effectively for repeat searches from about the same
// spot.
function cacheKey(zip: string, preciseCoords?: PreciseCoords): string {
  if (!preciseCoords) return zip;
  return `${zip}:${preciseCoords.latitude.toFixed(2)},${preciseCoords.longitude.toFixed(2)}`;
}

export function createKrogerLocator(getToken: () => Promise<string>): StoreLocator {
  return {
    // Deduped so a racing warm-up and a shopper's first real search for the
    // same zip share one lookup (including the token fetch and every radius
    // attempt below) instead of each firing their own.
    async findNearestStore(zip: string, preciseCoords?: PreciseCoords): Promise<StoreLocation | undefined> {
      return dedupeInFlight(`kroger-locate:${cacheKey(zip, preciseCoords)}`, () =>
        findNearestStoreUncached(zip, getToken, preciseCoords),
      );
    },
  };
}

async function findNearestStoreUncached(
  zip: string,
  getToken: () => Promise<string>,
  preciseCoords?: PreciseCoords,
): Promise<StoreLocation | undefined> {
  const key = cacheKey(zip, preciseCoords);
  const cached = locationCache.get(key);
  if (cached) {
    console.log(`[KrogerLocator] zip=${zip} -> cache hit: ${cached.name} (${cached.city}, ${cached.state})`);
    return cached;
  }

  const token = await getToken();

  // Try progressively wider radii so ZIP codes with no Kroger still find one
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
    url.searchParams.set('filter.limit', '10');

    console.log(`[KrogerLocator] zip=${zip} -> GET ${url.toString()}`);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) {
      console.log(`[KrogerLocator] zip=${zip} radius=${radius}mi -> HTTP ${res.status}, aborting radius escalation.`);
      break;
    }

    const json = await res.json();
    const candidates = (json.data ?? []) as KrogerLocationRecord[];
    console.log(`[KrogerLocator] zip=${zip} radius=${radius}mi -> ${candidates.length} candidate(s) from API.`);
    if (candidates.length > 0) {
      // Walk the ranked list rather than only trying the single nearest —
      // if the closest candidate is missing required address fields (rare,
      // but seen for a handful of locationIds), fall back to the next-
      // nearest candidate at this SAME radius before giving up and
      // escalating to a wider radius, which could otherwise skip over a
      // real, valid, closer store in favor of a farther one.
      const ranked = await rankByDistance(zip, candidates, preciseCoords);
      for (const candidate of ranked) {
        const location = toStoreLocation(candidate);
        if (!location) {
          console.log(
            `[KrogerLocator] zip=${zip} -> candidate locationId=${candidate.locationId} missing required ` +
              `address fields, trying next-nearest candidate at radius=${radius}mi.`,
          );
          continue;
        }
        locationCache.set(key, location);
        console.log(
          `[KrogerLocator] zip=${zip} -> SELECTED locationId=${candidate.locationId} "${location.name}" ` +
            `${location.address}, ${location.city}, ${location.state} ${location.zip} ` +
            `(radius=${radius}mi; reason=closest candidate by haversine distance with a complete address)`,
        );
        return location;
      }
    }
  }

  console.log(`[KrogerLocator] zip=${zip} -> no valid location found after trying radii [15, 30, 50]mi.`);
  return undefined;
}
