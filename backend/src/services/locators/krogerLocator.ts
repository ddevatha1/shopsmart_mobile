import type { StoreLocation } from '../../types/index.ts';
import { TtlCache } from '../../utils/ttlCache.ts';
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
    async findNearestStore(zip: string): Promise<StoreLocation | undefined> {
      const cached = locationCache.get(zip);
      if (cached) return cached;

      const token = await getToken();

      // Try progressively wider radii so ZIP codes with no Kroger still find one
      for (const radius of [15, 30, 50]) {
        const url = new URL(`${KROGER_API}/locations`);
        url.searchParams.set('filter.zipCode', zip);
        url.searchParams.set('filter.radiusInMiles', String(radius));
        url.searchParams.set('filter.limit', '10');

        const res = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          cache: 'no-store',
        });
        if (!res.ok) break;

        const json = await res.json();
        const candidates = (json.data ?? []) as KrogerLocationRecord[];
        if (candidates.length > 0) {
          const nearest = await pickNearest(zip, candidates);
          const location = toStoreLocation(nearest);
          if (location) {
            locationCache.set(zip, location);
            console.log(`[KrogerLocator] Selected locationId=${nearest.locationId} (radius=${radius}mi, zip=${zip})`);
            return location;
          }
        }
      }

      return undefined;
    },
  };
}
