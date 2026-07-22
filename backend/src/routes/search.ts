/**
 * POST /api/search — ported from shopsmart_web's src/app/api/search/route.ts
 * so shopsmart_mobile has its own backend, independent of shopsmart_web.
 * Relevance scoring, food filtering, and store fan-out are unchanged.
 */
import type { Request, Response } from 'express';
import type { ApiProduct, SearchResponse, StoreStatus } from '../types/index.ts';
import { searchSproutsWithTimeout } from '../services/sproutsLiveScraper.ts';
import { searchKrogerWithTimeout } from '../services/krogerLiveScraper.ts';
import { searchTraderJoesWithTimeout } from '../services/traderJoesLiveScraper.ts';
import { searchAldiWithTimeout } from '../services/aldiLiveScraper.ts';
import { correctQuery, logQueryCorrection } from '../services/queryCorrection.ts';
import { perfLog } from '../utils/perfLog.ts';

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
  // Fraction/multiplier words that only ever modify a unit above them
  // ("Half Gallon", "Half Pint", "Double Pack") — a closed class, not a
  // product-type word.
  'half', 'quarter', 'double', 'triple',
]);

function isUnitOrPackagingWord(word: string): boolean {
  if (UNIT_OR_PACKAGING_WORDS.has(word) || UNIT_OR_PACKAGING_WORDS.has(singularize(word))) return true;
  if (/^\d+(\.\d+)?%?$/.test(word)) return true; // bare quantity, e.g. "4", "16"
  // Fused quantity+unit with no space, e.g. "3lb", "16fl" (a following "oz"
  // token is matched separately).
  const fused = word.match(/^\d+(?:\.\d+)?([a-z]+)$/);
  return fused != null && UNIT_OR_PACKAGING_WORDS.has(fused[1]);
}

// Meat/produce cut, form, and preparation words. Like units, this is a
// closed, centuries-old vocabulary that doesn't grow the way product
// categories do — "Chicken Breast" and "Chicken Drumsticks" are still
// chicken, just a specific cut, the same way "Sliced Bananas" are still
// bananas.
const CUT_OR_FORM_WORDS = new Set([
  'breast', 'breasts', 'thigh', 'thighs', 'drumstick', 'drumsticks', 'wing', 'wings',
  'leg', 'legs', 'tenderloin', 'tenderloins', 'fillet', 'fillets', 'cutlet', 'cutlets',
  'strip', 'strips', 'ground', 'whole', 'sliced', 'diced', 'chopped', 'shredded',
  'minced', 'cubed', 'grated', 'peeled', 'crushed', 'halved', 'quartered',
]);

function isCutOrFormWord(word: string): boolean {
  return CUT_OR_FORM_WORDS.has(word) || CUT_OR_FORM_WORDS.has(singularize(word));
}

// Well-known substitute/alternative bases for common animal products —
// small and stable (these ingredients don't multiply the way snack
// products do), unlike an open-ended list of product types. When one of
// these precedes the query's head noun, the product is built on a
// *different* base ingredient than what was searched for (e.g. "Coconut
// Milk" is a coconut product before it's a milk product) — unless the
// query itself named that base, in which case it's exactly what was asked
// for.
const ALTERNATIVE_BASE_WORDS = new Set([
  'coconut', 'almond', 'oat', 'soy', 'cashew', 'rice', 'hemp', 'pea', 'macadamia', 'flax', 'walnut',
]);

function isAlternativeBaseWord(word: string): boolean {
  return ALTERNATIVE_BASE_WORDS.has(word) || ALTERNATIVE_BASE_WORDS.has(singularize(word));
}

// ─── NLP word similarity ─────────────────────────────────────────────────
// Sørensen–Dice bigram coefficient: a standard text-similarity measure that
// tolerates typos and irregular plurals (e.g. "tomato" vs "tomatoes",
// "leaf" vs "leaves") without treating unrelated words as matches.
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

// True if two words denote the same concept: identical, simple plural, or
// similar enough (typo/irregular plural) per Dice coefficient. Deliberately
// strict — "milk" and "cream" score 0, so they are never treated as a match.
export function wordsMatch(a: string, b: string): boolean {
  if (a === b || a === b + 's' || b === a + 's') return true;
  return diceCoefficient(a, b) >= WORD_SIMILARITY_THRESHOLD;
}

