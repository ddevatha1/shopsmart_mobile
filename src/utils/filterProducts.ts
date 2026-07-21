import type { ApiProduct } from '../models/types';

/**
 * True if the product is organic. Prefers the store-provided certification
 * list when a scraper populates one (none do consistently as of this
 * writing, so this branch is forward-compatible rather than load-bearing
 * today); otherwise falls back to a whole-word "organic" match on the
 * product name, which is how organic status actually appears in every
 * store's product titles right now (e.g. "Organic Avocado").
 */
export function isOrganicProduct(product: ApiProduct): boolean {
  if (product.certifications?.some((c) => c.toLowerCase() === 'organic')) return true;
  return /\borganic\b/i.test(product.name);
}
