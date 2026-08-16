/**
 * The full grocery search pipeline — query correction, all 4 store adapters
 * in parallel, food/relevance filtering, classification/ranking, cross-store
 * image backfill. Extracted out of routes/search.ts so other server-side
 * code (the Smart Shopping Planner's optimizer, one call per grocery-list
 * item) can call `performSearch` directly instead of issuing an HTTP
 * request back to this same server. Mirrors ShopAI_web's
 * src/services/searchService.ts (same split, same reasoning) — ported here
 * for ShopAI's independent backend.
 */
import type { ApiProduct, NutritionAttributes, SearchResponse, StoreStatus } from '../types/index.ts';
import { searchSproutsWithTimeout } from './sproutsLiveScraper.ts';
import { searchKrogerWithTimeout, searchHarrisTeeterWithTimeout } from './krogerLiveScraper.ts';
import { searchTraderJoesWithTimeout } from './traderJoesLiveScraper.ts';
import { searchAldiWithTimeout } from './aldiLiveScraper.ts';
import { searchAlbertsonsWithTimeout } from './albertsonsLiveScraper.ts';
import { searchTomThumbWithTimeout } from './tomThumbLiveScraper.ts';
import { searchWholeFoodsWithTimeout } from './wholeFoodsLiveScraper.ts';
import { searchPublixWithTimeout } from './publixLiveScraper.ts';
import { correctQuery, logQueryCorrection, type QueryCorrectionResult } from './queryCorrection.ts';
import { perfLog } from '../utils/perfLog.ts';
import { withTimeout } from '../utils/withTimeout.ts';
import { enrichProductsWithCanonicalId } from './canonicalProductService.ts';
import type { PreciseCoords } from './locators/types.ts';

type StoreName = ApiProduct['store'];

// Exported for internalDashboard.ts's "stores supported" number — the
// same list this pipeline actually searches, not a separate constant
// that could drift from it.
export const ALL_STORES: StoreName[] = ["Trader Joe's", 'Sprouts', 'Kroger', 'Aldi', 'Albertsons', 'Harris Teeter', 'Tom Thumb', 'Whole Foods Market', 'Publix'];
// Stores with no live data source at all right now (see
// albertsonsLiveScraper.ts, tomThumbLiveScraper.ts) — their empty result is
// an expected 'unavailable' state, never counted or displayed as an 'error'.
const UNAVAILABLE_STORES = new Set<StoreName>(['Albertsons', 'Tom Thumb']);

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

// ── Global per-search response budget ──────────────────────────────────
//
// Every store call above already carries its OWN timeout (15s for the
// plain-API stores, 45s for Trader Joe's worst case), but `Promise.allSettled`
// only ever resolves once EVERY branch has settled — so before this, the
// overall `/api/search` response was gated by whichever store's own
// timeout happened to be largest, even though the other 8 stores had
// already come back in a couple of seconds. One slow-but-not-fast-failing
// store (a real network hiccup, an upstream provider having a bad moment)
// could silently turn every search into a 15-45s wait for every store,
// not just the slow one — exactly the "one slow store blocks everything"
// failure mode this whole pipeline was supposed to avoid.
//
// `raceAgainstResponseBudget` fixes that by racing each store's own
// (already-settling) promise against a SHARED, much shorter budget. A
// store that's still running when the budget elapses is reported as
// 'pending' (see StoreStatus) rather than making every other, already-
// finished store wait on it — the response goes out with whatever's
// ready. The underlying promise is never cancelled: it keeps running in
// the background and, when it does eventually finish, is only logged
// (`search:store-late-complete`) — never lost — so a store's own result
// cache (each store scraper keeps a short-TTL cache of its own) still gets
// populated for that shopper's very next search, same pattern already
// used for Trader Joe's session bootstrap and Whole Foods' directory
// crawl in warmupService.ts.
export const SEARCH_RESPONSE_BUDGET_MS = 10_000;

export type StoreOutcome<T> = PromiseSettledResult<T> | { status: 'pending' };