/**
 * Semantic query expansion — a curated, closed-class dictionary (same
 * spirit as FILLER_WORDS/CUT_OR_FORM_WORDS above) letting a category or
 * meal query surface the specific products a shopper actually means,
 * instead of requiring literal word overlap. Two kinds of entry:
 *  - 'direct': the synonyms ARE the thing asked for — "pasta" means
 *    spaghetti, penne, etc., so those should surface as primary results,
 *    same tier as a literal name match.
 *  - 'related': the synonyms are components/ingredients FOR the thing
 *    asked for, not the thing itself — "Ground Beef" isn't a burger, it's
 *    part of one — so these stay in the secondary "related" tier exactly
 *    like any other ingredient-not-product match.
 */
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

/** True if `qWord` matches `nWord` either literally/fuzzily, or via a
 * curated category-expansion synonym. Purely additive over `wordsMatch` —
 * a query word with no expansion entry behaves identically to before. */
function wordMatchesQueryTerm(nWord: string, qWord: string): boolean {
  if (wordsMatch(nWord, qWord)) return true;
  const expansion = CATEGORY_EXPANSIONS[qWord];
  return expansion != null && expansion.synonyms.some(syn => wordsMatch(nWord, syn));
}

function queryWordDirectlyMatches(nWords: string[], qWord: string): boolean {
  return nWords.some(nw => wordsMatch(nw, qWord));
}

/** The matchType to fall back to when a product only matched a query word
 * through expansion (never a literal/fuzzy match) — see CATEGORY_EXPANSIONS. */
function expansionFallbackMatchType(qWords: string[]): 'direct' | 'related' | null {
  for (const qw of qWords) {
    const expansion = CATEGORY_EXPANSIONS[qw];
    if (expansion) return expansion.matchType;
  }
  return null;
}

// Fraction of query words that have a matching word in the product name.
function queryCoverage(qWords: string[], nWords: string[]): number {
  const present = qWords.filter(qw => nWords.some(nw => wordMatchesQueryTerm(nw, qw)));
  return present.length / qWords.length;
}

// Splits on whitespace, any dash variant (ASCII hyphen, en dash, em dash —
// store product titles use all three, e.g. "Large Fuji Apple – Each"),
// slashes, commas, and parens; trailing periods are stripped per-token so
// abbreviations ("16 Fl. Oz.") match their unit-word form ("fl", "oz")
// without also mangling decimals like "2.5" (only a *trailing* period is
// stripped, not one in the middle of a token). Anything else (including
// "&") survives as its own token, which hasDifferentHeadNoun relies on.
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

/**
 * True if the product name shares at least one real word with the query.
 * Used to exclude products a store's own search returned that aren't
 * actually about what was searched for (e.g. "milk" pulling in "Chocolate
 * Whipped Light Cream" — no word overlap, so it should never surface).
 */
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

/**
 * True when a word before the query's head-noun match names a different
 * base ingredient the product is actually built on — "Coconut Milk" for
 * query "milk" — unless the query itself asked for that base ("coconut
 * milk"), in which case it's exactly what was requested. Exposed
 * separately from hasDifferentHeadNoun so selectStoreProducts can also use
 * it to recognize *which* related items are dairy-style alternatives
 * worth falling back to when direct matches are scarce (see below).
 */
function isAlternativeBaseVariant(qWords: string[], nWords: string[]): boolean {
  const lastMatchIdx = lastQueryMatchIndex(qWords, nWords);
  if (lastMatchIdx === -1) return false;
  return nWords
    .slice(0, lastMatchIdx)
    .some(w => isAlternativeBaseWord(w) && !qWords.some(qw => wordsMatch(qw, w)));
}

/**
 * True when the query term modifies a *different* head noun rather than
 * naming the product itself — operates on the raw (unfiltered) word
 * sequence so it can see filler words like "with" that carry a real
 * structural signal even though they're ignored everywhere else. Five
 * patterns, all closed-class checks rather than an ever-incomplete list of
 * product-type nouns:
 *
 *  - A different base ingredient precedes the match ("Coconut Milk" for
 *    query "milk" — see isAlternativeBaseVariant).
 *  - "with" appears anywhere before the match ("Almondmilk Blended with
 *    Real Bananas" — bananas is an added ingredient, not the product).
 *  - The match is immediately preceded by "&" ("Apple, Raspberries &
 *    Avocado" — the last item in an enumerated ingredient list).
 *  - Scanning what trails the match (skipping filler/unit words), the
 *    first substantive word is neither a unit/packaging word nor a
 *    recognized cut/form word ("Avocado Veggie Straws" — a kind of Straws,
 *    not a kind of Avocado; English noun compounds are right-headed).
 *  - A recognized cut/form word ("Chicken Breast", "Chicken Drumsticks")
 *    stops the scan and counts as still the same product — anything past
 *    it (e.g. "No Antibiotics Ever") is a marketing claim, not a new
 *    product, so it's ignored.
 */
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

