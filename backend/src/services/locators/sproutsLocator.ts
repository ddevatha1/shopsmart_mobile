import type { StoreLocation } from '../../types/index.ts';
import { TtlCache } from '../../utils/ttlCache.ts';
import { dedupeInFlight } from '../../utils/dedupeInFlight.ts';
import { withTimeout } from '../../utils/withTimeout.ts';
import type { StoreLocator } from './types.ts';

/**
 * Sprouts runs on the same Instacart-backed ordering platform as Aldi, and
 * exposes the identical "find nearby stores" shape at
 * `shop.sprouts.com/idp/v1/shops?postal_code=` (verified live — same
 * response schema, same session-cookie auth). This replaces the previous
 * approach of letting the site auto-pick a store via Playwright's spoofed
 * browser geolocation, which turned out not to work: Sprouts resolves the
 * active store server-side (from the request's real IP, not the browser's
 * `navigator.geolocation`), so every search was silently landing on
 * whichever store that IP happens to be near — never actually following
 * the shopper's ZIP. Calling this endpoint directly, and passing its
 * result's `id` into the search request explicitly (see
 * sproutsLiveScraper.ts), is what actually makes results ZIP-driven.
 *
 * That endpoint's own address is used for city/state/zip, but for
 * coordinates this prefers a second real, first-party source over
 * geocoding: Sprouts' public corporate-site store-detail API
 * (sprouts.com/wp-json/spr-wp-rest/v1/store/{number}), keyed by the human
 * store number (`location_code`) — retailer-native lat/lng, not an
 * OpenStreetMap estimate, consistent with "prefer retailer data; only
 * geocode when coordinates are genuinely unavailable."
 */
const SPROUTS_SHOPS_URL = 'https://shop.sprouts.com/idp/v1/shops';
const SPROUTS_STORE_DETAIL_URL = 'https://www.sprouts.com/wp-json/spr-wp-rest/v1/store';

interface SproutsShopRecord {
  id: string;
  location_name?: string;
  location_code?: string;
  fulfillment_option?: string;
  address?: {
    street_address?: string;
    city?: string;
    state?: string;
    postal_code?: string;
  };
}
interface SproutsShopsResponse {
  shops?: SproutsShopRecord[];
}
interface SproutsStoreDetailResponse {
  data?: { latitude?: number; longitude?: number };
}

const locationCache = new TtlCache<StoreLocation>(60 * 60 * 1000); // 1 hour

async function fetchPreciseCoords(storeNumber: string): Promise<{ latitude: number; longitude: number } | undefined> {
  try {
    const res = await withTimeout(
      fetch(`${SPROUTS_STORE_DETAIL_URL}/${storeNumber}`, {
        headers: { 'User-Agent': 'ShopSmartMobile/1.0 (grocery price comparison app)' },
      }),
      8000,
      'Sprouts store detail',
    );
    if (!res.ok) return undefined;
    const json = (await res.json()) as SproutsStoreDetailResponse;
    const { latitude, longitude } = json.data ?? {};
    return latitude != null && longitude != null ? { latitude, longitude } : undefined;
  } catch {
    return undefined;
  }
}

/** `getSessionCookie` is injected — this session is also reused by the
 * product search itself (see sproutsLiveScraper.ts), one shared cache. */
export function createSproutsLocator(getSessionCookie: () => Promise<string>): StoreLocator {
  return {
    async findNearestStore(zip: string): Promise<StoreLocation | undefined> {
      const cached = locationCache.get(zip);
      if (cached) return cached;

      // Deduped so a racing warm-up and a shopper's first real search for
      // the same zip share one lookup instead of each firing their own.
      return dedupeInFlight(`sprouts-locate:${zip}`, async () => {
        const cachedInner = locationCache.get(zip);
        if (cachedInner) return cachedInner;

        const cookie = await getSessionCookie();

        const url = new URL(SPROUTS_SHOPS_URL);
        url.searchParams.set('postal_code', zip);
        const res = await fetch(url.toString(), {
          headers: { accept: 'application/json', cookie, 'x-ic-view-layer': 'true' },
        });
        if (!res.ok) {
          console.log(`[SproutsLocator] Shops lookup failed for zip ${zip}: HTTP ${res.status}`);
          return undefined;
        }

        const json = (await res.json()) as SproutsShopsResponse;
        const nearest = json.shops?.find(s => s.fulfillment_option === 'instore');
        const addr = nearest?.address;
        if (!nearest || !addr?.street_address || !addr.city || !addr.state || !addr.postal_code) {
          console.log(`[SproutsLocator] No in-store Sprouts found near zip ${zip}.`);
          return undefined;
        }

        const coords = nearest.location_code ? await fetchPreciseCoords(nearest.location_code) : undefined;

        const location: StoreLocation = {
          name: nearest.location_name?.trim() || `Sprouts - ${addr.city}`,
          storeId: nearest.id,
          address: addr.street_address,
          city: addr.city,
          state: addr.state,
          zip: addr.postal_code,
          latitude: coords?.latitude,
          longitude: coords?.longitude,
        };

        locationCache.set(zip, location);
        console.log(
          `[SproutsLocator] Selected shopId=${nearest.id} storeNumber=${nearest.location_code ?? '?'} "${location.name}" for zip ${zip}`,
        );
        return location;
      });
    },
  };
}
