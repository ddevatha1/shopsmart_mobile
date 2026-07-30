/**
 * GET /api/product-image?name=...&store=...&storeProductUrl=... —
 * server-side fallback photo lookup for products a store's own listing
 * didn't include an image for (after searchService.ts's free, exact
 * same-response sibling backfill has already had a chance — see
 * backfillImagesFromSiblings — this only runs for whatever is still
 * missing after that).
 *
 * Two tiers, tried in order:
 *
 *  1. Same-site product-page scrape — when `store`/`storeProductUrl` are
 *     given and a scraper for that store is registered (Sprouts today —
 *     it's where this app's missing-image cases actually come from), visit
 *     that exact product's own page and read the photo it shows there.
 *     This is the same site the app already scrapes for its core search
 *     feature — not a new site or a generic image search — and it's an
 *     exact lookup (a known URL for a known product), not a fuzzy one, so
 *     when it succeeds it's about as reliable as a fallback gets.
 *  2. Open Food Facts (world.openfoodfacts.org) — free, no API key, an
 *     open collaborative grocery product database (ODbL-licensed
 *     specifically for reuse like this). Their API requires a descriptive
 *     User-Agent identifying the calling app; omitting one (an earlier
 *     version of this endpoint did) gets requests silently rejected. Every
 *     candidate is checked with hasDifferentHeadNoun — the same structural
 *     "is this actually the same product" signal searchService.ts uses for
 *     relevance/classification — before its image is trusted. This is what
 *     turns "first result with any image" (verified live to return a
 *     yogurt photo for a "Straus Organic Milk" query) into "a result
 *     that's actually the same product, or nothing."
 */
import type { Request, Response } from 'express';
import type { NutritionAttributes } from '../types/index.ts';
import { hasDifferentHeadNoun, tokenizeName } from '../services/searchService.ts';
import { fetchSproutsProductImage } from '../services/sproutsLiveScraper.ts';
import { TtlCache } from '../utils/ttlCache.ts';
import { withTimeout } from '../utils/withTimeout.ts';

// Product photos (and, now, nutrition facts) essentially never change, so
// this is really "cache forever, but bounded so the process doesn't grow
// unboundedly across a long-lived deploy" — 30 days comfortably outlives
// most deploy cycles.
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
interface ProductImageResult {
  imageUrl: string | null;
  /** Only ever populated via the Open Food Facts path below — the
   * per-store scrape path (Sprouts) supplies an image but no nutrition
   * data, so this stays undefined for results found that way. */
  nutrition?: NutritionAttributes;
}
const imageCache = new TtlCache<ProductImageResult>(CACHE_TTL_MS);

// Registry of per-store product-page scrapers — only Sprouts today,
// because that's the only store this app has actually observed missing
// images from (Kroger/Aldi's official APIs and Trader Joe's listings
// reliably include one). Adding another store later is a one-line entry
// here, not a new endpoint.
const STORE_IMAGE_SCRAPERS: Record<string, (url: string, name: string) => Promise<string | null>> = {
  Sprouts: fetchSproutsProductImage,
};

const USER_AGENT = 'CartIQMobile/1.0 (grocery price comparison app)';
const FETCH_TIMEOUT_MS = 5000;

/** Only the fields this app actually reads out of Open Food Facts' full
 * product record — the real response includes dozens more (ingredients
 * breakdown, packaging, allergens, additives, ...) that this app has no
 * use for and must never forward to the client. Nutrient fields are named
 * `_100g` because that's the one basis OFF reliably reports across
 * products regardless of the product's own serving size. */
export interface OpenFoodFactsNutriments {
  'energy-kcal_100g'?: number;
  proteins_100g?: number;
  fat_100g?: number;
  carbohydrates_100g?: number;
  fiber_100g?: number;
  sugars_100g?: number;
  /** OFF reports sodium in grams per 100g, not milligrams — converted in
   * extractNutrition. */
  sodium_100g?: number;
}

export interface OpenFoodFactsProduct {
  product_name?: string;
  brands?: string;
  image_front_url?: string;
  image_url?: string;
  nutriments?: OpenFoodFactsNutriments;
  nutriscore_grade?: string;
}

interface OpenFoodFactsResponse {
  products?: OpenFoodFactsProduct[];
}

const NUTRISCORE_GRADES = new Set(['a', 'b', 'c', 'd', 'e']);

/** Pulls the minimal `NutritionAttributes` shape (see types/index.ts) out
 * of one Open Food Facts product record — the only place this app reads
 * `nutriments`/`nutriscore_grade` at all. Returns `undefined` when the
 * record has neither (nothing to attach at all) rather than an
 * all-empty object, so callers can tell "no data" from "all zero."
 *
 * `completeness` is computed here, once, rather than left for every
 * future consumer (Healthiest mode, the Nutrition Assistant, ...) to
 * re-derive from field presence itself — `'complete'` requires every one
 * of the seven numeric fields; a real OFF record missing even one of
 * them (extremely common) is honestly `'partial'`, never rounded up. */
