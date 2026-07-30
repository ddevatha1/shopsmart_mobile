/**
 * The full grocery search pipeline — query correction, all 4 store adapters
 * in parallel, food/relevance filtering, classification/ranking, cross-store
 * image backfill. Extracted out of routes/search.ts so other server-side
 * code (the Smart Shopping Planner's optimizer, one call per grocery-list
 * item) can call `performSearch` directly instead of issuing an HTTP
 * request back to this same server. Mirrors CartIQ_web's
 * src/services/searchService.ts (same split, same reasoning) — ported here
 * for CartIQ_mobile's independent backend.
 */
import type { ApiProduct, NutritionAttributes, SearchResponse, StoreStatus } from '../types/index.ts';
import { searchSproutsWithTimeout } from './sproutsLiveScraper.ts';
import { searchKrogerWithTimeout, searchHarrisTeeterWithTimeout } from './krogerLiveScraper.ts';
import { searchTraderJoesWithTimeout } from './traderJoesLiveScraper.ts';
import { searchAldiWithTimeout } from './aldiLiveScraper.ts';
import { searchAlbertsonsWithTimeout } from './albertsonsLiveScraper.ts';
import { correctQuery, logQueryCorrection } from './queryCorrection.ts';
import { perfLog } from '../utils/perfLog.ts';
import { withTimeout } from '../utils/withTimeout.ts';
import { enrichProductsWithCanonicalId } from './canonicalProductService.ts';
import type { PreciseCoords } from './locators/types.ts';

type StoreName = ApiProduct['store'];

const ALL_STORES: StoreName[] = ["Trader Joe's", 'Sprouts', 'Kroger', 'Aldi', 'Albertsons', 'Harris Teeter'];
// Stores with no live data source at all right now (see
// albertsonsLiveScraper.ts) — their empty result is an expected
// 'unavailable' state, never counted or displayed as an 'error'.
const UNAVAILABLE_STORES = new Set<StoreName>(['Albertsons']);

// ─── Relevance scoring ───────────────────────────────────────────────────
// Words that don't define what a product IS — strip these when ranking.
// Exported so canonicalProductService.ts can reuse the exact same
// marketing-filler vocabulary for canonical-identity stripping instead of
// duplicating it — the "does this word change what the product IS"
// question is the same one relevance scoring already answers.
export const FILLER_WORDS = new Set([
  'organic', 'natural', 'fresh', 'premium', 'artisan', 'classic', 'raw', 'pure',
  'whole', 'grade', 'certified', 'farm', 'local', 'locally', 'grown', 'harvested',
  'non-gmo', 'kosher', 'vegan', 'gluten-free', 'gluten', 'free', 'usda', 'extra',
  'super', 'large', 'medium', 'small', 'mini', 'giant', 'jumbo', 'select', 'choice',
  'crisp', 'ripe', 'aged', 'roasted', 'toasted', 'smoked', 'baked', 'frozen',
  'a', 'an', 'the', 'of', 'and', 'with', 'in', 'from', 'for', 'no', 'low', 'per',
]);

// A genuinely closed class — units of measure and packaging descriptors
// don't grow as new grocery products are invented, unlike product-type
// nouns (an open-ended, ever-incomplete list). Used to tell "Avocado, 4 ct
// Bag" (still an avocado) apart from "Avocado Veggie Straws" (not one).
const UNIT_OR_PACKAGING_WORDS = new Set([
  'oz', 'fl', 'lb', 'lbs', 'pound', 'pounds', 'g', 'gram', 'grams', 'kg', 'ml', 'l',
  'liter', 'liters', 'gal', 'gallon', 'qt', 'quart', 'pt', 'pint', 'ct', 'count',
  'pk', 'pack', 'packs', 'case', 'dozen', 'ea', 'each', 'bag', 'box', 'jar', 'can',
  'bottle', 'carton', 'bunch', 'piece', 'pieces', 'pc', 'pcs', 'container', 'tray', 'sleeve',
  'half', 'quarter', 'double', 'triple',
]);

