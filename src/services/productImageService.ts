import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiClient } from './apiClient';

/**
 * On-device cache in front of apiClient.resolveProductImage — for when a
 * store didn't provide an `image_url`, or the one it gave us fails to
 * load. The actual lookup (Open Food Facts, with same-product
 * verification) runs server-side; see
 * backend/src/routes/productImage.ts. Caching here means a product this
 * device has already resolved once never triggers a second request to our
 * own backend, on top of the backend's own cross-user cache.
 */

const CACHE_KEY_PREFIX = 'shopsmart_image_cache_';
// Cached when a lookup legitimately found nothing, so we don't keep
// re-querying a product that has no good match.
const NO_MATCH_SENTINEL = '__no_match__';

function cacheKey(productName: string): string {
  return `${CACHE_KEY_PREFIX}${productName.trim().toLowerCase()}`;
}

/**
 * Resolves a representative photo URL for a product name, checking the
 * on-device cache first. Returns null (and caches that too) when no good
 * match exists — the caller should fall back to the category placeholder
 * icon in that case. Never throws.
 *
 * `store`/`storeProductUrl`, when known, let the backend attempt an exact
 * same-site product-page scrape (see backend/src/routes/productImage.ts)
 * before falling back to a fuzzy Open Food Facts search.
 */
export async function resolveProductImage(
  productName: string,
  store?: string,
  storeProductUrl?: string,
): Promise<string | null> {
  const key = cacheKey(productName);

  const cached = await AsyncStorage.getItem(key);
  if (cached === NO_MATCH_SENTINEL) return null;
  if (cached) return cached;

  const imageUrl = await apiClient.resolveProductImage(productName, store, storeProductUrl);
  await AsyncStorage.setItem(key, imageUrl ?? NO_MATCH_SENTINEL);
  return imageUrl;
}