/**
 * Returns 0–100: how closely a product name matches the search query.
 * Higher = show first. Secondary sort is price (ascending).
 */
function computeRelevance(query: string, name: string): number {
  const q = query.toLowerCase().trim();
  const n = name.toLowerCase().trim();
  const nWords = tokenizeName(n);
  const qWords = tokenizeQuery(q);

  // Exact or near-exact name match (handle plurals both ways)
  const nBase = n.endsWith('s') ? n.slice(0, -1) : n;
  const qBase = q.endsWith('s') ? q.slice(0, -1) : q;
  if (nBase === qBase) return 100;

  // Check what fraction of query words appear in the name
  const coverage = queryCoverage(qWords, nWords);

  if (coverage < 1) {
    // Partial: not all query words found
    return coverage > 0 ? Math.round(coverage * 25) : 0;
  }

  // All query words present — score by position of first match in significant words
  const sigWords = significantWords(nWords);
  const firstSigIdx = Math.max(
    0,
    sigWords.findIndex(nw => qWords.some(qw => wordMatchesQueryTerm(nw, qw))),
  );

  let score = Math.max(35, 85 - firstSigIdx * 12);

  // The query term modifies a different head noun (e.g. "Avocado Veggie
  // Straws" for query "avocado") — score it well below a direct match
  // regardless of query length or where the match falls in the name.
  if (hasDifferentHeadNoun(qWords, nWords)) {
    score = Math.min(score, 50);
  }

  // Bonus for concise names: fewer extra significant words = more direct match
  const extra = sigWords.length - qWords.length;
  if (extra <= 0) score = Math.min(100, score + 10);
  else if (extra === 1) score = Math.min(100, score + 3);

  return score;
}

/**
 * Classifies a product as a 'direct' match (the query names the product
 * itself — whole avocados, milk cartons) or a 'related' one (the query is
 * only an ingredient/flavor/component — avocado veggie straws, milk
 * chocolate). Reuses the same structural head-noun signal as
 * computeRelevance rather than a second, divergent mechanism. A store's own
 * category metadata, when present, can still confirm a direct match even
 * if the name alone reads as a modifier.
 */
