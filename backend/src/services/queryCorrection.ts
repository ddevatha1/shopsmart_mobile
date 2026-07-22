/**
 * Query normalization + typo correction ("Did you mean") for search.
 *
 * Runs entirely synchronously over a small curated vocabulary — no network
 * call, no ML model — so it adds microseconds, not milliseconds, to the
 * search critical path (see the first-search latency investigation in
 * route.ts's neighboring perfLog calls). Deliberately a standalone module
 * with its own copy of the similarity primitives, same "no shared runtime
 * with the backend" reasoning already documented in comparisonService.ts —
 * there is no runtime shared between this app and shopsmart_mobile's
 * backend, so this file is mirrored there rather than imported.
 */

// ─── Normalization ──────────────────────────────────────────────────────────

/** Trim, collapse duplicate whitespace, and drop stray punctuation while
 * keeping intra-word hyphens/apostrophes (e.g. "extra-virgin", "trader
 * joe's") — the query is otherwise left case-preserved for display; matching
 * below always lowercases separately. */
export function normalizeQuery(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s'-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Grocery vocabulary ─────────────────────────────────────────────────────
// A curated, closed(ish) list — not exhaustive, but broad enough to catch the
// overwhelming majority of common grocery typos. Single words are used for
// per-token correction; PHRASES additionally lets a corrected multi-token
// query gain confidence when it reassembles into a recognized whole (see
// correctQuery's phrase-boost step).

const FRUITS = [
  'apple', 'apples', 'banana', 'bananas', 'orange', 'oranges', 'grape', 'grapes',
  'strawberry', 'strawberries', 'blueberry', 'blueberries', 'raspberry', 'raspberries',
  'blackberry', 'blackberries', 'lemon', 'lemons', 'lime', 'limes', 'watermelon',
  'cantaloupe', 'honeydew', 'pineapple', 'mango', 'mangoes', 'peach', 'peaches',
  'pear', 'pears', 'plum', 'plums', 'cherry', 'cherries', 'kiwi', 'avocado', 'avocados',
  'grapefruit', 'pomegranate', 'apricot', 'apricots', 'nectarine', 'nectarines',
  'fig', 'figs', 'coconut', 'papaya', 'cranberry', 'cranberries',
  // Common apple varieties — real, frequent grocery-search modifiers, not
  // typos of some other word, so they belong in the vocabulary itself
  // rather than being left for the fuzzy matcher to (mis)guess at.
  'gala', 'fuji', 'honeycrisp', 'granny smith', 'braeburn', 'red delicious',
];

const VEGETABLES = [
  'carrot', 'carrots', 'potato', 'potatoes', 'tomato', 'tomatoes', 'onion', 'onions',
  'garlic', 'broccoli', 'cauliflower', 'spinach', 'lettuce', 'kale', 'cabbage',
  'cucumber', 'cucumbers', 'celery', 'pepper', 'peppers', 'mushroom', 'mushrooms',
  'zucchini', 'squash', 'corn', 'peas', 'green beans', 'asparagus', 'eggplant',
  'beet', 'beets', 'radish', 'radishes', 'sweet potato', 'scallion', 'scallions',
  'cilantro', 'parsley', 'ginger', 'bell pepper', 'bell peppers',
];

const MEATS = [
  'chicken', 'beef', 'pork', 'turkey', 'bacon', 'sausage', 'ham', 'steak', 'ground beef',
  'salmon', 'shrimp', 'tuna', 'tilapia', 'cod', 'lamb', 'ribs', 'breast', 'thigh',
  'thighs', 'wings', 'drumstick', 'drumsticks', 'meatball', 'meatballs', 'pepperoni',
  'salami', 'prosciutto', 'brisket', 'tenderloin', 'chicken breast', 'chicken thighs',
  'chicken wings', 'pork chop', 'pork chops',
];

const DAIRY = [
  'milk', 'cheese', 'yogurt', 'butter', 'cream', 'sour cream', 'cream cheese',
  'cottage cheese', 'mozzarella', 'cheddar', 'parmesan', 'egg', 'eggs', 'almond milk',
  'oat milk', 'soy milk', 'half and half', 'whipped cream', 'ice cream',
  'greek yogurt', 'greek',
];

const BEVERAGES = [
  'juice', 'orange juice', 'apple juice', 'water', 'soda', 'coffee', 'tea', 'beer',
  'wine', 'lemonade', 'sparkling water', 'energy drink', 'kombucha', 'smoothie',
  'gatorade', 'seltzer',
];

const PANTRY = [
  'bread', 'rice', 'pasta', 'flour', 'sugar', 'salt', 'pepper corn', 'oil',
  'olive oil', 'vinegar', 'honey', 'peanut butter', 'jelly', 'jam', 'cereal',
  'oatmeal', 'granola', 'crackers', 'chips', 'pretzels', 'popcorn', 'beans',
  'lentils', 'quinoa', 'ketchup', 'mustard', 'mayonnaise', 'salsa', 'soup',
  'broth', 'stock', 'spaghetti', 'noodles', 'tortilla', 'tortillas', 'sauce',
  'syrup', 'maple syrup', 'chocolate', 'cookies', 'nuts', 'almonds', 'cashews', 'walnuts',
  'raisins', 'oats', 'bar', 'bars', 'protein bar', 'granola bar', 'candy bar',
  'sriracha', 'hot sauce', 'soy sauce', 'teriyaki', 'bbq sauce', 'ranch',
  'cinnamon', 'vanilla', 'hummus', 'tofu', 'tempeh', 'kimchi', 'sauerkraut',
  'pickles', 'olives', 'couscous', 'pita',
];

const FROZEN = [
  'frozen pizza', 'frozen vegetables', 'frozen fruit', 'ice cream', 'popsicle',
  'popsicles', 'waffles', 'pancakes', 'fries', 'hash browns', 'dumplings',
  'frozen shrimp', 'frozen chicken',
];

const HOUSEHOLD = [
  'toilet paper', 'paper towel', 'paper towels', 'napkins', 'trash bag', 'trash bags',
  'dish soap', 'laundry detergent', 'detergent', 'fabric softener', 'bleach',
  'sponge', 'sponges', 'aluminum foil', 'plastic wrap', 'ziploc', 'hand sanitizer',
  'hand soap', 'shampoo', 'conditioner', 'toothpaste', 'deodorant',
];

const BRANDS = [
  'kroger', 'aldi', 'sprouts', "trader joe's", 'simple truth', 'organic valley',
  'chobani', 'yoplait', 'oreo', 'lay\'s', 'coca-cola', 'pepsi', 'tropicana',
  'kraft', 'heinz', 'nature valley', 'quaker', 'general mills', 'tostitos',
  'ben & jerry\'s', 'haagen-dazs',
];

/** Single-token vocabulary — every word above, split so multi-word entries
 * still contribute their individual words (e.g. "orange juice" also adds
 * "orange" and "juice" to the single-word set). */
const VOCAB_WORDS: string[] = Array.from(
  new Set(
    [...FRUITS, ...VEGETABLES, ...MEATS, ...DAIRY, ...BEVERAGES, ...PANTRY, ...FROZEN, ...HOUSEHOLD, ...BRANDS]
      .flatMap((entry) => entry.split(' '))
      .map((w) => w.toLowerCase())
      .filter((w) => w.length > 0),
  ),
);

/** Known multi-word phrases — used purely for the phrase-recognition
 * confidence boost, not for per-token correction. */
const VOCAB_PHRASES = new Set(
  [...FRUITS, ...VEGETABLES, ...MEATS, ...DAIRY, ...BEVERAGES, ...PANTRY, ...FROZEN, ...HOUSEHOLD, ...BRANDS]
    .filter((entry) => entry.includes(' '))
    .map((p) => p.toLowerCase()),
);

const VOCAB_WORD_SET = new Set(VOCAB_WORDS);

// Small, closed set of function words that never need correction and never
// count against confidence — same spirit as route.ts's FILLER_WORDS, kept
// separate here since this module has no shared runtime with route.ts.
const FUNCTION_WORDS = new Set(['a', 'an', 'the', 'of', 'and', 'with', 'for', 'in']);

// ─── Similarity primitives ──────────────────────────────────────────────────

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

/** Normalized to 0 (nothing alike) - 1 (identical). */
function levenshteinSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

/** Standard Jaro-Winkler string similarity (0-1) — rewards shared prefixes
 * and transposition-tolerant character overlap, complementing Levenshtein's
 * strict edit count (e.g. "chkien" vs "chicken" scores higher here than a
 * pure edit-distance measure would, since the first two letters agree). */
function jaroSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0 || bLen === 0) return 0;

  const matchDistance = Math.floor(Math.max(aLen, bLen) / 2) - 1;
  const aMatches = new Array<boolean>(aLen).fill(false);
  const bMatches = new Array<boolean>(bLen).fill(false);

  let matches = 0;
  for (let i = 0; i < aLen; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, bLen);
    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < aLen; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }

  return (
    (matches / aLen + matches / bLen + (matches - transpositions / 2) / matches) / 3
  );
}

