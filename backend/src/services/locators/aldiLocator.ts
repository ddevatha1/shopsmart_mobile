import type { StoreLocation } from '../../types/index.ts';
import { TtlCache } from '../../utils/ttlCache.ts';
import { geocodeAddress } from '../../utils/geocode.ts';
import type { StoreLocator } from './types.ts';

/**
 * Aldi's own ordering platform (Instacart-backed) exposes a real
 * "find nearby stores" endpoint at `www.aldi.us/idp/v1/shops?postal_code=`
 * — the same one aldi.us's own storefront calls to power its store picker.
 * It returns real candidate stores *already sorted nearest-first* (verified
 * live: querying a Frisco, TX ZIP returns Frisco, then McKinney, then
 * progressively farther DFW-metro suburbs) — retailer-native distance
 * ranking, not something this app computes. This app trusts that order
 * for *selection*; OpenStreetMap is only used afterward to geocode the
 * selected store's address, since this endpoint doesn't return lat/lng.
 *
 * Each physical store address can appear multiple times in the results
 * with different `fulfillment_option`s (delivery/pickup/instore) — each is
 * a distinct `shopId` even though they share an address. "instore" is what
 * this app's product search actually needs (in-store shelf prices, not
 * delivery/pickup markup), so that's the fulfillment type selected.
 */
const ALDI_SHOPS_URL = 'https://www.aldi.us/idp/v1/shops';

interface AldiShopRecord {
  id: string;
  location_name?: string;
  fulfillment_option?: string;
  address?: {
    street_address?: string;
    city?: string;
    state?: string;
    postal_code?: string;
  };
}
interface AldiShopsResponse {
  shops?: AldiShopRecord[];
}

const locationCache = new TtlCache<StoreLocation>(60 * 60 * 1000); // 1 hour

/** `getSessionCookie` is injected rather than established here — Aldi's
 * anonymous session cookie is also needed for the GraphQL product search
 * itself (see aldiLiveScraper.ts), so both share one cached session
 * instead of each independently re-authenticating. */
export function createAldiLocator(getSessionCookie: () => Promise<string>): StoreLocator {
  return {
    async findNearestStore(zip: string): Promise<StoreLocation | undefined> {
      const cached = locationCache.get(zip);
      if (cached) return cached;

      const cookie = await getSessionCookie();

      const url = new URL(ALDI_SHOPS_URL);
      url.searchParams.set('postal_code', zip);
      const res = await fetch(url.toString(), {
        headers: { accept: 'application/json', cookie, 'x-ic-view-layer': 'true' },
      });
      if (!res.ok) {
        console.log(`[AldiLocator] Shops lookup failed for zip ${zip}: HTTP ${res.status}`);
        return undefined;
      }

      const json = (await res.json()) as AldiShopsResponse;
      const nearest = json.shops?.find(s => s.fulfillment_option === 'instore');
      const addr = nearest?.address;
      if (!nearest || !addr?.street_address || !addr.city || !addr.state || !addr.postal_code) {
        console.log(`[AldiLocator] No in-store Aldi found near zip ${zip}.`);
        return undefined;
      }

      const coords = await geocodeAddress(`${addr.street_address}, ${addr.city}, ${addr.state} ${addr.postal_code}`);
      const location: StoreLocation = {
        name: nearest.location_name?.trim() || `Aldi - ${addr.city}`,
        storeId: nearest.id,
        address: addr.street_address,
        city: addr.city,
        state: addr.state,
        zip: addr.postal_code,
        latitude: coords?.latitude,
        longitude: coords?.longitude,
      };

      locationCache.set(zip, location);
      console.log(`[AldiLocator] Selected shopId=${nearest.id} "${location.name}" for zip ${zip}`);
      return location;
    },
  };
}
