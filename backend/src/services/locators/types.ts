import type { StoreLocation } from '../../types/index.ts';

/** The shopper's real GPS fix, when the app has permission and one is
 * available — passed through from the frontend so store selection can rank
 * by the shopper's actual position instead of only their ZIP's geocoded
 * centroid, which can be a mile or more off from where they actually are
 * (verified live: for zip 75034, the geocoded centroid sits closer to one
 * real Frisco, TX Kroger than another — a shopper standing nearer the
 * *other* real store would still get routed to the centroid-nearest one
 * without this). Optional and best-effort: a locator that can't use it
 * (Aldi/Sprouts resolve their single candidate server-side, keyed only by
 * postal code) is free to ignore it. */
export interface PreciseCoords {
  latitude: number;
  longitude: number;
}

/**
 * Shared contract every retailer's store-selection logic implements, so
 * each scraper resolves "which physical store" the exact same way: given a
 * shopper's ZIP (and, when available, their precise coordinates), return
 * the nearest store this retailer's own infrastructure reports (never an
 * OpenStreetMap POI standing in for the retailer) — or `undefined` if that
 * retailer's public APIs genuinely can't resolve one for this ZIP. The
 * returned `StoreLocation.storeId` is what the calling scraper feeds back
 * into its product-search request, so the store that data comes from and
 * the store whose address is shown are always the same.
 */
export interface StoreLocator {
  findNearestStore(zip: string, preciseCoords?: PreciseCoords): Promise<StoreLocation | undefined>;
}
