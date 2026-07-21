import type { ApiProduct } from '../models/types';
import { normalizeProductName } from './priceHistoryService';
import { isOrganicProduct } from '../utils/filterProducts';
import type { PersonalizationProfile } from './personalizationService';

/**
 * Finds a genuinely better alternative for `product` from among the
 * *other results in the same search response* — never a separate lookup,
 * never invented. A shopper searching "milk" already gets every store's
 * version of it back in one response; this just notices when one of the
 * others is a meaningfully better pick than the one being viewed.
 *
 * Returns null whenever the viewed product is already a good choice
 * (cheapest, or no organic counterpart worth mentioning) — per "do not
 * show substitution suggestions when the searched product is already a
 * good choice."
 *
 * `profile` (from personalizationService, optional) is the one place this
 * app's real, silently-learned shopping history changes what gets
 * suggested: a shopper whose own purchase history is mostly organic sees
 * the organic alternative checked first and gets a wider "worth it" price
 * allowance for it, instead of the default price-first ordering.
 */
export interface Substitution {
  product: ApiProduct;
  reason: string;
}

const MEANINGFUL_SAVINGS_PERCENT = 0.15;
const MEANINGFUL_SAVINGS_MIN_DOLLARS = 0.5;
const ORGANIC_AFFINITY_THRESHOLD = 0.5;
const DEFAULT_ORGANIC_PREMIUM = 1.25; // willing to pay up to 25% more
const HIGH_AFFINITY_ORGANIC_PREMIUM = 1.4; // up to 40% more once their own history shows they usually buy organic anyway

function findCheaperAlternative(product: ApiProduct, candidates: ApiProduct[]): Substitution | null {
  const cheapest = candidates.reduce((best, c) => (c.price < best.price ? c : best), candidates[0]);
  const savings = product.price - cheapest.price;
  if (savings >= MEANINGFUL_SAVINGS_MIN_DOLLARS && savings / product.price >= MEANINGFUL_SAVINGS_PERCENT) {
    return { product: cheapest, reason: `Save $${savings.toFixed(2)} at ${cheapest.store}` };
  }
  return null;
}

function findOrganicAlternative(product: ApiProduct, candidates: ApiProduct[], premiumAllowed: number): Substitution | null {
  if (isOrganicProduct(product)) return null;
  const organicAlt = candidates
    .filter((c) => isOrganicProduct(c) && c.price <= product.price * premiumAllowed)
    .sort((a, b) => a.price - b.price)[0];
  if (!organicAlt) return null;
  return {
    product: organicAlt,
    reason: organicAlt.price <= product.price
      ? `Organic version available at ${organicAlt.store} for the same price or less`
      : `Organic version available at ${organicAlt.store} for $${(organicAlt.price - product.price).toFixed(2)} more`,
  };
}

export function findSubstitution(
  product: ApiProduct,
  sameSearchResults: ApiProduct[],
  profile?: PersonalizationProfile,
): Substitution | null {
  const targetKey = normalizeProductName(product.name);
  const candidates = sameSearchResults.filter(
    (p) => p.id !== product.id && normalizeProductName(p.name) === targetKey,
  );
  if (candidates.length === 0) return null;

  const prefersOrganic = (profile?.organicAffinity ?? 0) >= ORGANIC_AFFINITY_THRESHOLD;
  const organicPremium = prefersOrganic ? HIGH_AFFINITY_ORGANIC_PREMIUM : DEFAULT_ORGANIC_PREMIUM;

  if (prefersOrganic) {
    return findOrganicAlternative(product, candidates, organicPremium) ?? findCheaperAlternative(product, candidates);
  }
  return findCheaperAlternative(product, candidates) ?? findOrganicAlternative(product, candidates, organicPremium);
}