// Exported for canonicalProductService.ts — same reasoning as FILLER_WORDS.
export function isUnitOrPackagingWord(word: string): boolean {
  if (UNIT_OR_PACKAGING_WORDS.has(word) || UNIT_OR_PACKAGING_WORDS.has(singularize(word))) return true;
  if (/^\d+(\.\d+)?%?$/.test(word)) return true;
  const fused = word.match(/^\d+(?:\.\d+)?([a-z]+)$/);
  return fused != null && UNIT_OR_PACKAGING_WORDS.has(fused[1]);
}

const CUT_OR_FORM_WORDS = new Set([
  'breast', 'breasts', 'thigh', 'thighs', 'drumstick', 'drumsticks', 'wing', 'wings',
  'leg', 'legs', 'tenderloin', 'tenderloins', 'fillet', 'fillets', 'cutlet', 'cutlets',
  'strip', 'strips', 'ground', 'whole', 'sliced', 'diced', 'chopped', 'shredded',
  'minced', 'cubed', 'grated', 'peeled', 'crushed', 'halved', 'quartered',
]);

function isCutOrFormWord(word: string): boolean {
  return CUT_OR_FORM_WORDS.has(word) || CUT_OR_FORM_WORDS.has(singularize(word));
}

const ALTERNATIVE_BASE_WORDS = new Set([
  'coconut', 'almond', 'oat', 'soy', 'cashew', 'rice', 'hemp', 'pea', 'macadamia', 'flax', 'walnut',
]);

function isAlternativeBaseWord(word: string): boolean {
  return ALTERNATIVE_BASE_WORDS.has(word) || ALTERNATIVE_BASE_WORDS.has(singularize(word));
}