function jaroWinklerSimilarity(a: string, b: string): number {
  const jaro = jaroSimilarity(a, b);
  let prefixLen = 0;
  const maxPrefix = 4;
  for (let i = 0; i < Math.min(maxPrefix, a.length, b.length); i++) {
    if (a[i] !== b[i]) break;
    prefixLen++;
  }
  return jaro + prefixLen * 0.1 * (1 - jaro);
}

/** Sørensen-Dice bigram coefficient — same measure as route.ts's
 * wordsMatch/diceCoefficient, reimplemented here standalone. */
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

/** Weighted ensemble of the three signals above — no single technique is
 * trusted alone (requirement: "do not rely solely on edit distance"). */
function combinedSimilarity(a: string, b: string): number {
  return (
    0.3 * levenshteinSimilarity(a, b) +
    0.4 * jaroWinklerSimilarity(a, b) +
    0.3 * diceCoefficient(a, b)
  );
}

// ─── Per-token correction ───────────────────────────────────────────────────

const CANDIDATE_FLOOR = 0.5;
// A correction is only accepted when the best candidate is *distinctly*
// better than the runner-up (a real typo tends to have one clear intended
// word) — unless the best score alone is already overwhelming. Without this,
// a legitimate-but-unlisted word that merely happens to be roughly
// equidistant from several vocabulary words (e.g. "gala" sitting between
// "salami"/"salsa"/"garlic") gets "corrected" into whichever one edges out
// by a fraction of a point, which is exactly the wrong-meaning replacement
// requirement #7 rules out.
const AMBIGUITY_MARGIN = 0.05;
const STRONG_MATCH = 0.85;

