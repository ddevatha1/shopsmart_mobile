/**
 * The full grocery search pipeline — query correction, all 4 store adapters
 * in parallel, food/relevance filtering, classification/ranking, cross-store
 * image backfill. Extracted out of routes/search.ts so other server-side
 * code (the Smart Shopping Planner's optimizer, one call per grocery-list
 * item) can call `performSearch` directly instead of issuing an HTTP
 * request back to this same server. Mirrors shopsmart_web's
 * src/services/searchService.ts (same split, same reasoning) — ported here
 * for shopsmart_mobile's independent backend.
 */
import type { ApiProduct, SearchResponse, StoreStatus } from '../types/index.ts';
import { searchSproutsWithTimeout } from './sproutsLiveScraper.ts';
import { searchKrogerWithTimeout } from './krogerLiveScraper.ts';
import { searchTraderJoesWithTimeout } from './traderJoesLiveScraper.ts';
import { searchAldiWithTimeout } from './aldiLiveScraper.ts';
import { correctQuery, logQueryCorrection } from './queryCorrection.ts';
import { perfLog } from '../utils/perfLog.ts';
import { getBackendReadiness } from './warmupService.ts';

type StoreName = ApiProduct['store'];

const ALL_STORES: StoreName[] = ["Trader Joe's", 'Sprouts', 'Kroger', 'Aldi'];