export function raceAgainstResponseBudget<T>(
  store: string,
  promise: Promise<T>,
  budgetMs: number = SEARCH_RESPONSE_BUDGET_MS,
): Promise<StoreOutcome<T>> {
  const settleStart = Date.now();
  const settled: Promise<StoreOutcome<T>> = promise.then(
    (value): StoreOutcome<T> => ({ status: 'fulfilled', value }),
    (reason): StoreOutcome<T> => ({ status: 'rejected', reason }),
  );
  return new Promise((resolve) => {
    let settledFirst = false;
    // Cleared the moment the store settles first — the common, warmed-up
    // case (see this file's timing comments below). Without this, every
    // store that finishes well under budget still leaves a live timer
    // sitting in Node's timer table for the rest of the budget window for
    // nothing; under real concurrent search volume that's 9 dangling
    // timers per request that did nothing but wait to no-op.
    const timer = setTimeout(() => {
      if (settledFirst) return;
      resolve({ status: 'pending' });
      // Still resolves/rejects on its own time — just too late for THIS
      // response. Logged, not swallowed, so a store that's chronically
      // slower than the budget (rather than genuinely hung) is visible in
      // the logs instead of silently always reporting 'pending'.
      settled.then((outcome) => {
        perfLog('search:store-late-complete', {
          store,
          ok: outcome.status === 'fulfilled',
          msOverBudget: Date.now() - settleStart - budgetMs,
        });
      });
    }, budgetMs);
    settled.then((outcome) => {
      settledFirst = true;
      clearTimeout(timer);
      resolve(outcome);
    });
  });
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
  // Each store's own promise still carries its own individual timeout
  // (below) as a background safety net — `raceAgainstResponseBudget` is
  // what actually bounds how long THIS response waits: every store gets
  // SEARCH_RESPONSE_BUDGET_MS to settle, and one that's still running past
  // that comes back as 'pending' instead of holding up the other 8 stores'
  // already-ready results. See raceAgainstResponseBudget's own header
  // comment for the full reasoning.
  const [traderJoesResult, sproutsResult, krogerResult, aldiResult, albertsonsResult, harrisTeeterResult, tomThumbResult, wholeFoodsResult, publixResult] = await Promise.all([
    raceAgainstResponseBudget("Trader Joe's", timedStoreSearch("Trader Joe's", searchTraderJoesWithTimeout(query, zipcode, 45_000, preciseCoords))), // skips itself (fast) rather than blocking if its session isn't warm yet — see storeReadiness.ts
    raceAgainstResponseBudget('Sprouts', timedStoreSearch('Sprouts', searchSproutsWithTimeout(query, zipcode, 15_000))), // plain GraphQL API, no browser
    raceAgainstResponseBudget('Kroger', timedStoreSearch('Kroger', searchKrogerWithTimeout(query, zipcode, 15_000, preciseCoords))), // REST API, no browser
    raceAgainstResponseBudget('Aldi', timedStoreSearch('Aldi', searchAldiWithTimeout(query, zipcode, 15_000))), // GraphQL API, no browser
    raceAgainstResponseBudget('Albertsons', timedStoreSearch('Albertsons', searchAlbertsonsWithTimeout(query, zipcode, 15_000, preciseCoords))), // no live product source yet — always resolves empty, see albertsonsLiveScraper.ts
    raceAgainstResponseBudget('Harris Teeter', timedStoreSearch('Harris Teeter', searchHarrisTeeterWithTimeout(query, zipcode, 15_000, preciseCoords))), // same official Kroger API, scoped to the HART chain — see krogerLiveScraper.ts
    raceAgainstResponseBudget('Tom Thumb', timedStoreSearch('Tom Thumb', searchTomThumbWithTimeout(query, zipcode, 15_000, preciseCoords))), // no live product source yet — always resolves empty, see tomThumbLiveScraper.ts
    raceAgainstResponseBudget('Whole Foods Market', timedStoreSearch('Whole Foods Market', searchWholeFoodsWithTimeout(query, zipcode, 15_000, preciseCoords))), // real SSR'd product data, no browser — see wholeFoodsLiveScraper.ts
    raceAgainstResponseBudget('Publix', timedStoreSearch('Publix', searchPublixWithTimeout(query, zipcode, 15_000, preciseCoords))), // Instacart-fulfilled GraphQL API, no browser — see publixLiveScraper.ts
  ]);

  const aggregateStart = Date.now();
  perfLog('search:aggregate-start', {});

  const storeMap = new Map<StoreName, ScoredProduct[]>();
  const storeErrors = new Map<StoreName, string>();
  const pendingStores = new Set<StoreName>();

  function collectStoreResult(
    store: StoreName,
    result: StoreOutcome<ApiProduct[]>,
    searchQuery: string,
  ): void {
    if (result.status === 'pending') {
      pendingStores.add(store);
      perfLog('search:store-funnel', {
        store, query: rawQuery, queryUsed: searchQuery,
        rawCount: 0, afterFoodFilter: 0, afterRelevanceFilter: 0, finalCount: 0, pending: true,
      });
      return;
    }
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
    // Per-item exclusion reasons used to be logged one line per excluded
    // product here (up to dozens per store per search — real production
    // volume observed: ~20 lines for a single store on a single search)
    // on top of the `search:store-funnel` line below, which already
    // reports the same before/after counts in one line. Removed as pure
    // noise that drowned out the actually-useful `[Perf]` timing lines in
    // production logs; the aggregate counts are all `search:store-funnel`
    // ever needed to make a dropped-product count investigable.
    const afterFood = raw.filter(p => isFoodProductName(p.name));
    const relevant = afterFood.filter(p => isRelevantToQuery(searchQuery, p.name));
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
  collectStoreResult('Tom Thumb', tomThumbResult, query);
  collectStoreResult('Whole Foods Market', wholeFoodsResult, query);
  collectStoreResult('Publix', publixResult, query);

  const storeStatuses: StoreStatus[] = ALL_STORES.map(store => {
    const products = storeMap.get(store) ?? [];
    // Still running past SEARCH_RESPONSE_BUDGET_MS when this response went
    // out — distinct from 'error' (which means the store definitively
    // failed/returned nothing): the shopper's client already knows to treat
    // 'pending' as "try this store again shortly" rather than a real
    // failure, and the store's own background completion (logged via
    // `search:store-late-complete`) means its result cache is warm for
    // whatever they search next regardless.
    if (products.length === 0 && pendingStores.has(store)) {
      return {
        store,
        status: 'pending',
        count: 0,
        error: 'Still searching — results may be available on your next search.',
      };
    }
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
    pendingStores: pendingStores.size > 0 ? [...pendingStores] : undefined,
  });
  return response;
}

// ── Progressive search results ───────────────────────────────────────────
//
// `performSearch` above is a single-shot pipeline: it waits for every store
// to either settle or hit SEARCH_RESPONSE_BUDGET_MS (whichever first), THEN
// returns one complete SearchResponse — exactly the contract the Smart
// Shopping Planner's optimizer needs (a final, complete-as-possible result
// per grocery-list item), so it's kept completely unchanged above.
//
// `/api/search` itself has a different, harder requirement: a shopper
// should see a fast store's results the moment they're ready, not once the
// slowest-of-the-fast-stores also finishes. With 9 stores fanned out in
// parallel, `Promise.all` (performSearch's approach) can't do that — it
// only ever returns once EVERY one of them has settled, up to the full
// SEARCH_RESPONSE_BUDGET_MS. `startProgressiveSearch` below returns as soon
// as the FIRST store settles (or SEARCH_RESPONSE_BUDGET_MS elapses — the
// exact same worst-case ceiling `performSearch` already uses, just applied
// to "wait for the first result" instead of "wait for the last one"), and
// `getSearchSnapshot` lets the client poll (via the response's own
// `searchId`) for whichever stores finish afterward — without ever
// re-issuing the underlying store requests, which are started exactly
// once here and simply kept running in the background regardless of how
// many times (or whether) anyone polls for their result. Mirrors
// shopsmart_mobile main's own client (searchStore.ts's pollForLateResults)
// exactly — same `searchId` contract, same GET /api/search/:searchId route.
interface SessionStoreState {
  status: 'pending' | 'success' | 'error' | 'unavailable';
  products: ScoredProduct[];
  error?: string;
}

interface SearchSession {
  searchId: string;
  rawQuery: string;
  query: string;
  correction: QueryCorrectionResult;
  storeState: Map<StoreName, SessionStoreState>;
}

// Short-lived, self-cleaning — a session only needs to outlive the slowest
// store's own worst-case timeout (45s, Trader Joe's) plus headroom for a
// client's last poll to still catch a just-finished result; nothing here
// needs to survive a server restart or be visible across processes.
const searchSessions = new Map<string, SearchSession>();
const SEARCH_SESSION_TTL_MS = 60_000;

function scheduleSessionCleanup(searchId: string): void {
  setTimeout(() => searchSessions.delete(searchId), SEARCH_SESSION_TTL_MS).unref?.();
}

/** Same food/relevance filter + selection `performSearch`'s own
 * `collectStoreResult` runs per store, pulled out here so a store's
 * products are classified/ranked exactly once, the moment that store's
 * promise resolves, rather than re-doing it on every poll. */
function classifyStoreProducts(store: StoreName, raw: ApiProduct[], searchQuery: string, rawQuery: string, searchId: string): ScoredProduct[] {
  const afterFood = raw.filter(p => isFoodProductName(p.name));
  const relevant = afterFood.filter(p => isRelevantToQuery(searchQuery, p.name));
  const selected = selectStoreProducts(searchQuery, relevant);
  perfLog('search:store-funnel', {
    store, query: rawQuery, queryUsed: searchQuery,
    rawCount: raw.length, afterFoodFilter: afterFood.length, afterRelevanceFilter: relevant.length, finalCount: selected.length,
    searchId,
  });
  return selected;
}

function buildSnapshotResponse(session: SearchSession): SearchResponse {
  const storeStatuses: StoreStatus[] = ALL_STORES.map(store => {
    const state = session.storeState.get(store)!;
    if (state.status === 'pending') {
      return {
        store,
        status: 'pending',
        count: 0,
        error: 'Still searching — results may be available shortly.',
      };
    }
    if (state.status === 'unavailable') {
      return {
        store,
        status: 'unavailable',
        count: 0,
        error: "Live pricing isn't available for this store yet.",
      };
    }
    return {
      store,
      status: state.products.length > 0 ? 'success' : 'error',
      count: state.products.length,
      error: state.products.length === 0 ? (state.error ?? 'No results found.') : undefined,
    };
  });

  const scored: ScoredProduct[] = ALL_STORES.flatMap(store => session.storeState.get(store)!.products);
  scored.sort((a, b) => {
    if (a.product.matchType !== b.product.matchType) {
      return a.product.matchType === 'direct' ? -1 : 1;
    }
    if (a.relevance !== b.relevance) return b.relevance - a.relevance;
    return a.product.price - b.product.price;
  });

  const backfilled = backfillImagesFromSiblings(scored.map(s => s.product));
  // Cheap, synchronous, no network — safe to run on every snapshot, unlike
  // nutrition enrichment (network-bound), which the progressive path
  // deliberately skips: a shopper polling for fast-arriving results
  // shouldn't have each poll additionally wait on a per-store Open Food
  // Facts round trip. The Smart Shopping Planner (performSearch's only
  // other caller) still gets full nutrition enrichment, unaffected.
  const enrichedProducts = enrichProductsWithCanonicalId(backfilled);

  return {
    products: enrichedProducts,
    storeStatuses,
    searchId: session.searchId,
    ...(session.correction.level !== 'none' && {
      correction: {
        original: session.correction.original,
        corrected: session.correction.correctedDisplay,
        confidence: session.correction.confidence,
        level: session.correction.level,
      },
    }),
  };
}

/**
 * Starts all 9 store searches concurrently (exactly once — nothing here or
 * in `getSearchSnapshot` ever re-issues them) and returns as soon as the
 * FIRST one settles, or SEARCH_RESPONSE_BUDGET_MS elapses, whichever comes
 * first. Every store's promise keeps running in the background regardless
 * of when this function itself returns.
 */
export async function startProgressiveSearch(
  rawQuery: string,
  zipcode: string,
  options?: { noCorrect?: boolean; preciseCoords?: PreciseCoords },
): Promise<SearchResponse> {
  const requestStart = Date.now();
  const searchId = crypto.randomUUID().slice(0, 8);
  perfLog('search:request-start', { query: rawQuery, zipcode, searchId, mode: 'progressive' });

  const correctionStart = Date.now();
  const correction = options?.noCorrect
    ? { original: rawQuery, normalized: rawQuery.trim(), corrected: rawQuery.trim(), correctedDisplay: rawQuery.trim(), confidence: 1, level: 'none' as const, method: 'skipped-by-request' }
    : correctQuery(rawQuery);
  logQueryCorrection(correction);
  perfLog('search:query-correction', { ms: Date.now() - correctionStart, level: correction.level, searchId });
  const query = correction.level === 'none' ? correction.normalized : correction.corrected;
  const preciseCoords = options?.preciseCoords;

  const session: SearchSession = {
    searchId,
    rawQuery,
    query,
    correction,
    storeState: new Map(ALL_STORES.map(store => [store, { status: 'pending' as const, products: [] }])),
  };
  searchSessions.set(searchId, session);
  scheduleSessionCleanup(searchId);

  const storeCalls: [StoreName, Promise<ApiProduct[]>][] = [
    ["Trader Joe's", timedStoreSearch("Trader Joe's", searchTraderJoesWithTimeout(query, zipcode, 45_000, preciseCoords))],
    ['Sprouts', timedStoreSearch('Sprouts', searchSproutsWithTimeout(query, zipcode, 15_000))],
    ['Kroger', timedStoreSearch('Kroger', searchKrogerWithTimeout(query, zipcode, 15_000, preciseCoords))],
    ['Aldi', timedStoreSearch('Aldi', searchAldiWithTimeout(query, zipcode, 15_000))],
    ['Albertsons', timedStoreSearch('Albertsons', searchAlbertsonsWithTimeout(query, zipcode, 15_000, preciseCoords))],
    ['Harris Teeter', timedStoreSearch('Harris Teeter', searchHarrisTeeterWithTimeout(query, zipcode, 15_000, preciseCoords))],
    ['Tom Thumb', timedStoreSearch('Tom Thumb', searchTomThumbWithTimeout(query, zipcode, 15_000, preciseCoords))],
    ['Whole Foods Market', timedStoreSearch('Whole Foods Market', searchWholeFoodsWithTimeout(query, zipcode, 15_000, preciseCoords))],
    ['Publix', timedStoreSearch('Publix', searchPublixWithTimeout(query, zipcode, 15_000, preciseCoords))],
  ];

  for (const [store, promise] of storeCalls) {
    promise.then(
      (raw) => {
        const products = classifyStoreProducts(store, raw, query, rawQuery, searchId);
        const status: SessionStoreState['status'] =
          products.length === 0 && UNAVAILABLE_STORES.has(store) ? 'unavailable' : 'success';
        session.storeState.set(store, { status, products });
      },
      (err) => {
        console.warn(`[Search] ${store} error:`, err);
        session.storeState.set(store, { status: 'error', products: [], error: String(err) });
        perfLog('search:store-funnel', {
          store, query: rawQuery, queryUsed: query,
          rawCount: 0, afterFoodFilter: 0, afterRelevanceFilter: 0, finalCount: 0, error: true, searchId,
        });
      },
    );
  }

  // Excludes UNAVAILABLE_STORES (Albertsons, Tom Thumb) — they resolve
  // near-instantly with an empty array (no real network call), so left in
  // the race, one of them would trivially "win" as the first-settled store
  // on every single search, making this function return in milliseconds
  // with EVERY real store still 'pending' and zero products — technically
  // honoring "return on first settle," but defeating the entire point of
  // it (showing a shopper their first REAL result as soon as it's ready).
  const raceableStoreCalls = storeCalls.filter(([store]) => !UNAVAILABLE_STORES.has(store));
  const firstSettled = Promise.race(raceableStoreCalls.map(([, p]) => p.then(() => undefined, () => undefined)));
  let budgetTimer: ReturnType<typeof setTimeout>;
  const budgetElapsed = new Promise<void>(resolve => {
    budgetTimer = setTimeout(resolve, SEARCH_RESPONSE_BUDGET_MS);
  });
  await Promise.race([firstSettled, budgetElapsed]);
  clearTimeout(budgetTimer!);

  const response = buildSnapshotResponse(session);
  const storeSummary = {
    success: response.storeStatuses.filter(s => s.status === 'success').length,
    pending: response.storeStatuses.filter(s => s.status === 'pending').length,
    error: response.storeStatuses.filter(s => s.status === 'error').length,
    unavailable: response.storeStatuses.filter(s => s.status === 'unavailable').length,
  };
  perfLog('search:request-complete', {
    query,
    zipcode,
    ms: Date.now() - requestStart,
    productCount: response.products.length,
    pendingStores: response.storeStatuses.filter(s => s.status === 'pending').map(s => s.store),
    storeSummary,
    searchId,
    mode: 'progressive',
  });
  return response;
}

/**
 * Pure read of a search's current state — never re-runs, re-fetches, or
 * otherwise restarts any store's search. Returns `null` for an unknown or
 * expired `searchId` (never a fabricated empty result), which the route
 * turns into a 404 — the client's own poll-stopping logic treats that the
 * same as "nothing more to learn here."
 */
export function getSearchSnapshot(searchId: string): SearchResponse | null {
  const session = searchSessions.get(searchId);
  if (!session) return null;
  return buildSnapshotResponse(session);
}