interface TokenCorrection {
  original: string;
  corrected: string;
  score: number; // 1 when already an exact vocabulary word / function word
  wasCorrected: boolean;
}

function correctToken(token: string): TokenCorrection {
  if (FUNCTION_WORDS.has(token) || VOCAB_WORD_SET.has(token)) {
    return { original: token, corrected: token, score: 1, wasCorrected: false };
  }
  if (token.length < 3) {
    return { original: token, corrected: token, score: 0, wasCorrected: false };
  }

  let best: { word: string; score: number } | null = null;
  let secondBest: { word: string; score: number } | null = null;
  for (const candidate of VOCAB_WORDS) {
    // Cheap length-based prefilter — a candidate whose length differs wildly
    // from the token can't plausibly be a one-or-two-typo correction, and
    // skipping it avoids wasted similarity computation over ~150 words.
    if (Math.abs(candidate.length - token.length) > 3) continue;
    const score = combinedSimilarity(token, candidate);
    if (!best || score > best.score) {
      secondBest = best;
      best = { word: candidate, score };
    } else if (candidate !== best.word && (!secondBest || score > secondBest.score)) {
      secondBest = { word: candidate, score };
    }
  }

  if (!best || best.score < CANDIDATE_FLOOR) {
    // No confident candidate — leave the token untouched rather than
    // guessing (requirement: never silently replace a query with a
    // completely different meaning). It simply doesn't contribute to
    // confidence.
    return { original: token, corrected: token, score: 0, wasCorrected: false };
  }

  const distinct = best.score >= STRONG_MATCH || !secondBest || best.score - secondBest.score >= AMBIGUITY_MARGIN;
  if (!distinct) {
    return { original: token, corrected: token, score: 0, wasCorrected: false };
  }

  return { original: token, corrected: best.word, score: best.score, wasCorrected: best.word !== token };
}

