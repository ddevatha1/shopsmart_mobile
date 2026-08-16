/**
 * Canonical Product Intelligence — the foundation for cross-store product
 * equivalence (and, later, nutrition-aware optimization) that Healthiest
 * mode will eventually consume. Deliberately small: a deterministic,
 * synchronous function that derives a stable `canonicalId` from a
 * product's own name/size, reusing this backend's existing relevance-
 * matching vocabulary (searchService.ts's `FILLER_WORDS`,
 * `isUnitOrPackagingWord`, `singularize`) rather than duplicating it.
 *
 * No database, no cache, no network, no AI. "Cache-friendly" here means
 * the function is pure and deterministic — identical `(name, size)`
 * input always produces the identical `canonicalId` output, which is
 * what would make a future cache (or a real database keyed by
 * `canonicalId`) a pure performance optimization layered on top, never a
 * correctness requirement. That migration is intentionally not built yet
 * — this sprint only establishes the shape.
 *
 * What this deliberately does NOT do (see docs/ShopAI_ai_architecture.md
 * for why "avoid overbuilt taxonomy" is a standing principle, not an
 * oversight here): no flavor-word stripping, no fat-content synonym
 * canonicalization ("Reduced Fat" == "2%"), no prepared-meal-variant
 * handling — all real, precedented ideas (see the mobile app's
 * src/services/comparisonService.ts, which already does all of this for
 * its own, purely client-side, UI-grouping purpose) but out of scope for
 * establishing the identity foundation itself. Extending `variantFlags`
 * to cover them later needs no schema change — it's already a plain
 * string array.
 */
import type { ApiProduct } from '../types/index.ts';
import { FILLER_WORDS, isUnitOrPackagingWord, singularize, tokenizeName } from './searchService.ts';

export type CanonicalBaseUnit = 'oz' | 'fl_oz' | 'count';

export interface CanonicalProduct {
  canonicalId: string;
  /** The surviving, deduped, sorted identity tokens joined into one
   * string (e.g. "milk whole") — order-invariant by construction, same
   * convention as searchService.ts's own `dedupSignature`, not a
   * display-ready label. */
  normalizedHeadNoun: string;
  baseUnit: CanonicalBaseUnit | null;
  /** Normalized to `baseUnit`'s own base (oz, fl oz, or a raw count) —
   * e.g. "1 Gallon" and "128 fl oz" both become `{ baseUnit: 'fl_oz',
   * baseUnitQuantity: 128 }`. `null` when the size string had nothing
   * recognizable — this never blocks a `canonicalId` from being computed,
   * since head-noun identity and size are independent signals. */
  baseUnitQuantity: number | null;
  /** Detected product variants that do NOT change canonical identity —
   * today just `'organic'`; extensible for flavor/dietary-attribute tags
   * later without a shape change. */
  variantFlags: string[];
}

// A small, deliberately narrow set of dimension-changing size units — a
// backend-appropriate subset of the mobile app's own
// comparisonService.ts's SIZE_PATTERNS (not imported: backend and mobile
// share no runtime/package, so every cross-cutting normalization concept
// in this app is mirrored, not imported — same convention as
// StoreLocation/ApiProduct's manually-mirrored types). Only the units
// actually seen in this app's product data are included; extending this
// list later is additive, not a redesign.
const SIZE_PATTERNS: [RegExp, CanonicalBaseUnit, number][] = [
  [/floz/i, 'fl_oz', 1],
  [/gal(?:lon)?s?/i, 'fl_oz', 128],
  [/qts?|quarts?/i, 'fl_oz', 32],
  [/pts?|pints?/i, 'fl_oz', 16],
  [/ml|milliliters?/i, 'fl_oz', 0.033814],
  [/\bl\b|liters?|litres?/i, 'fl_oz', 33.814],
  [/oz|ounces?/i, 'oz', 1],
  [/lbs?|pounds?/i, 'oz', 16],
  [/kg|kilograms?/i, 'oz', 35.274],
  [/\bg\b|grams?/i, 'oz', 0.035274],
  [/dozen/i, 'count', 12],
  [/ct|count|ea|each/i, 'count', 1],
];

/** Parses a free-text size string into a normalized base-unit quantity —
 * a small, backend-local port of the same idea as
 * comparisonService.ts's `parseSize` (see this file's header). Returns
 * `null` when nothing recognizable is found; callers must treat that as
 * "no size signal," never as zero. */