function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigramCounts = (s: string) => {
    const counts = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bigram = s.slice(i, i + 2);
      counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
    }
    return counts;
  };
  const bigramsA = bigramCounts(a);
  const bigramsB = bigramCounts(b);
  let overlap = 0;
  for (const [bigram, count] of bigramsA) {
    const countB = bigramsB.get(bigram);
    if (countB) overlap += Math.min(count, countB);
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

const WORD_SIMILARITY_THRESHOLD = 0.7;

export function wordsMatch(a: string, b: string): boolean {
  if (a === b || a === b + 's' || b === a + 's') return true;
  return diceCoefficient(a, b) >= WORD_SIMILARITY_THRESHOLD;
}

const CATEGORY_EXPANSIONS: Record<string, { matchType: 'direct' | 'related'; synonyms: string[] }> = {
  pasta: {
    matchType: 'direct',
    synonyms: ['spaghetti', 'penne', 'rotini', 'macaroni', 'fettuccine', 'linguine', 'fusilli', 'rigatoni', 'lasagna', 'ravioli', 'orzo', 'noodle', 'noodles', 'angel hair', 'bowtie', 'farfalle'],
  },
  breakfast: {
    matchType: 'direct',
    synonyms: ['cereal', 'oatmeal', 'pancake', 'pancakes', 'waffle', 'waffles', 'bacon', 'egg', 'eggs', 'yogurt', 'granola', 'bagel', 'muffin', 'breakfast burrito', 'hash brown', 'hashbrown'],
  },
  lunch: {
    matchType: 'direct',
    synonyms: ['sandwich', 'wrap', 'soup', 'salad', 'deli meat'],
  },
  dinner: {
    matchType: 'direct',
    synonyms: ['chicken', 'beef', 'pasta', 'rice', 'pork', 'salmon', 'casserole'],
  },
  burger: {
    matchType: 'related',
    synonyms: ['beef', 'patty', 'patties', 'bun', 'buns', 'cheese', 'ketchup', 'mustard', 'pickle', 'pickles', 'lettuce', 'tomato'],
  },
  taco: {
    matchType: 'related',
    synonyms: ['tortilla', 'tortillas', 'salsa', 'beef', 'chicken', 'cheese', 'lettuce', 'sour cream'],
  },
};

function wordMatchesQueryTerm(nWord: string, qWord: string): boolean {
  if (wordsMatch(nWord, qWord)) return true;
  const expansion = CATEGORY_EXPANSIONS[qWord];
  return expansion != null && expansion.synonyms.some(syn => wordsMatch(nWord, syn));
}

function queryWordDirectlyMatches(nWords: string[], qWord: string): boolean {
  return nWords.some(nw => wordsMatch(nw, qWord));
}

function expansionFallbackMatchType(qWords: string[]): 'direct' | 'related' | null {
  for (const qw of qWords) {
    const expansion = CATEGORY_EXPANSIONS[qw];
    if (expansion) return expansion.matchType;
  }
  return null;
}

function queryCoverage(qWords: string[], nWords: string[]): number {
  const present = qWords.filter(qw => nWords.some(nw => wordMatchesQueryTerm(nw, qw)));
  return present.length / qWords.length;
}

export function tokenizeName(name: string): string[] {
  return name
    .toLowerCase()
    .trim()
    .split(/[\s\-–—/,()]+/)
    .map(w => w.replace(/\.+$/, ''))
    .filter(Boolean);
}

function tokenizeQuery(query: string): string[] {
  return query.toLowerCase().trim().split(/\s+/);
}

function isRelevantToQuery(query: string, name: string): boolean {
  return queryCoverage(tokenizeQuery(query), tokenizeName(name)) > 0;
}

function significantWords(nWords: string[]): string[] {
  return nWords.filter(w => !FILLER_WORDS.has(w));
}

function lastQueryMatchIndex(qWords: string[], nWords: string[]): number {
  let lastMatchIdx = -1;
  nWords.forEach((w, i) => {
    if (qWords.some(qw => wordMatchesQueryTerm(w, qw))) lastMatchIdx = i;
  });
  return lastMatchIdx;
}

function isAlternativeBaseVariant(qWords: string[], nWords: string[]): boolean {
  const lastMatchIdx = lastQueryMatchIndex(qWords, nWords);
  if (lastMatchIdx === -1) return false;
  return nWords
    .slice(0, lastMatchIdx)
    .some(w => isAlternativeBaseWord(w) && !qWords.some(qw => wordsMatch(qw, w)));
}

export function hasDifferentHeadNoun(qWords: string[], nWords: string[]): boolean {
  const lastMatchIdx = lastQueryMatchIndex(qWords, nWords);
  if (lastMatchIdx === -1) return false;
  if (isAlternativeBaseVariant(qWords, nWords)) return true;
  if (nWords.slice(0, lastMatchIdx).includes('with')) return true;
  if (nWords[lastMatchIdx - 1] === '&') return true;
  for (const w of nWords.slice(lastMatchIdx + 1)) {
    if (FILLER_WORDS.has(w) || isUnitOrPackagingWord(w)) continue;
    return !isCutOrFormWord(w);
  }
  return false;
}

export function computeRelevance(query: string, name: string): number {
  const q = query.toLowerCase().trim();
  const n = name.toLowerCase().trim();
  const nWords = tokenizeName(n);
  const qWords = tokenizeQuery(q);

  const nBase = n.endsWith('s') ? n.slice(0, -1) : n;
  const qBase = q.endsWith('s') ? q.slice(0, -1) : q;
  if (nBase === qBase) return 100;

  const coverage = queryCoverage(qWords, nWords);

  if (coverage < 1) {
    return coverage > 0 ? Math.round(coverage * 25) : 0;
  }

  const sigWords = significantWords(nWords);
  const firstSigIdx = Math.max(
    0,
    sigWords.findIndex(nw => qWords.some(qw => wordMatchesQueryTerm(nw, qw))),
  );

  let score = Math.max(35, 85 - firstSigIdx * 12);

  if (hasDifferentHeadNoun(qWords, nWords)) {
    score = Math.min(score, 50);
  }

  const extra = sigWords.length - qWords.length;
  if (extra <= 0) score = Math.min(100, score + 10);
  else if (extra === 1) score = Math.min(100, score + 3);

  return score;
}

export function classifyMatch(query: string, product: Pick<ApiProduct, 'name' | 'category'>): 'direct' | 'related' {
  const q = query.toLowerCase().trim();
  const n = product.name.toLowerCase().trim();
  const nWords = tokenizeName(n);
  const qWords = tokenizeQuery(q);

  const nBase = n.endsWith('s') ? n.slice(0, -1) : n;
  const qBase = q.endsWith('s') ? q.slice(0, -1) : q;
  if (nBase === qBase) return 'direct';

  if (queryCoverage(qWords, nWords) < 1) return 'related';

  const allWordsDirectlyPresent = qWords.every(qw => queryWordDirectlyMatches(nWords, qw));
  if (!allWordsDirectlyPresent) {
    return expansionFallbackMatchType(qWords) ?? 'related';
  }

  if (!hasDifferentHeadNoun(qWords, nWords)) return 'direct';

  if (product.category && wordsMatch(product.category.toLowerCase().trim(), q)) {
    return 'direct';
  }

  return 'related';
}

const SIZE_OR_MEASURE_WORDS = new Set([
  'small', 'medium', 'large', 'mini', 'giant', 'jumbo', 'extra', 'super', 'petite',
  'oz', 'fl', 'lb', 'lbs', 'g', 'gram', 'grams', 'kg', 'ml', 'l', 'liter', 'liters',
  'gal', 'gallon', 'qt', 'quart', 'pt', 'pint', 'ct', 'count',
]);

// Exported for canonicalProductService.ts — same reasoning as FILLER_WORDS.
export function singularize(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

function dedupSignature(name: string): string {
  const words = tokenizeName(name)
    .map(singularize)
    .filter(w => {
      if (w === 'organic') return true;
      if (FILLER_WORDS.has(w)) return false;
      if (SIZE_OR_MEASURE_WORDS.has(w)) return false;
      if (/^\d+(\.\d+)?%?$/.test(w)) return false;
      return true;
    });
  return [...new Set(words)].sort().join(' ');
}

export function isSameProductName(nameA: string, nameB: string): boolean {
  const wordsA = tokenizeName(nameA);
  const wordsB = tokenizeName(nameB);
  const [shorter, longer] = wordsA.length <= wordsB.length ? [wordsA, wordsB] : [wordsB, wordsA];
  if (shorter.length < 3) return false;
  return shorter.every(w => longer.some(w2 => wordsMatch(w, w2)));
}

function backfillImagesFromSiblings(products: ApiProduct[]): ApiProduct[] {
  const withImages = products.filter(p => p.image_url);
  return products.map(p => {
    if (p.image_url) return p;
    const sibling = withImages.find(other => isSameProductName(p.name, other.name));
    return sibling ? { ...p, image_url: sibling.image_url } : p;
  });
}

const MIN_DIRECT_TARGET = 2;

interface ScoredProduct {
  product: ApiProduct;
  relevance: number;
}

function selectStoreProducts(query: string, candidates: ApiProduct[]): ScoredProduct[] {
  const qWords = tokenizeQuery(query);

  const scored = candidates.map(p => {
    const matchType = classifyMatch(query, p);
    const isAltBase = matchType === 'related' && isAlternativeBaseVariant(qWords, tokenizeName(p.name));
    return { product: { ...p, matchType }, relevance: computeRelevance(query, p.name), isAltBase };
  });

  scored.sort((a, b) => {
    if (a.product.matchType !== b.product.matchType) {
      return a.product.matchType === 'direct' ? -1 : 1;
    }
    if (a.relevance !== b.relevance) return b.relevance - a.relevance;
    return a.product.price - b.product.price;
  });

  const seenSignatures = new Set<string>();
  const direct: (typeof scored)[number][] = [];
  const related: (typeof scored)[number][] = [];
  for (const entry of scored) {
    const sig = dedupSignature(entry.product.name);
    if (seenSignatures.has(sig)) continue;
    seenSignatures.add(sig);
    (entry.product.matchType === 'direct' ? direct : related).push(entry);
  }

  if (direct.length < MIN_DIRECT_TARGET) {
    const promotable = related.filter(r => r.isAltBase).slice(0, MIN_DIRECT_TARGET - direct.length);
    for (const entry of promotable) {
      entry.product = { ...entry.product, matchType: 'direct' };
      direct.push(entry);
      related.splice(related.indexOf(entry), 1);
    }
  }

  return [...direct, ...related].map(({ product, relevance }) => ({ product, relevance }));
}

const NON_FOOD_NAME_KEYWORDS = [
  'shampoo', 'conditioner', 'detergent', 'laundry', 'bleach', 'disinfect',
  'deodorant', 'lotion', 'moisturizer', 'sunscreen', 'toothpaste', 'mouthwash',
  'fertilizer', 'dog food', 'cat food', 'pet food',
  'toilet paper', 'paper towel', 'facial tissue', 'napkin', 'diaper', 'baby wipe',
  'wet wipe', 'dish soap', 'dishwasher detergent', 'fabric softener', 'stain remover',
  'air freshener', 'scented candle', 'trash bag', 'garbage bag', 'aluminum foil',
  'plastic wrap', 'parchment paper', 'storage bag',
  'shaving cream', 'razor blade', 'soap', 'beauty bar', 'cleansing bar',
  'body wash', 'hand sanitizer',
  'first aid', 'bandage', 'multivitamin', 'dietary supplement', 'protein supplement',
  'dog treat', 'cat treat', 'kitty litter', 'cat litter',
  'all-purpose cleaner', 'glass cleaner', 'floor cleaner', 'bathroom cleaner',
  'toilet bowl cleaner',
  'paper plate', 'paper cup', 'greeting card', 'gift card', 'magazine',
];

function isFoodProductName(name: string): boolean {
  const lower = name.toLowerCase();
  return !NON_FOOD_NAME_KEYWORDS.some(kw => lower.includes(kw));
}

function timedStoreSearch<T>(store: string, promise: Promise<T>): Promise<T> {
  const start = Date.now();
  perfLog('search:store-start', { store });
  return promise.then(
    (value) => {
      perfLog('search:store-complete', { store, ok: true, ms: Date.now() - start });
      return value;
    },
    (err) => {
      perfLog('search:store-complete', { store, ok: false, ms: Date.now() - start });
      throw err;
    },
  );
}

export const MAX_NUTRITION_ENRICHMENT = 10;
export const NUTRITION_ENRICHMENT_BUDGET_MS = 1200;

/** The real production nutrition fetcher — a thin wrapper around
 * routes/productImage.ts's cache + Open Food Facts lookup, imported
 * dynamically (not statically) to avoid a circular module dependency:
 * that file already imports `hasDifferentHeadNoun`/`tokenizeName` from
 * this one. Kept as its own function (rather than inlined) so
 * `enrichDirectMatchesWithNutrition`'s default parameter is the only
 * place this app's search pipeline ever touches Open Food Facts
 * specifics — everything else sees only the abstract
 * `(name) => Promise<NutritionAttributes | undefined>` shape below. */
async function fetchNutritionFromOpenFoodFacts(name: string): Promise<NutritionAttributes | undefined> {
  const { getCachedOrFetchNutrition } = await import('../routes/productImage.ts');
  return getCachedOrFetchNutrition(name);
}

/**
 * Best-effort nutrition enrichment for the products a shopper (and the
 * Smart Shopping Planner's optimizer, which calls performSearch directly
 * per grocery-list item) actually sees or compares — capped to direct
 * matches only (never every related/tangential result) and to a strict
 * overall time budget, so a slow or unresponsive Open Food Facts can
 * never meaningfully delay a search response.
 *
 * Missing nutrition (timeout, no Open Food Facts match, over the cap) is
 * the expected, common outcome, never an error — every caller must treat
 * `product.nutrition` as optional.
 *
 * `fetchNutrition` defaults to the real Open Food Facts-backed lookup and
 * exists as a parameter purely for testability — tests inject a fake
 * `(name) => Promise<NutritionAttributes | undefined>` instead of a real
 * network call, without ever needing to know or fake an Open Food Facts
 * response shape (that stays entirely inside routes/productImage.ts).
 */
export async function enrichDirectMatchesWithNutrition(
  products: ApiProduct[],
  fetchNutrition: (name: string) => Promise<NutritionAttributes | undefined> = fetchNutritionFromOpenFoodFacts,
): Promise<ApiProduct[]> {
  const targets = products.filter(p => p.matchType !== 'related').slice(0, MAX_NUTRITION_ENRICHMENT);
  if (targets.length === 0) return products;

  let resolved: (NutritionAttributes | undefined)[];
  try {
    const settled = await withTimeout(
      Promise.allSettled(targets.map(p => fetchNutrition(p.name))),
      NUTRITION_ENRICHMENT_BUDGET_MS,
      'Nutrition enrichment',
    );
    resolved = settled.map(r => (r.status === 'fulfilled' ? r.value : undefined));
  } catch {
    // Budget exceeded — proceed with no enrichment this request rather
    // than delaying the response further. Nothing found so far is kept;
    // it's simply not attached.
    return products;
  }

  const nutritionByName = new Map(targets.map((p, i) => [p.name, resolved[i]]));
  return products.map(p => {
    const nutrition = nutritionByName.get(p.name);
    return nutrition ? { ...p, nutrition } : p;
  });
}

/**
 * The full search pipeline as a plain in-process function — the same logic
 * routes/search.ts's `handleSearch` runs, callable directly by other
 * server-side code (the Smart Shopping Planner's optimizer). `noCorrect`
 * mirrors the route's own request body flag.
 */
export async function performSearch(
  rawQuery: string,
  zipcode: string,
  options?: { noCorrect?: boolean; preciseCoords?: PreciseCoords },
): Promise<SearchResponse> {
  const requestStart = Date.now();
  perfLog('search:request-start', { query: rawQuery, zipcode });

  const correctionStart = Date.now();
  const correction = options?.noCorrect
    ? { original: rawQuery, normalized: rawQuery.trim(), corrected: rawQuery.trim(), correctedDisplay: rawQuery.trim(), confidence: 1, level: 'none' as const, method: 'skipped-by-request' }
    : correctQuery(rawQuery);
  logQueryCorrection(correction);
  perfLog('search:query-correction', { ms: Date.now() - correctionStart, level: correction.level });
  const query = correction.level === 'none' ? correction.normalized : correction.corrected;

  const preciseCoords = options?.preciseCoords;
  const [traderJoesResult, sproutsResult, krogerResult, aldiResult, albertsonsResult, harrisTeeterResult] = await Promise.allSettled([
    timedStoreSearch("Trader Joe's", searchTraderJoesWithTimeout(query, zipcode, 45_000, preciseCoords)), // still browser-based; includes storefront visit on first run
    timedStoreSearch('Sprouts', searchSproutsWithTimeout(query, zipcode, 15_000)), // plain GraphQL API, no browser
    timedStoreSearch('Kroger', searchKrogerWithTimeout(query, zipcode, 15_000, preciseCoords)), // REST API, no browser
    timedStoreSearch('Aldi', searchAldiWithTimeout(query, zipcode, 15_000)), // GraphQL API, no browser
    timedStoreSearch('Albertsons', searchAlbertsonsWithTimeout(query, zipcode, 15_000, preciseCoords)), // no live product source yet — always resolves empty, see albertsonsLiveScraper.ts
    timedStoreSearch('Harris Teeter', searchHarrisTeeterWithTimeout(query, zipcode, 15_000, preciseCoords)), // same official Kroger API, scoped to the HART chain — see krogerLiveScraper.ts
  ]);

  const aggregateStart = Date.now();
  perfLog('search:aggregate-start', {});

  const storeMap = new Map<StoreName, ScoredProduct[]>();
  const storeErrors = new Map<StoreName, string>();

  function collectStoreResult(
    store: StoreName,
    result: PromiseSettledResult<ApiProduct[]>,
    searchQuery: string,
  ): void {
    if (result.status !== 'fulfilled') {
      storeErrors.set(store, String(result.reason));
      console.warn(`[Search] ${store} error:`, result.reason);
      perfLog('search:store-funnel', {
        store, query: rawQuery, queryUsed: searchQuery,
        rawCount: 0, afterFoodFilter: 0, afterRelevanceFilter: 0, finalCount: 0, error: true,
      });
      return;
    }

    const raw = result.value;
    const afterFood = raw.filter(p => isFoodProductName(p.name));
    for (const p of raw) {
      if (!isFoodProductName(p.name)) {
        console.log(`[SearchFilter] ${store}: excluded "${p.name}" — reason: not classified as a food product`);
      }
    }

    const relevant = afterFood.filter(p => isRelevantToQuery(searchQuery, p.name));
    for (const p of afterFood) {
      if (!isRelevantToQuery(searchQuery, p.name)) {
        console.log(`[SearchFilter] ${store}: excluded "${p.name}" — reason: no word overlap with query "${searchQuery}"`);
      }
    }

    const selected = selectStoreProducts(searchQuery, relevant);
    storeMap.set(store, selected);

    perfLog('search:store-funnel', {
      store,
      query: rawQuery,
      queryUsed: searchQuery,
      rawCount: raw.length,
      afterFoodFilter: afterFood.length,
      afterRelevanceFilter: relevant.length,
      finalCount: selected.length,
    });
  }

  collectStoreResult("Trader Joe's", traderJoesResult, query);
  collectStoreResult('Sprouts', sproutsResult, query);
  collectStoreResult('Kroger', krogerResult, query);
  collectStoreResult('Aldi', aldiResult, query);
  collectStoreResult('Albertsons', albertsonsResult, query);
  collectStoreResult('Harris Teeter', harrisTeeterResult, query);

  const storeStatuses: StoreStatus[] = ALL_STORES.map(store => {
    const products = storeMap.get(store) ?? [];
    if (products.length === 0 && UNAVAILABLE_STORES.has(store)) {
      return {
        store,
        status: 'unavailable',
        count: 0,
        error: "Live pricing isn't available for this store yet.",
      };
    }
    return {
      store,
      status: products.length > 0 ? 'success' : 'error',
      count: products.length,
      error: products.length === 0 ? (storeErrors.get(store) ?? 'No results found.') : undefined,
    };
  });

  const scored: ScoredProduct[] = ALL_STORES.flatMap(store => storeMap.get(store) ?? []);

  scored.sort((a, b) => {
    if (a.product.matchType !== b.product.matchType) {
      return a.product.matchType === 'direct' ? -1 : 1;
    }
    if (a.relevance !== b.relevance) return b.relevance - a.relevance;
    return a.product.price - b.product.price;
  });

  const backfilled = backfillImagesFromSiblings(scored.map(s => s.product));

  const nutritionStart = Date.now();
  const nutritionEnriched = await enrichDirectMatchesWithNutrition(backfilled);
  perfLog('search:nutrition-enrichment', {
    ms: Date.now() - nutritionStart,
    attempted: Math.min(nutritionEnriched.filter(p => p.matchType !== 'related').length, MAX_NUTRITION_ENRICHMENT),
    resolved: nutritionEnriched.filter(p => p.nutrition != null).length,
  });

  // Synchronous and unbounded (no network, unlike nutrition enrichment
  // above) — safe to run over every product, not just direct matches.
  // Purely additive: same array length/order/every-other-field: only
  // `canonicalId` is ever added, never removed or changed.
  const canonicalStart = Date.now();
  const enrichedProducts = enrichProductsWithCanonicalId(nutritionEnriched);
  perfLog('search:canonical-enrichment', {
    ms: Date.now() - canonicalStart,
    resolved: enrichedProducts.filter(p => p.canonicalId != null).length,
    total: enrichedProducts.length,
  });

  const response: SearchResponse = {
    products: enrichedProducts,
    storeStatuses,
    ...(correction.level !== 'none' && {
      correction: {
        original: correction.original,
        corrected: correction.correctedDisplay,
        confidence: correction.confidence,
        level: correction.level,
      },
    }),
  };
  perfLog('search:aggregate-complete', { ms: Date.now() - aggregateStart, productCount: response.products.length });
  perfLog('search:request-complete', {
    query,
    zipcode,
    ms: Date.now() - requestStart,
    productCount: response.products.length,
  });
  return response;
}