export function extractNutrition(product: OpenFoodFactsProduct): NutritionAttributes | undefined {
  const n = product.nutriments;
  const grade = product.nutriscore_grade?.toLowerCase();
  const nutriScore = grade && NUTRISCORE_GRADES.has(grade) ? (grade as NutritionAttributes['nutriScore']) : undefined;

  const caloriesPer100g = n?.['energy-kcal_100g'];
  const proteinGPer100g = n?.proteins_100g;
  const carbsGPer100g = n?.carbohydrates_100g;
  const fatGPer100g = n?.fat_100g;
  const fiberGPer100g = n?.fiber_100g;
  const sugarGPer100g = n?.sugars_100g;
  const sodiumMgPer100g = n?.sodium_100g != null ? n.sodium_100g * 1000 : undefined;

  const macroFields = [caloriesPer100g, proteinGPer100g, carbsGPer100g, fatGPer100g, fiberGPer100g, sugarGPer100g, sodiumMgPer100g];
  if (macroFields.every(v => v == null) && !nutriScore) return undefined;

  return {
    ...(caloriesPer100g != null && { caloriesPer100g }),
    ...(proteinGPer100g != null && { proteinGPer100g }),
    ...(carbsGPer100g != null && { carbsGPer100g }),
    ...(fatGPer100g != null && { fatGPer100g }),
    ...(fiberGPer100g != null && { fiberGPer100g }),
    ...(sugarGPer100g != null && { sugarGPer100g }),
    ...(sodiumMgPer100g != null && { sodiumMgPer100g }),
    ...(nutriScore && { nutriScore }),
    source: 'open_food_facts',
    completeness: macroFields.every(v => v != null) ? 'complete' : 'partial',
  };
}

async function lookupOpenFoodFacts(productName: string): Promise<{ imageUrl: string | null; nutrition?: NutritionAttributes }> {
  const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(productName)}&search_simple=1&action=process&json=1&page_size=8`;

  const res = await withTimeout(
    fetch(url, { headers: { 'User-Agent': USER_AGENT } }),
    FETCH_TIMEOUT_MS,
    'Open Food Facts',
  );
  if (!res.ok) throw new Error(`Open Food Facts returned ${res.status}`);

  const data = (await res.json()) as OpenFoodFactsResponse;
  const queryWords = tokenizeName(productName);

  for (const product of data.products ?? []) {
    const imageUrl = product.image_front_url || product.image_url;
    if (!imageUrl) continue;

    const candidateName = [product.brands, product.product_name].filter(Boolean).join(' ');
    const candidateWords = tokenizeName(candidateName);
    if (candidateWords.length === 0) continue;

    // Reject anything that reads as a different product from our name's
    // perspective (wrong flavor base, wrong product type entirely, ...).
    if (hasDifferentHeadNoun(queryWords, candidateWords)) continue;

    return { imageUrl, nutrition: extractNutrition(product) };
  }

  return { imageUrl: null };
}

/**
 * Best-effort nutrition lookup by product name alone — reused by
 * searchService.ts's search-time enrichment step (see
 * `enrichDirectMatchesWithNutrition`) so a name already resolved via a
 * prior /api/product-image call, or a prior search, is never looked up
 * twice. Deliberately the same cache this route's own handler reads/
 * writes (keyed the same way: `name.toLowerCase()`, no `storeProductUrl`
 * — that keying only ever applies to the store-page scrape path, which
 * never produces nutrition anyway).
 *
 * Imported by searchService.ts via a dynamic `import()` rather than a
 * static one — this file already imports from searchService.ts
 * (`hasDifferentHeadNoun`/`tokenizeName`), so a static import in the
 * other direction would be a circular module dependency. A dynamic
 * import resolves after both modules have finished their initial
 * evaluation, which sidesteps that entirely; the cost is negligible
 * (Node caches the resolved module after the first call).
 */
export async function getCachedOrFetchNutrition(productName: string): Promise<NutritionAttributes | undefined> {
  const cacheKey = productName.toLowerCase();
  const cached = imageCache.get(cacheKey);
  if (cached !== undefined) return cached.nutrition;

  try {
    const result = await lookupOpenFoodFacts(productName);
    imageCache.set(cacheKey, result);
    return result.nutrition;
  } catch (err) {
    console.warn('[ProductImage] nutrition lookup failed:', err);
    // Not cached — a transient failure shouldn't permanently stick as
    // "no nutrition," same reasoning as handleProductImage's own catch.
    return undefined;
  }
}

export async function handleProductImage(req: Request, res: Response): Promise<void> {
  const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
  if (!name) {
    res.status(400).json({ error: '`name` query parameter is required.' });
    return;
  }
  const store = typeof req.query.store === 'string' ? req.query.store.trim() : '';
  const storeProductUrl =
    typeof req.query.storeProductUrl === 'string' ? req.query.storeProductUrl.trim() : '';

  // The store-page scrape is keyed by URL (it's an exact lookup, not a
  // fuzzy name search), so two differently-named products at the same URL
  // — or the same product reached via different query text — don't collide
  // with each other or with the plain name-only OFF cache entries below.
  const cacheKey = storeProductUrl ? `url:${storeProductUrl}` : name.toLowerCase();
  const cached = imageCache.get(cacheKey);
  if (cached !== undefined) {
    res.json(cached);
    return;
  }

  const storeScraper = store ? STORE_IMAGE_SCRAPERS[store] : undefined;
  if (storeScraper && storeProductUrl) {
    try {
      const scraped = await storeScraper(storeProductUrl, name);
      if (scraped) {
        // The store-page scrape only ever returns an image — no
        // nutrition data source on this path (see ProductImageResult).
        const result: ProductImageResult = { imageUrl: scraped };
        imageCache.set(cacheKey, result);
        res.json(result);
        return;
      }
    } catch (err) {
      console.warn('[ProductImage] store scrape failed:', err);
    }
  }

  let result: ProductImageResult;
  try {
    result = await lookupOpenFoodFacts(name);
  } catch (err) {
    console.warn('[ProductImage] lookup failed:', err);
    // A transient failure isn't cached as a permanent "no match" — only a
    // completed lookup (found or genuinely not found) is.
    res.json({ imageUrl: null });
    return;
  }

  imageCache.set(cacheKey, result);
  res.json(result);
}