function parseBaseUnitQuantity(size: string): { baseUnit: CanonicalBaseUnit; baseUnitQuantity: number } | null {
  if (!size) return null;
  const lower = size.toLowerCase().replace(/fl\.?\s*(oz\.?|ounces?)/g, 'floz');

  const numberMatch = lower.match(/(\d+(?:\.\d+)?)\s*([a-z.]+)/);
  if (numberMatch) {
    const [, qtyStr, unitWord] = numberMatch;
    const qty = parseFloat(qtyStr);
    const pattern = SIZE_PATTERNS.find(([re]) => re.test(unitWord));
    if (pattern && qty > 0) {
      const [, baseUnit, multiplier] = pattern;
      return { baseUnit, baseUnitQuantity: qty * multiplier };
    }
  }

  if (/\beach\b|\bea\b/.test(lower)) return { baseUnit: 'count', baseUnitQuantity: 1 };
  return null;
}

/** True for a bare number or a number fused directly onto a unit word
 * (e.g. "128fl", "1gal") — the same numeric-token recognition
 * `isUnitOrPackagingWord` already does internally, exposed here so the
 * head-noun stripping loop below can skip these tokens without
 * re-implementing the regex. */
function isNumericToken(word: string): boolean {
  return /^\d+(\.\d+)?%?$/.test(word);
}

/**
 * The identity-stripping pass: tokenize + singularize the product name,
 * then drop marketing filler (`FILLER_WORDS`), unit/packaging words, and
 * bare numbers — deliberately KEEPING cut/form words ("breast"/"thigh")
 * and alternative-base words ("almond"/"oat"/...), since neither
 * `FILLER_WORDS` nor `isUnitOrPackagingWord` contains them. That's what
 * makes "Chicken Breast" vs. "Chicken Thigh" and "Almond Milk" vs. "Whole
 * Milk" survive as different identities without this function needing
 * to special-case either distinction itself — it only has to strip what
 * relevance-matching already agrees is filler, and leave everything else
 * alone.
 *
 * `'organic'` is the one word stripped *and* recorded as a variant flag,
 * rather than silently discarded — see the module header for why organic
 * and non-organic versions of the same base product deliberately share
 * one `canonicalId`.
 */
function extractIdentity(name: string): { headNounTokens: string[]; variantFlags: string[] } {
  const variantFlags: string[] = [];
  const headNounTokens: string[] = [];

  for (const raw of tokenizeName(name)) {
    const word = singularize(raw);
    if (word === 'organic') {
      variantFlags.push('organic');
      continue;
    }
    if (FILLER_WORDS.has(word)) continue;
    if (isUnitOrPackagingWord(word)) continue;
    if (isNumericToken(word)) continue;
    if (word.length === 0) continue;
    headNounTokens.push(word);
  }

  return { headNounTokens, variantFlags };
}

/**
 * Computes one product's canonical identity, or `null` when there isn't
 * enough signal to build one (e.g. a name that reduces to nothing after
 * stripping — "Organic" with no product word at all). Callers must treat
 * `null` exactly like "no canonical match found," never as an error.
 */
export function computeCanonicalProduct(product: Pick<ApiProduct, 'name' | 'size'>): CanonicalProduct | null {
  const { headNounTokens, variantFlags } = extractIdentity(product.name);
  if (headNounTokens.length === 0) return null;

  // Order-invariant, same convention as searchService.ts's own
  // dedupSignature — two names whose surviving tokens are the same set,
  // regardless of original word order, resolve to one identity.
  const normalizedHeadNoun = [...new Set(headNounTokens)].sort().join(' ');
  const canonicalId = normalizedHeadNoun.replace(/\s+/g, '-');

  const parsedSize = parseBaseUnitQuantity(product.size ?? '');

  return {
    canonicalId,
    normalizedHeadNoun,
    baseUnit: parsedSize?.baseUnit ?? null,
    baseUnitQuantity: parsedSize?.baseUnitQuantity ?? null,
    variantFlags,
  };
}

/**
 * Enriches every product in a search response with `canonicalId` —
 * purely additive: same array length, same order, same every other
 * field. A product `computeCanonicalProduct` can't confidently identify
 * simply keeps `canonicalId: undefined`, exactly as if this function had
 * never run for it. Synchronous and O(n) in the number of products —
 * safe to run over the full result set (not just direct matches, unlike
 * the nutrition-enrichment step, which is bounded because it makes real
 * network calls; this makes none).
 */
export function enrichProductsWithCanonicalId(products: ApiProduct[]): ApiProduct[] {
  return products.map(p => {
    const canonical = computeCanonicalProduct(p);
    return canonical ? { ...p, canonicalId: canonical.canonicalId } : p;
  });
}