// ─── Public API ──────────────────────────────────────────────────────────

export type CorrectionLevel = 'none' | 'moderate' | 'high';

export interface QueryCorrectionResult {
  original: string;
  normalized: string;
  corrected: string;
  correctedDisplay: string;
  confidence: number;
  level: CorrectionLevel;
  method: string;
}

const HIGH_THRESHOLD = 0.75;
const LOW_THRESHOLD = 0.55;
const PHRASE_BOOST = 0.15;
const MAX_CONFIDENCE = 0.97;

export function correctQuery(raw: string): QueryCorrectionResult {
  const normalized = normalizeQuery(raw);
  const lower = normalized.toLowerCase();
  const tokens = lower.split(' ').filter(Boolean);

  const corrections = tokens.map(correctToken);
  const anyCorrected = corrections.some((c) => c.wasCorrected);

  if (!anyCorrected) {
    return {
      original: raw,
      normalized,
      corrected: normalized,
      correctedDisplay: normalized,
      confidence: 1,
      level: 'none',
      method: 'none-needed',
    };
  }

  const correctedPhrase = corrections.map((c) => c.corrected).join(' ');
  // Only average the tokens that actually needed a look — an
  // already-correct token (score 1) shouldn't be allowed to dilute a
  // genuinely uncertain correction elsewhere in the same query, nor should
  // an unrecognized, left-alone token (score 0, e.g. a brand name not in the
  // vocabulary) drag down an otherwise-confident correction of its neighbor.
  const consideredScores = corrections.filter((c) => c.wasCorrected).map((c) => c.score);
  let confidence = consideredScores.reduce((sum, s) => sum + s, 0) / consideredScores.length;

  const methods = ['levenshtein', 'jaro-winkler', 'token-dice'];
  // Only a boost when correcting *multiple* tokens happens to reassemble a
  // recognized multi-word phrase — real independent corroboration. For a
  // single-token query this would be a tautology (correctToken can only
  // ever "correct" a word into another vocabulary word by construction), so
  // it must not fire there.
  if (tokens.length > 1 && VOCAB_PHRASES.has(correctedPhrase)) {
    confidence = Math.min(MAX_CONFIDENCE, confidence + PHRASE_BOOST);
    methods.push('vocabulary-phrase-match');
  }
  confidence = Math.min(MAX_CONFIDENCE, confidence);

  const level: CorrectionLevel = confidence >= HIGH_THRESHOLD ? 'high' : confidence >= LOW_THRESHOLD ? 'moderate' : 'none';

  const result: QueryCorrectionResult = {
    original: raw,
    normalized,
    corrected: level === 'none' ? normalized : correctedPhrase,
    correctedDisplay: level === 'none' ? normalized : titleCase(correctedPhrase),
    confidence: level === 'none' ? 1 : Math.round(confidence * 100) / 100,
    level,
    method: level === 'none' ? 'below-confidence-floor' : methods.join('+'),
  };
  return result;
}

/** One traceable log line per request — always fires, even for `level:
 * 'none'`, so non-corrections are visible too (requirement: log original,
 * corrected, confidence, method used). */
export function logQueryCorrection(result: QueryCorrectionResult): void {
  console.log(
    `[QueryCorrection] original="${result.original}" corrected="${result.corrected}" ` +
      `confidence=${result.confidence} level=${result.level} method="${result.method}"`,
  );
}
