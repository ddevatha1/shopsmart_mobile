import type { StoreLocation } from '../../types/index.ts';

/**
 * Shared contract every retailer's store-selection logic implements, so
 * each scraper resolves "which physical store" the exact same way: given a
 * shopper's ZIP, return the nearest store this retailer's own infrastructure
 * reports (never an OpenStreetMap POI standing in for the retailer) — or
 * `undefined` if that retailer's public APIs genuinely can't resolve one for
 * this ZIP. The returned `StoreLocation.storeId` is what the calling
 * scraper feeds back into its product-search request, so the store that
 * data comes from and the store whose address is shown are always the same.
 */
export interface StoreLocator {
  findNearestStore(zip: string): Promise<StoreLocation | undefined>;
}
