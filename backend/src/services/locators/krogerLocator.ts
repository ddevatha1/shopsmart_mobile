import type { StoreLocation } from '../../types/index.ts';
import { TtlCache } from '../../utils/ttlCache.ts';
import { dedupeInFlight } from '../../utils/dedupeInFlight.ts';
import { geocodeAddress, haversineDistanceMiles } from '../../utils/geocode.ts';
import type { StoreLocator } from './types.ts';

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

interface KrogerLocationRecord {
  locationId: string;
  name?: string;
  address?: { addressLine1?: string; city?: string; state?: string; zipCode?: string };
  geolocation?: { latitude?: number; longitude?: number };
}

const locationCache = new TtlCache<StoreLocation>(60 * 60 * 1000); // 1 hour

function toStoreLocation(loc: KrogerLocationRecord): StoreLocation | undefined {
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
  };
}

// Picks the closest candidate by actual great-circle distance to the
// shopper's ZIP code, rather than trusting whatever order the Locations API
// returns them in — the API's own sort order is not documented/guaranteed.
async function pickNearest(zip: string, candidates: KrogerLocationRecord[]): Promise<KrogerLocationRecord> {
  const userCoords = await geocodeAddress(`${zip}, USA`);
  if (!userCoords) {
    console.log(`[KrogerLocator] Could not geocode ZIP ${zip} — using API's first result as a fallback.`);
    return candidates[0];
  }
  console.log(`[KrogerLocator] zip=${zip} -> geocoded to (${userCoords.latitude}, ${userCoords.longitude})`);

  const ranked = candidates
    .map(loc => {
      const lat = loc.geolocation?.latitude;
      const lng = loc.geolocation?.longitude;
      const distanceMiles =
        lat != null && lng != null
          ? haversineDistanceMiles(userCoords, { latitude: lat, longitude: lng })
          : Infinity;
      return { loc, distanceMiles };
    })
    .sort((a, b) => a.distanceMiles - b.distanceMiles);

  console.log(
    `[KrogerLocator] Candidates near ${zip}, ranked by distance:\n` +
      ranked
        .map(
          r =>
            `  ${r.distanceMiles === Infinity ? '?' : r.distanceMiles.toFixed(1)}mi — ` +
            `${r.loc.locationId} ${r.loc.name ?? ''} (${r.loc.address?.city}, ${r.loc.address?.state})`,
        )
        .join('\n'),
  );

  return ranked[0].loc;
}

export function createKrogerLocator(getToken: () => Promise<string>): StoreLocator {
  return {
    // Deduped so a racing warm-up and a shopper's first real search for the
    // same zip share one lookup (including the token fetch and every radius
    // attempt below) instead of each firing their own.
    async findNearestStore(zip: string): Promise<StoreLocation | undefined> {
      return dedupeInFlight(`kroger-locate:${zip}`, () => findNearestStoreUncached(zip, getToken));
    },
  };
}

async function findNearestStoreUncached(
  zip: string,
  getToken: () => Promise<string>,
): Promise<StoreLocation | undefined> {
  const cached = locationCache.get(zip);
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
      const nearest = await pickNearest(zip, candidates);
      const location = toStoreLocation(nearest);
      if (location) {
        locationCache.set(zip, location);
        console.log(
          `[KrogerLocator] zip=${zip} -> SELECTED locationId=${nearest.locationId} "${location.name}" ` +
            `${location.address}, ${location.city}, ${location.state} ${location.zip} ` +
            `(radius=${radius}mi; reason=closest candidate by haversine distance)`,
        );
        return location;
      }
    }
  }

  console.log(`[KrogerLocator] zip=${zip} -> no valid location found after trying radii [15, 30, 50]mi.`);
  return undefined;
}