function classifyMatch(query: string, product: ApiProduct): 'direct' | 'related' {
  const q = query.toLowerCase().trim();
  const n = product.name.toLowerCase().trim();
  const nWords = tokenizeName(n);
  const qWords = tokenizeQuery(q);

  const nBase = n.endsWith('s') ? n.slice(0, -1) : n;
  const qBase = q.endsWith('s') ? q.slice(0, -1) : q;
  if (nBase === qBase) return 'direct';

  if (queryCoverage(qWords, nWords) < 1) return 'related';

  // Every query word matched a real word in the name — normal path,
  // unchanged from before expansion existed. Whenever a word only matched
  // via a category expansion (see CATEGORY_EXPANSIONS), skip the
  // structural head-noun analysis (built for literal-word matches) and
  // use that expansion's own direct/related classification instead.
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

// ─── Per-store diversity & de-duplication ────────────────────────────────
// A pure size grade or measurement unit doesn't make two listings
// meaningfully different products to a shopper (unlike organic status,
// brand, variety, or packaging *format*, which do) — e.g. "Hass Avocado
// Small/Medium/Large" is one product at three sizes, not three products.
// Stripped when building a de-duplication signature; container/format
// words (bag, box, bunch, ...) are deliberately NOT in this set.
const SIZE_OR_MEASURE_WORDS = new Set([
  'small', 'medium', 'large', 'mini', 'giant', 'jumbo', 'extra', 'super', 'petite',
  'oz', 'fl', 'lb', 'lbs', 'g', 'gram', 'grams', 'kg', 'ml', 'l', 'liter', 'liters',
  'gal', 'gallon', 'qt', 'quart', 'pt', 'pint', 'ct', 'count',
]);

function singularize(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

/**
 * A canonical signature for "is this essentially the same listing as that
 * one" — two names that reduce to the same signature differ only by size,
 * a bare measurement, or word order, not by anything a shopper would
 * consider a different product. "Organic" is kept (it's a real
 * differentiator, unlike "medium"); FILLER_WORDS (fresh, premium, artisan,
 * ...) and bare quantities are stripped the same way relevance scoring
 * already ignores them.
 */
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

// A conservative "is this the same product" check for backfilling images —
// deliberately stricter than dedupSignature or relevance matching. Every
// word of the shorter name must appear in the longer one (fuzzy-matched
// for plurals/typos), so "Organic Valley Whole Milk" ⊆ "Organic Valley
// Whole Milk Half Gallon" passes, but "Sprouts Organic Whole Milk" vs.
// "Simple Truth Organic Whole Milk" correctly fails (their brand words
// never match) despite sharing "organic whole milk". A minimum length
// guard keeps a short generic name (rare in practice — every real listing
// so far has carried a brand prefix) from matching too loosely.
export function isSameProductName(nameA: string, nameB: string): boolean {
  const wordsA = tokenizeName(nameA);
  const wordsB = tokenizeName(nameB);
  const [shorter, longer] = wordsA.length <= wordsB.length ? [wordsA, wordsB] : [wordsB, wordsA];
  if (shorter.length < 3) return false;
  return shorter.every(w => longer.some(w2 => wordsMatch(w, w2)));
}

/**
 * Some stores (Sprouts, in practice) sometimes omit a product photo that
 * another store's listing for the same underlying product — already
 * fetched in this very response — already has (e.g. Sprouts' "Organic
 * Valley Whole Milk" vs. Kroger's "Organic Valley Whole Milk Half
 * Gallon"). Backfilling from that sibling is free, instant, and exact —
 * the real catalog photo the other store uses — so it runs before any
 * external image lookup is ever attempted (see productImage.ts, which
 * only ever sees whatever's still missing after this).
 */
function backfillImagesFromSiblings(products: ApiProduct[]): ApiProduct[] {
  const withImages = products.filter(p => p.image_url);
  return products.map(p => {
    if (p.image_url) return p;
    const sibling = withImages.find(other => isSameProductName(p.name, other.name));
    return sibling ? { ...p, image_url: sibling.image_url } : p;
  });
}

// Not a display cap — display shows every legitimate match a store has.
// This is only the floor selectStoreProducts tries to backfill with
// well-known alternative-base items (see below) when genuine direct
// matches are scarce, so a store never comes up completely empty just
// because it only carries oat milk, not dairy.
const MIN_DIRECT_TARGET = 2;

interface ScoredProduct {
  product: ApiProduct; // matchType already set
  relevance: number;
}

/**
 * Turns a store's raw (already food + relevance filtered) candidates into
 * the set actually shown for that store: classifies and scores each once,
 * ranks direct matches before related ones, then keeps only the best
 * listing per de-dup signature — so near-identical size variants collapse
 * to one while genuinely distinct variants (organic, variety, packaging
 * format) all survive. No cap on how many are returned — every distinct,
 * legitimate match is included, direct or related.
 *
 * The one exception: if a store's direct bucket is very thin, the best
 * alternative-base related items (e.g. oat/almond milk when there's no
 * dairy milk) get promoted into direct rather than leaving the store's
 * primary results empty. Only alternative-base demotions are eligible —
 * a tangential match (veggie straws, ramen) is never promoted just to pad
 * the count, per "quality over quantity."
 */
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

// ─── Food-only filter ───────────────────────────────────────────────────────
// Name-only food check — used to screen out non-grocery items from the live
// scraper/API results (Sprouts, Kroger, Trader Joe's).
const NON_FOOD_NAME_KEYWORDS = [
  'shampoo', 'conditioner', 'detergent', 'laundry', 'bleach', 'disinfect',
  'deodorant', 'lotion', 'moisturizer', 'sunscreen', 'toothpaste', 'mouthwash',
  'fertilizer', 'dog food', 'cat food', 'pet food',
  // Paper & household goods
  'toilet paper', 'paper towel', 'facial tissue', 'napkin', 'diaper', 'baby wipe',
  'wet wipe', 'dish soap', 'dishwasher detergent', 'fabric softener', 'stain remover',
  'air freshener', 'scented candle', 'trash bag', 'garbage bag', 'aluminum foil',
  'plastic wrap', 'parchment paper', 'storage bag',
  // Personal care & health
  'shaving cream', 'razor blade', 'soap', 'beauty bar', 'cleansing bar',
  'body wash', 'hand sanitizer',
  'first aid', 'bandage', 'multivitamin', 'dietary supplement', 'protein supplement',
  // Pet supplies
  'dog treat', 'cat treat', 'kitty litter', 'cat litter',
  // Cleaning supplies
  'all-purpose cleaner', 'glass cleaner', 'floor cleaner', 'bathroom cleaner',
  'toilet bowl cleaner',
  // Misc non-grocery
  'paper plate', 'paper cup', 'greeting card', 'gift card', 'magazine',
];

function isFoodProductName(name: string): boolean {
  const lower = name.toLowerCase();
  return !NON_FOOD_NAME_KEYWORDS.some(kw => lower.includes(kw));
}

// ─── Route handler ────────────────────────────────────────────────────────────
// A product missing an image (the live scrapers don't always capture one)
// is left as-is here — the mobile app's ProductImage component handles
// fallback client-side now (a real photo lookup via a product-image API,
// cached on-device, with a category icon as the last resort), which finds
// a better match than a generic keyword-matched category graphic would.

// Wraps a store's search promise with start/end instrumentation — every
// call is timed individually (not just the overall request) so a slow
// store is identifiable in logs regardless of how the other three perform,
// and so first-search-vs-later comparisons can be made per store, not just
// in aggregate.
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

export async function handleSearch(req: Request, res: Response): Promise<void> {
  const body = req.body as { query?: string; zipcode?: string; noCorrect?: boolean };

  const rawQuery = body.query?.trim();
  const zipcode = body.zipcode?.trim();

  if (!rawQuery || !zipcode) {
    res.status(400).json({ error: '`query` and `zipcode` are required.' });
    return;
  }

  if (!/^\d{5}$/.test(zipcode)) {
    res.status(400).json({ error: '`zipcode` must be a 5-digit US zip code.' });
    return;
  }

  const requestStart = Date.now();
  perfLog('search:request-start', { query: rawQuery, zipcode });

  // Query preprocessing: normalize + typo-correct before any store API is
  // called. Pure in-memory string comparison against a small vocabulary —
  // microseconds, not milliseconds (see queryCorrection.ts) — so this stage
  // is never the explanation for a slow search, but it's timed anyway so a
  // future regression here is immediately visible in the same place as
  // every other stage.
  const correctionStart = Date.now();
  const correction = body.noCorrect
    ? { original: rawQuery, normalized: rawQuery.trim(), corrected: rawQuery.trim(), correctedDisplay: rawQuery.trim(), confidence: 1, level: 'none' as const, method: 'skipped-by-request' }
    : correctQuery(rawQuery);
  logQueryCorrection(correction);
  perfLog('search:query-correction', { ms: Date.now() - correctionStart, level: correction.level });
  const query = correction.level === 'none' ? correction.normalized : correction.corrected;

  // Run the live Trader Joe's scraper, live Sprouts scraper, live Kroger API,
  // and live Aldi API in parallel.
  // Total latency = max(traderJoesTime, sproutsTime, krogerTime, aldiTime).
  const [traderJoesResult, sproutsResult, krogerResult, aldiResult] = await Promise.allSettled([
    timedStoreSearch("Trader Joe's", searchTraderJoesWithTimeout(query, zipcode, 45_000)), // still browser-based; includes storefront visit on first run
    timedStoreSearch('Sprouts', searchSproutsWithTimeout(query, zipcode, 15_000)), // plain GraphQL API, no browser
    timedStoreSearch('Kroger', searchKrogerWithTimeout(query, zipcode, 15_000)), // REST API, no browser
    timedStoreSearch('Aldi', searchAldiWithTimeout(query, zipcode, 15_000)), // GraphQL API, no browser
  ]);

  const aggregateStart = Date.now();
  perfLog('search:aggregate-start', {});

  const storeMap = new Map<StoreName, ScoredProduct[]>();
  const storeErrors = new Map<StoreName, string>();

  // Each store's raw hits go through the same pipeline: food-only, then
  // "shares a real word with the query" filters (unchanged), then
  // selectStoreProducts (classify, score, diversify, cap — see above),
  // which also bakes in matchType and relevance so the final merge below
  // doesn't need to recompute either.
  // Per-store retrieval funnel — logs exactly how many products survive
  // each filtering stage and, critically, *which* products were dropped
  // and why, so a "global search is missing products the single-store
  // search finds" regression is immediately diagnosable from these logs
  // alone rather than requiring a fresh investigation each time.
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

  const storeStatuses: StoreStatus[] = ALL_STORES.map(store => {
    const products = storeMap.get(store) ?? [];
    return {
      store,
      status: products.length > 0 ? 'success' : 'error',
      count: products.length,
      error: products.length === 0 ? (storeErrors.get(store) ?? 'No results found.') : undefined,
    };
  });

  const scored: ScoredProduct[] = ALL_STORES.flatMap(store => storeMap.get(store) ?? []);

  // Direct matches first, then related; within each, higher relevance
  // first, then cheaper first.
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
  perfLog('search:aggregate-complete', { ms: Date.now() - aggregateStart, productCount: response.products.length });
  perfLog('search:request-complete', {
    query,
    zipcode,
    ms: Date.now() - requestStart,
    productCount: response.products.length,
  });
  res.json(response);
}