// ─── Relevance scoring ───────────────────────────────────────────────────
// Words that don't define what a product IS — strip these when ranking.
const FILLER_WORDS = new Set([
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

function isUnitOrPackagingWord(word: string): boolean {
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

function computeRelevance(query: string, name: string): number {
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

function classifyMatch(query: string, product: ApiProduct): 'direct' | 'related' {
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

function singularize(word: string): string {
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

// `searchId` is optional and trailing on both this function and
// `raceAgainstResponseBudget` below purely so every existing positional
// call site (including this file's own tests, which predate `searchId`)
// keeps working unchanged — omitting it just omits the field from the
// logged event rather than breaking anything.
function timedStoreSearch<T>(store: string, promise: Promise<T>, searchId?: string): Promise<T> {
  const start = Date.now();
  perfLog('search:store-start', { store, searchId });
  return promise.then(
    (value) => {
      perfLog('search:store-complete', { store, ok: true, ms: Date.now() - start, searchId });
      return value;
    },
    (err) => {
      perfLog('search:store-complete', { store, ok: false, ms: Date.now() - start, searchId });
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
// timeout happened to be largest, even though the other stores had
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
// populated for that shopper's very next search.
export const SEARCH_RESPONSE_BUDGET_MS = 10_000;

export type StoreOutcome<T> = PromiseSettledResult<T> | { status: 'pending' };

export function raceAgainstResponseBudget<T>(
  store: string,
  promise: Promise<T>,
  budgetMs: number = SEARCH_RESPONSE_BUDGET_MS,
  // Trailing/optional — see timedStoreSearch's own comment on why. Its one
  // job here: let a `search:store-late-complete` event (which can fire
  // seconds after the response that produced the original 'pending' has
  // already gone out) still be joined back to that exact search.
  searchId?: string,
): Promise<StoreOutcome<T>> {
  const settleStart = Date.now();
  const settled: Promise<StoreOutcome<T>> = promise.then(
    (value): StoreOutcome<T> => ({ status: 'fulfilled', value }),
    (reason): StoreOutcome<T> => ({ status: 'rejected', reason }),
  );
  return new Promise((resolve) => {
    let settledFirst = false;
    // Cleared the moment the store settles first — the common, warmed-up
    // case. Without this, every store that finishes well under budget
    // still leaves a live timer sitting in Node's timer table for the
    // rest of the budget window for nothing; under real concurrent search
    // volume that's several dangling timers per request that did nothing
    // but wait to no-op.
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
          searchId,
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

/**
 * The full search pipeline as a plain in-process function — the same logic
 * routes/search.ts's `handleSearch` runs, callable directly by other
 * server-side code (the Smart Shopping Planner's optimizer). `noCorrect`
 * mirrors the route's own request body flag.
 */
export async function performSearch(
  rawQuery: string,
  zipcode: string,
  options?: { noCorrect?: boolean },
): Promise<SearchResponse> {
  const requestStart = Date.now();
  // A short, per-invocation correlation id — attached to every perfLog
  // event this one search produces, including `search:store-late-complete`,
  // which can fire seconds after this function has already returned (see
  // raceAgainstResponseBudget). Without it, a late-complete event could
  // only be tied back to "some search for this store, roughly around this
  // time" instead of the exact search that reported it 'pending'.
  // `crypto.randomUUID()` is already used elsewhere in this codebase
  // (aldiLiveScraper.ts/sproutsLiveScraper.ts) as a global, no import
  // needed — sliced to 8 chars purely to keep log lines short; this is a
  // correlation id, not a security token, so collision risk here is a
  // non-issue at this app's real request volume.
  const searchId = crypto.randomUUID().slice(0, 8);
  // Captured once, right at the start of the search, from the same
  // readiness snapshot /api/warmup itself reads — never triggers or waits
  // on warm-up work, just reports whatever the current real state already
  // is for this zip. Lets a cold/warming search be told apart from a warm
  // one after the fact, without guessing from latency alone.
  const warmupStatus = getBackendReadiness(zipcode).status;
  perfLog('search:request-start', { query: rawQuery, zipcode, searchId });

  const correctionStart = Date.now();
  const correction = options?.noCorrect
    ? { original: rawQuery, normalized: rawQuery.trim(), corrected: rawQuery.trim(), correctedDisplay: rawQuery.trim(), confidence: 1, level: 'none' as const, method: 'skipped-by-request' }
    : correctQuery(rawQuery);
  logQueryCorrection(correction);
  perfLog('search:query-correction', { ms: Date.now() - correctionStart, level: correction.level, searchId });
  const query = correction.level === 'none' ? correction.normalized : correction.corrected;

  // Each store's own promise still carries its own individual timeout
  // (below) as a background safety net — `raceAgainstResponseBudget` is
  // what actually bounds how long THIS response waits: every store gets
  // SEARCH_RESPONSE_BUDGET_MS to settle, and one that's still running past
  // that comes back as 'pending' instead of holding up the other stores'
  // already-ready results. See raceAgainstResponseBudget's own header
  // comment for the full reasoning. Budget itself is unchanged here — the
  // explicit `SEARCH_RESPONSE_BUDGET_MS` argument (rather than relying on
  // the default) exists only because `searchId` is the next positional
  // argument after it.
  const [traderJoesResult, sproutsResult, krogerResult, aldiResult] = await Promise.all([
    raceAgainstResponseBudget("Trader Joe's", timedStoreSearch("Trader Joe's", searchTraderJoesWithTimeout(query, zipcode, 45_000), searchId), SEARCH_RESPONSE_BUDGET_MS, searchId), // still browser-based; includes storefront visit on first run
    raceAgainstResponseBudget('Sprouts', timedStoreSearch('Sprouts', searchSproutsWithTimeout(query, zipcode, 15_000), searchId), SEARCH_RESPONSE_BUDGET_MS, searchId), // plain GraphQL API, no browser
    raceAgainstResponseBudget('Kroger', timedStoreSearch('Kroger', searchKrogerWithTimeout(query, zipcode, 15_000), searchId), SEARCH_RESPONSE_BUDGET_MS, searchId), // REST API, no browser
    raceAgainstResponseBudget('Aldi', timedStoreSearch('Aldi', searchAldiWithTimeout(query, zipcode, 15_000), searchId), SEARCH_RESPONSE_BUDGET_MS, searchId), // GraphQL API, no browser
  ]);

  const aggregateStart = Date.now();
  perfLog('search:aggregate-start', { searchId });

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
        rawCount: 0, afterFoodFilter: 0, afterRelevanceFilter: 0, finalCount: 0, pending: true, searchId,
      });
      return;
    }
    if (result.status !== 'fulfilled') {
      storeErrors.set(store, String(result.reason));
      console.warn(`[Search] ${store} error:`, result.reason);
      perfLog('search:store-funnel', {
        store, query: rawQuery, queryUsed: searchQuery,
        rawCount: 0, afterFoodFilter: 0, afterRelevanceFilter: 0, finalCount: 0, error: true, searchId,
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
      searchId,
    });
  }

  collectStoreResult("Trader Joe's", traderJoesResult, query);
  collectStoreResult('Sprouts', sproutsResult, query);
  collectStoreResult('Kroger', krogerResult, query);
  collectStoreResult('Aldi', aldiResult, query);

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
    return {
      store,
      status: products.length > 0 ? 'success' : 'error',
      count: products.length,
      error: products.length === 0 ? (storeErrors.get(store) ?? 'No results found.') : undefined,
    };
  });

  // Purely a count of the SAME `storeStatuses` computed above, restated as
  // a compact object for observability — never changes what's sent back to
  // the client (that's still `storeStatuses` itself, untouched). Lets
  // "what % of searches had all 4 stores succeed" / "3 of 4" / "≤2 of 4"
  // be answered directly from `search:request-complete` log lines instead
  // of parsing `pendingStores` and cross-referencing per-store error state
  // by hand.
  const storeSummary = {
    success: storeStatuses.filter(s => s.status === 'success').length,
    pending: storeStatuses.filter(s => s.status === 'pending').length,
    error: storeStatuses.filter(s => s.status === 'error').length,
  };

  const scored: ScoredProduct[] = ALL_STORES.flatMap(store => storeMap.get(store) ?? []);

  scored.sort((a, b) => {
    if (a.product.matchType !== b.product.matchType) {
      return a.product.matchType === 'direct' ? -1 : 1;
    }
    if (a.relevance !== b.relevance) return b.relevance - a.relevance;
    return a.product.price - b.product.price;
  });

  const response: SearchResponse = {
    products: backfillImagesFromSiblings(scored.map(s => s.product)),
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
  perfLog('search:aggregate-complete', { ms: Date.now() - aggregateStart, productCount: response.products.length, searchId });
  perfLog('search:request-complete', {
    query,
    zipcode,
    ms: Date.now() - requestStart,
    productCount: response.products.length,
    pendingStores: pendingStores.size > 0 ? [...pendingStores] : undefined,
    storeSummary,
    warmupStatus,
    searchId,
  });
  return response;
}
