import type { ApiProduct, StoreName } from '../models/types';
import { categorizeProduct, type GroceryCategory } from './groceryCategoryService';
import { isOrganicProduct } from '../utils/filterProducts';
import { haversineDistanceMiles } from '../utils/geo';
import type { Coordinates } from './locationService';
import { findTaxonomyEntry, classifyProductSubtype, type TaxonomyEntry } from '../data/groceryTaxonomy';

/**
 * The comparison engine: turns the flat, per-store `ApiProduct[]` list
 * `/api/search` returns into (1) semantic product groups — "Fuji Apples"
 * regardless of which store carries it — and (2) a per-store, unit-price
 * ranked comparison within one group. Entirely client-side, same pattern as
 * every other "intelligence" layer in this app (advisorService,
 * substitutionService, priceHistoryService) — there's no backend database to
 * persist a canonical product catalog in, so this is recomputed from
 * whatever a search response actually contains, same as everything else.
 */

// ─── Semantic grouping ────────────────────────────────────────────────────

// Marketing/descriptor words that don't change what the product fundamentally
// is — same spirit as the backend's FILLER_WORDS (backend/src/routes/search.ts)
// but re-implemented locally, same justification as
// priceHistoryService.normalizeProductName: this is a frontend-only concern
// with no shared runtime with the backend.
//
// 'organic' is included here (unlike an earlier version of this grouping
// key) — real shoppers expect "Organic Fuji Apples," "Family Pack Fuji
// Apples," and "Individual Fuji Apple" to all show up as browsable options
// within the same "Fuji Apples" comparison, not fragment into separate
// Stage-1 categories. A bare, variety-less "Organic Apples" search still
// forms its own group, since nothing here strips the variety word itself
// (fuji/gala/honeycrisp/...) — only the modifiers that describe a variant
// of an already-identified product, not the product's identity.
//
// Also includes cut/format modifiers ("boneless," "skinless," "thin,"
// "thick," "lean") and generic promotional labels ("new," "item,"
// "holiday," "seasonal," "exclusive") — the same closed-class treatment as
// every other word here, not specific to any one product: "Fresh Boneless
// Skinless Chicken Breast," "Family Pack Chicken Breast," and "Thin Sliced
// Chicken Breast" all need to reduce to the same identity as plain
// "Chicken Breast" for cross-store clustering to actually find them as one
// product (see computeIdentity below).
//
// Deliberately does NOT include fat-content/processing words ("whole,"
// "2%," "skim," "reduced fat," ...) or egg qualifiers ("cage-free,"
// "free-range," ...) — those describe materially different products a
// shopper is choosing between, not marketing filler, so each forms its own
// Stage-1 category same as any other variety word (see the fuji/gala note
// above).
const GROUP_FILLER_WORDS = new Set([
  'fresh', 'natural', 'premium', 'artisan', 'classic', 'raw', 'pure',
  'grade', 'certified', 'farm', 'local', 'locally', 'grown', 'harvested',
  'non-gmo', 'kosher', 'vegan', 'gluten-free', 'gluten', 'free', 'usda', 'extra',
  'super', 'large', 'medium', 'small', 'mini', 'giant', 'jumbo', 'select', 'choice',
  'crisp', 'ripe', 'aged', 'organic', 'individual', 'family', 'value', 'snack',
  'pre', 'cut', 'sliced', 'a', 'an', 'the', 'of', 'and', 'with', 'in', 'from', 'for', 'on',
  'boneless', 'skinless', 'bone-in', 'bonein', 'skin-on', 'skinon', 'thin', 'thick', 'lean',
  'new', 'item', 'holiday', 'seasonal', 'exclusive',
  // Produce form/preparation descriptors — the same closed-class treatment
  // as the meat cut/prep words above, just for fruit/vegetable listings:
  // "Corn on the Cob" and "Sweet Corn," "Broccoli Florets" and "Broccoli,"
  // "Celery Stalks" and "Celery" all need to reduce to the same clustering
  // identity — a store's choice of how to describe the cut/form of a
  // vegetable isn't a different product. Deliberately excludes words with
  // a real competing product on the other side of the same distinction
  // (e.g. "kernels" also names unpopped Popcorn Kernels vs. popped
  // Popcorn — a genuine different-product choice, not just packaging
  // wording — so it stays a real clustering token, not filler).
  'cob', 'ear', 'ears', 'husk', 'husked', 'shucked', 'floret', 'florets', 'stalk', 'stalks',
  'spear', 'spears',
]);

// General flavor/variant descriptors — a closed class of English words, not
// tied to any one product (the same word applies just as well to yogurt,
// creamer, or oatmeal). Stripped when building the *clustering* key so
// "Greek Yogurt Vanilla," "Greek Yogurt Strawberry," and "Greek Yogurt
// Plain" all reduce to one "Greek Yogurt" identity — flavor is a real,
// shopper-visible choice, but not a different *product*, and each of these
// stays fully browsable as a listing within the resulting group. Tracked
// separately from GROUP_FILLER_WORDS (see computeIdentity) so
// representative scoring can penalize a flavored listing without needing
// to re-derive that from the stripped-word list.
const FLAVOR_WORDS = new Set([
  'vanilla', 'chocolate', 'strawberry', 'blueberry', 'plain', 'original',
  'unflavored', 'unsweetened', 'sweetened', 'cinnamon', 'caramel', 'mocha',
  'honey', 'mint',
]);

// Preparation styles that turn a base grocery product into a ready-to-eat/
// marinated variant of it — still the same underlying product for
// comparison purposes (a shopper searching "chicken thighs" should still
// see a marinated one as an option), but never what should represent the
// category (see representativeScore below). Same closed-class pattern as
// FLAVOR_WORDS — general cooking/prep vocabulary, not product-specific.
const PREPARED_MEAL_WORDS = new Set([
  'marinated', 'seasoned', 'breaded', 'stuffed', 'glazed', 'teriyaki', 'bbq',
  'barbecue', 'buffalo', 'rotisserie', 'asado', 'fajita', 'cajun', 'blackened', 'jerk',
]);

// Unlike the backend's dedupSignature (which keeps container/format words on
// purpose, to tell apart distinct listings within one store), grouping across
// stores needs to collapse different package formats of the same product —
// a 3lb bag at Kroger and a 2lb bag at Trader Joe's are still "Fuji Apples."
const GROUP_UNIT_WORDS = new Set([
  'oz', 'fl', 'lb', 'lbs', 'pound', 'pounds', 'g', 'gram', 'grams', 'kg', 'ml', 'l',
  'liter', 'liters', 'gal', 'gallon', 'qt', 'quart', 'pt', 'pint', 'ct', 'count',
  'pk', 'pack', 'packs', 'case', 'dozen', 'ea', 'each', 'bag', 'box', 'jar', 'can',
  'bottle', 'carton', 'bunch', 'piece', 'pieces', 'pc', 'pcs', 'container', 'tray',
  'sleeve', 'half', 'quarter', 'double', 'triple',
]);

// Naively stripping a trailing "s" turns "tomatoes" into "tomatoe" and
// "berries" into "berrie" — different words than the "tomato"/"berry" a
// singular listing normalizes to, which was silently fragmenting a single
// real category (e.g. "Roma Tomatoes" vs "Roma Tomato") into two Stage 1
// cards. These are the common English plural patterns grocery listings
// actually use, checked most-specific first.
function singularize(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`; // berries -> berry
  if (word.endsWith('oes')) return word.slice(0, -2); // tomatoes -> tomato, potatoes -> potato
  if (/(?:[sxz]|[cs]h)es$/.test(word)) return word.slice(0, -2); // boxes/glasses/dishes/watches
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1); // apples -> apple
  return word;
}

function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .trim()
    .split(/[\s\-–—/,()]+/)
    .map((w) => w.replace(/\.+$/, ''))
    .filter(Boolean);
}

// Deliberately excludes bare percent tokens ("2%," "100%") from what counts
// as a stripped number — in a grocery name a percentage is virtually always
// a meaningful product attribute (milk fat content, juice concentration,
// ...), never marketing filler, so "2% Milk" needs to keep the "2%" to stay
// a different Stage-1 category than "Whole Milk."
function isNumericToken(word: string): boolean {
  if (/^\d+(\.\d+)?$/.test(word)) return true;
  const fused = word.match(/^\d+(?:\.\d+)?([a-z]+)$/);
  return fused != null && GROUP_UNIT_WORDS.has(fused[1]);
}

// Store-label synonyms for fat content, per the USDA milk-labeling
// convention every store's copy follows even when the exact wording
// differs — "Reduced Fat" means 2%, "Low Fat" means 1%, "Fat Free"/
// "Nonfat" means skim. Canonicalizing to one token *before* the generic
// filler stripping below keeps "2% Milk" (one store's label) and "2%
// Reduced Fat Milk" (another store's label for the identical product) in
// the same Stage-1 category, while "Whole," "2%," "1%," and "Skim" still
// stay apart from each other as distinct categories (see the
// GROUP_FILLER_WORDS note above) — this is what stops the fat-content
// distinction from re-fragmenting into one bucket per store's phrasing,
// the same class of bug as the brand-prefix one getGroupKey strips below.
const MILK_FAT_SYNONYMS: [RegExp, string][] = [
  [/\bfat[\s-]*free\b/gi, 'skim'],
  [/\bnon[\s-]*fat\b/gi, 'skim'],
  [/\breduced[\s-]*fat\b/gi, '2%'],
  [/\blow[\s-]*fat\b/gi, '1%'],
];

function canonicalizeFatContentWording(name: string): string {
  return MILK_FAT_SYNONYMS.reduce((acc, [pattern, canonical]) => acc.replace(pattern, canonical), name);
}

// ─── Fuzzy word similarity ─────────────────────────────────────────────────
// Sørensen–Dice bigram coefficient — the same general-purpose text-
// similarity measure the backend's relevance classifier uses (see
// wordsMatch in backend/src/routes/search.ts), re-implemented locally for
// the same reason the rest of this file's normalization is: no shared
// runtime with the backend. Tolerates typos and irregular plurals
// ("tomato" vs "tomatoes," "leaf" vs "leaves") that singularize's
// regular-plural rules don't catch, without treating unrelated words as
// matches.
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

/** True if two words denote the same concept: identical, simple plural, or
 * similar enough (typo/irregular plural) per Dice coefficient. Deliberately
 * strict — "milk" and "cream" score 0, so they are never treated as a match. */
function fuzzyWordsMatch(a: string, b: string): boolean {
  if (a === b || a === `${b}s` || b === `${a}s`) return true;
  return diceCoefficient(a, b) >= WORD_SIMILARITY_THRESHOLD;
}

// ─── Product identity (normalization for clustering + scoring) ────────────

interface ProductIdentity {
  /** The aggressive-strip token set used as the clustering key — brand,
   * filler/prep-modifier, unit/packaging, numeric, flavor, and
   * prepared-meal words all removed. Two listings with the same
   * `clusterTokens` are the same product for grouping purposes. */
  clusterTokens: string[];
  /** The milder-strip token set — brand/filler/unit/numeric removed, but
   * flavor and prepared-meal words kept. Used to measure how many stores
   * carry the *exact same variant* of a listing (see commonalityScore),
   * and as computeIdentity's fallback when the aggressive strip would
   * leave nothing. */
  variantTokens: string[];
  /** How many flavor words (see FLAVOR_WORDS) were stripped to form
   * `clusterTokens` — used to penalize a flavored listing in
   * representative scoring. */
  flavorCount: number;
  /** How many prepared-meal words (see PREPARED_MEAL_WORDS) were stripped —
   * used to penalize a marinated/prepared listing in representative
   * scoring. */
  preparedCount: number;
  /** How many filler/prep-modifier/promo words (see GROUP_FILLER_WORDS)
   * were stripped — a proxy for "how many extra modifiers does this
   * listing's name carry." */
  fillerCount: number;
}

/** Normalizes one listing into its clustering identity and scoring
 * signals. Two tiers, most-aggressive first: brand/unit/numeric/filler are
 * always stripped; flavor and prepared-meal words are *also* stripped for
 * `clusterTokens` so e.g. "Greek Yogurt Vanilla" and "Greek Yogurt Plain"
 * cluster together. If that leaves nothing (a listing that's essentially
 * just a flavor/prep word — "Strawberries," "Honey"), falls back to the
 * milder `variantTokens` pass instead, so a standalone product is never
 * normalized into an empty identity. A final fallback (keeping even
 * filler words) guards the same way against a name that's brand + filler
 * only. This guard is what lets FLAVOR_WORDS/PREPARED_MEAL_WORDS stay
 * general, catalog-wide dictionaries rather than needing product-specific
 * exceptions — the risk they'd otherwise pose to a standalone product of
 * the same name is structurally bounded to "falls back to the next tier,"
 * never "silently misclassified." */
function computeIdentity(product: ApiProduct): ProductIdentity {
  const brandWords = new Set(tokenize(product.brand ?? '').map(singularize));
  const base = tokenize(canonicalizeFatContentWording(product.name))
    .map(singularize)
    .filter((w) => {
      if (brandWords.has(w)) return false;
      if (GROUP_UNIT_WORDS.has(w) || GROUP_UNIT_WORDS.has(singularize(w))) return false;
      if (isNumericToken(w)) return false;
      if (w.length === 1) return false;
      return true;
    });

  let fillerCount = 0;
  let flavorCount = 0;
  let preparedCount = 0;
  const variantTokens: string[] = [];
  const clusterTokens: string[] = [];

  for (const w of base) {
    if (GROUP_FILLER_WORDS.has(w)) {
      fillerCount += 1;
      continue;
    }
    variantTokens.push(w);
    if (FLAVOR_WORDS.has(w)) {
      flavorCount += 1;
      continue;
    }
    if (PREPARED_MEAL_WORDS.has(w)) {
      preparedCount += 1;
      continue;
    }
    clusterTokens.push(w);
  }

  let finalCluster = [...new Set(clusterTokens)].sort();
  let finalVariant = [...new Set(variantTokens)].sort();

  if (finalCluster.length === 0) {
    // Nothing survived the aggressive strip — fall back to the milder
    // pass (flavor/prepared words kept as identity, not modifiers).
    finalCluster = finalVariant;
    flavorCount = 0;
    preparedCount = 0;
  }
  if (finalCluster.length === 0) {
    // Still nothing (brand + filler only) — last resort, keep everything.
    finalCluster = [...new Set(base)].sort();
    fillerCount = 0;
  }
  if (finalVariant.length === 0) finalVariant = finalCluster;

  return { clusterTokens: finalCluster, variantTokens: finalVariant, flavorCount, preparedCount, fillerCount };
}

/**
 * Safety net for the case identitiesFuzzyEqual's deliberately-strict
 * equal-size rule (see its own doc comment below) still leaves one store's
 * listings clustered as their own singleton — e.g. one store phrasing
 * "Sweet Corn" as "Corn on the Cob" reduces to a cluster-token set of a
 * different size than every other store's "Sweet Corn" listings (extra or
 * missing modifier words the filler dictionaries didn't anticipate), so
 * the core union-find pass never merges them. Left alone, that store's
 * otherwise clearly-relevant listings would silently vanish from the
 * multi-store category (surfacing only as an easy-to-miss single-store
 * chip elsewhere) — exactly the "global search hides products the
 * single-store search finds" bug this guards against.
 *
 * Deliberately conservative: a single-store cluster only folds into a
 * multi-store one when there is EXACTLY ONE multi-store cluster whose
 * identity shares a fuzzy-matching token with it. If two or more
 * multi-store clusters are equally plausible destinations (e.g. a lone
 * "Milk" listing sitting next to both a "Whole Milk" and a "2% Milk"
 * multi-store category), folding into either would be a guess, so it's
 * left as its own single-store cluster instead — unchanged, existing
 * behavior, still discoverable via the single-store search and the
 * "related categories" chips, just not silently mis-assigned.
 */
function foldOrphanedSingleStoreClusters(
  rootOrder: string[],
  mergedByRoot: Map<string, ApiProduct[]>,
  tokensByKey: Map<string, string[]>,
): void {
  const storeCountOf = (root: string) => new Set(mergedByRoot.get(root)!.map((p) => p.store)).size;
  const multiStoreRoots = rootOrder.filter((r) => storeCountOf(r) > 1);
  const singleStoreRoots = rootOrder.filter((r) => storeCountOf(r) === 1);

  for (const singleRoot of singleStoreRoots) {
    const singleTokens = tokensByKey.get(singleRoot)!;
    const candidates = multiStoreRoots.filter((multiRoot) => {
      const multiTokens = tokensByKey.get(multiRoot)!;
      return singleTokens.some((sw) => multiTokens.some((mw) => fuzzyWordsMatch(sw, mw)));
    });
    if (candidates.length !== 1) continue; // no plausible match, or genuinely ambiguous
    mergedByRoot.get(candidates[0])!.push(...mergedByRoot.get(singleRoot)!);
    mergedByRoot.delete(singleRoot);
  }
}

/** True when two clusters' identity token sets are the same size and every
 * token in one has a fuzzy match (see fuzzyWordsMatch) in the other — a
 * semantic safety net for residue the dictionaries above didn't
 * anticipate (a typo, an irregular plural singularize's regex rules
 * don't cover, a store's one-off spelling). Deliberately requires equal
 * size rather than "subset within one extra word" — the latter would
 * merge "Chicken Breast" into "Chicken Thigh" (a real, distinguishing
 * extra noun), which is exactly the kind of over-merge this needs to
 * avoid; same-size-with-fuzzy-match only fires when the sets are already
 * naming the same things, just spelled slightly differently. */
function identitiesFuzzyEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  const usedB = new Set<number>();
  for (const wa of a) {
    let matched = false;
    for (let i = 0; i < b.length; i++) {
      if (usedB.has(i)) continue;
      if (fuzzyWordsMatch(wa, b[i])) {
        usedB.add(i);
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return true;
}

export interface ProductGroup {
  id: string;
  name: string;
  /** Always a neutral "N stores" caption — deliberately never a brand name.
   * Many listings are store-exclusive private label (e.g. Trader Joe's own
   * brand is literally "Trader Joe's"), so showing brand text here would
   * make a Stage 1 category card read as store-specific, which the whole
   * point of Stage 1 is to avoid — comparison starts at Stage 2, not before. */
  subtitle: string;
  storeCount: number;
  category: GroceryCategory;
  image_url?: string;
  listings: ApiProduct[];
  /** 'taxonomy' when this group's identity came from a curated grocery
   * taxonomy subtype (see groceryTaxonomy.ts) rather than emergent
   * clustering; undefined for groups built the old way (dynamic
   * clustering, or the synthetic combined/bypass group). Taxonomy-backed
   * groups use a lower meaningful-category threshold in
   * categoryLayerIsMeaningful — the taxonomy already guarantees they're
   * real, distinct shopping choices (e.g. Bananas: Organic vs.
   * Conventional is only 2 categories, but that IS the meaningful choice
   * for that item). */
  source?: 'taxonomy' | 'dynamic';
}

/** `name` with `brand`'s own words removed, whitespace and stray leading/
 * trailing punctuation cleaned up. Falls back to the untouched name if
 * stripping the brand would leave nothing (a bare brand name with no other
 * words). Factored out from stripBrandFromDisplayName so shortenSiblingLabel
 * below can reuse the same brand-stripping on a related product's name
 * without needing a full ApiProduct to do it. */
function stripBrandWords(name: string, brand: string): string {
  const brandWords = tokenize(brand);
  if (brandWords.length === 0) return name;

  let cleaned = name;
  for (const word of brandWords) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cleaned = cleaned.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), '');
  }
  cleaned = cleaned.replace(/\s{2,}/g, ' ').replace(/^[\s,.\-]+|[\s,.\-]+$/g, '').trim();
  return cleaned.length > 0 ? cleaned : name;
}

/** A listing's name with its own `brand` words removed — same rule as the
 * subtitle above (never expose a single store's/private-label's brand on
 * a Stage-1 card), just applied to `name` instead of a separate caption. */
function stripBrandFromDisplayName(product: ApiProduct): string {
  return stripBrandWords(product.name, product.brand ?? '');
}

/** True if a raw (un-lowercased, un-singularized) word from a display name
 * is one of the classes computeIdentity strips — unit/packaging, numeric,
 * filler/prep-modifier, flavor, or prepared-meal. Shared by
 * cleanDisplayName's tiers below so each tier only differs in which
 * classes it includes. */
function isStrippableDisplayWord(
  rawWord: string,
  classes: { unit: boolean; filler: boolean; flavor: boolean; prepared: boolean },
): boolean {
  const cleaned = rawWord.toLowerCase().replace(/[,.]+$/, '');
  const norm = singularize(cleaned);
  if (classes.unit && (GROUP_UNIT_WORDS.has(cleaned) || GROUP_UNIT_WORDS.has(norm) || isNumericToken(cleaned))) return true;
  if (classes.filler && (GROUP_FILLER_WORDS.has(cleaned) || GROUP_FILLER_WORDS.has(norm))) return true;
  if (classes.flavor && (FLAVOR_WORDS.has(cleaned) || FLAVOR_WORDS.has(norm))) return true;
  if (classes.prepared && (PREPARED_MEAL_WORDS.has(cleaned) || PREPARED_MEAL_WORDS.has(norm))) return true;
  return false;
}

/** The representative's actual display name: `product`'s brand-stripped
 * name with every filler/prep-modifier, unit/packaging, numeric, flavor,
 * and prepared-meal word removed *in place* (original word order and
 * capitalization preserved, unlike the sorted/lowercased token set
 * computeIdentity builds for clustering). This is what makes "Fresh
 * Chicken Breast," "Organic Chicken Breast," and "Value Pack Chicken
 * Breast" all normalize toward showing as plain "Chicken Breast" — the
 * winning candidate's *raw* modifiers still count against it in
 * genericnessScore (a listing whose name leans hard on marketing words is
 * a weaker "generic staple" signal even after cleanup), but whichever one
 * wins is never displayed with its leftover modifiers still attached.
 * Same empty-result guard as computeIdentity, applied to word lists
 * instead of token sets, so a listing that's essentially just a flavor/
 * filler word never cleans down to nothing. */
function cleanDisplayName(product: ApiProduct): string {
  const brandStripped = stripBrandFromDisplayName(product);
  const words = brandStripped.split(/\s+/).filter(Boolean);

  const tiers = [
    { unit: true, filler: true, flavor: true, prepared: true },
    { unit: true, filler: true, flavor: false, prepared: false },
    { unit: true, filler: false, flavor: false, prepared: false },
  ];
  for (const classes of tiers) {
    const kept = words.filter((w) => !isStrippableDisplayWord(w, classes));
    if (kept.length > 0) return kept.join(' ');
  }
  return brandStripped;
}

function tokenizeQuery(query: string): string[] {
  return query.toLowerCase().trim().split(/\s+/).filter(Boolean).map(singularize);
}

/** How well a name matches the search query, 0–40 — a scaled-down,
 * simplified port of the backend's `computeRelevance` (query word
 * coverage, how early the match falls, how concise the name is relative
 * to the query), reused for the same "closest semantic match to the
 * search" signal rather than reinventing it. Used both to score a
 * cluster's representative candidates and to sort the returned groups by
 * relevance to the query. A blank query (shouldn't happen in practice —
 * every caller has an active search term) scores everything neutrally
 * rather than zeroing it out. */
function queryRelevanceScore(query: string, name: string): number {
  const qWords = tokenizeQuery(query);
  if (qWords.length === 0) return 20;

  const nWords = tokenize(name).map(singularize);
  if (nWords.length === 0) return 0;

  const matchedCount = qWords.filter((qw) => nWords.some((nw) => fuzzyWordsMatch(nw, qw))).length;
  const coverage = matchedCount / qWords.length;
  if (coverage === 0) return 0;

  const sigWords = nWords.filter((w) => !GROUP_FILLER_WORDS.has(w));
  const firstIdx = Math.max(0, sigWords.findIndex((nw) => qWords.some((qw) => fuzzyWordsMatch(nw, qw))));
  const positionScore = Math.max(0, 1 - firstIdx * 0.15);

  const extra = Math.max(0, sigWords.length - qWords.length);
  const concisenessScore = extra === 0 ? 1 : extra === 1 ? 0.85 : Math.max(0.4, 1 - extra * 0.15);

  const raw = coverage * 0.55 + positionScore * 0.25 + concisenessScore * 0.2;
  return Math.round(raw * 40);
}

/** How "generic" a listing is, 25 down to 0 — penalizes every stripped
 * modifier, weighted by how much it distances the listing from "the plain
 * version of this product": filler/prep-modifier words lightly, flavor
 * words more, prepared-meal/marinated words most. Directly implements the
 * request's "penalize flavored variants / prepared meals / marinated
 * products / ... products with excessive modifiers." */
function genericnessScore(identity: ProductIdentity): number {
  const score = 25 - identity.fillerCount * 4 - identity.flavorCount * 6 - identity.preparedCount * 8;
  return Math.max(0, score);
}

/** How many distinct stores in this cluster carry the exact same variant
 * (same `variantTokens` key) as this candidate, 0–20 — "sold across
 * multiple stores" and "commonly purchased version" made concrete: the
 * phrasing most stores independently agree on scores highest. */
function commonalityScore(variantKey: string, siblings: { store: StoreName; variantKey: string }[]): number {
  const stores = new Set(siblings.filter((s) => s.variantKey === variantKey).map((s) => s.store));
  return Math.min(20, stores.size * 7);
}

function buildGroupEntry(id: string, listings: ApiProduct[], query: string): ProductGroup {
  const candidates = listings.map((product) => {
    const identity = computeIdentity(product);
    return {
      product,
      displayName: stripBrandFromDisplayName(product),
      identity,
      variantKey: identity.variantTokens.join(' '),
    };
  });
  const siblingVariants = candidates.map((c) => ({ store: c.product.store, variantKey: c.variantKey }));

  // Representative = highest total score across query relevance,
  // genericness, and cross-store commonality — not "shortest name" and
  // not "first in the list." See queryRelevanceScore/genericnessScore/
  // commonalityScore above for what each component rewards or penalizes.
  const scored = candidates.map((c) => ({
    ...c,
    cleanName: cleanDisplayName(c.product),
    score:
      queryRelevanceScore(query, c.displayName)
      + genericnessScore(c.identity)
      + commonalityScore(c.variantKey, siblingVariants),
  }));
  // Tie-break on the *cleaned* name — once modifiers are stripped, several
  // near-identical candidates (e.g. "Fresh Chicken Breast" vs "Organic
  // Chicken Breast") often clean down to the exact same display string, in
  // which case the shorter/earlier raw name is just an arbitrary but
  // deterministic pick.
  scored.sort((a, b) =>
    b.score - a.score
    || a.cleanName.length - b.cleanName.length
    || a.cleanName.localeCompare(b.cleanName));
  const representative = scored[0];

  const storeCount = new Set(listings.map((p) => p.store)).size;

  return {
    id,
    name: representative.cleanName,
    subtitle: `${storeCount} store${storeCount !== 1 ? 's' : ''}`,
    storeCount,
    category: categorizeProduct(representative.product),
    image_url: representative.product.image_url,
    listings,
    source: 'dynamic',
  };
}

/** Turns one resolved cluster's listings into one or two Stage 1 cards,
 * splitting true per-piece listings from bulk ones (see isSoldIndividually)
 * whenever a shopper would still see more than one store on *both* sides of
 * the split — if one side would be left with just a single store, that
 * split isn't presenting a meaningful "individual vs. bulk" decision, it's
 * silently hiding that store's listings behind an easy-to-miss single-store
 * category instead (the exact bug this guards against: a store whose corn
 * happens to be sold "Each" disappearing from the main "Sweet Corn" card
 * because every *other* store's corn is bagged). Shared by both the dynamic
 * clustering pass and the taxonomy pass below — a taxonomy subtype like
 * "Roma Tomatoes" needs the same individual-vs-bag split a dynamically
 * clustered one does; the taxonomy only decides *which* subtype a listing
 * belongs to, not whether its package format is also a real choice. */
function buildSplitGroupEntries(id: string, listings: ApiProduct[], query: string): ProductGroup[] {
  const singlePiece = listings.filter(isSoldIndividually);
  const bulk = listings.filter((p) => !isSoldIndividually(p));

  const bulkStoreCount = new Set(bulk.map((p) => p.store)).size;
  const singleStoreCount = new Set(singlePiece.map((p) => p.store)).size;
  const wouldOrphanAStore = bulk.length > 0 && singlePiece.length > 0
    && (bulkStoreCount <= 1 || singleStoreCount <= 1);

  if (wouldOrphanAStore) {
    return [buildGroupEntry(id, listings, query)];
  }

  const result: ProductGroup[] = [];
  let baseName: string | null = null;
  if (bulk.length > 0) {
    const bulkGroup = buildGroupEntry(id, bulk, query);
    baseName = bulkGroup.name;
    result.push(bulkGroup);
  }
  if (singlePiece.length > 0) {
    const singleGroup = buildGroupEntry(`${id}__single`, singlePiece, query);
    if (baseName) singleGroup.name = `${baseName} (Single)`;
    result.push(singleGroup);
  }
  return result;
}

/** Classifies `products` into an entry's taxonomy subtypes, in the entry's
 * declared order — one ProductGroup per non-empty subtype, canonically
 * named (never derived from any one listing's raw name, unlike the dynamic
 * path's representative-scoring), plus whatever products didn't match any
 * subtype so the caller can still cluster and surface them instead of
 * silently dropping them. */
function buildTaxonomyProductGroups(
  products: ApiProduct[],
  entry: TaxonomyEntry,
): { groups: ProductGroup[]; leftover: ApiProduct[] } {
  const bySubtype = new Map<string, ApiProduct[]>();
  const leftover: ApiProduct[] = [];
  for (const product of products) {
    const subtype = classifyProductSubtype(product, entry);
    if (!subtype) {
      leftover.push(product);
      continue;
    }
    if (!bySubtype.has(subtype.id)) bySubtype.set(subtype.id, []);
    bySubtype.get(subtype.id)!.push(product);
  }

  const groups: ProductGroup[] = [];
  for (const subtype of entry.subtypes) {
    const listings = bySubtype.get(subtype.id);
    if (!listings || listings.length === 0) continue;
    const split = buildSplitGroupEntries(`taxonomy:${entry.id}:${subtype.id}`, listings, subtype.label);
    for (const g of split) {
      const isSingleVariant = g.id.endsWith('__single');
      groups.push({
        ...g,
        name: isSingleVariant ? `${subtype.label} (Single)` : subtype.label,
        source: 'taxonomy',
      });
    }
  }
  return { groups, leftover };
}

/** True for a listing genuinely sold as one piece — a real, parsed signal
 * (see parseSize below), never a guess: "1 ct"/"Each"/"Ea" parse to a count
 * of exactly 1, whereas a "4 ct" multi-pack or a per-pound bulk listing do
 * not. Absent or unparseable size info defaults to false — never assumed.
 * Exported for filterSchemaService's "Package Type" (Individual/Bag) facet. */
export function isSoldIndividually(product: ApiProduct): boolean {
  const parsed = parseSize(product.size);
  return parsed != null && parsed.dimension === 'count' && parsed.amount <= 1;
}

/** Groups a set of "direct match" listings (never `related` ones — those
 * stay in the existing tangential-matches section) into one card per
 * semantic product, spanning every store that carries it.
 *
 * Two-pass clustering: first by exact identity-key equality (see
 * computeIdentity — brand/filler/unit/numeric/flavor/prepared-meal words
 * all stripped), which handles the large majority of cases once that
 * normalization is rich enough; then a fuzzy merge pass
 * (identitiesFuzzyEqual) that catches residue the dictionaries didn't
 * anticipate — typos, irregular plurals — without needing an exhaustive
 * keyword list. This is what replaces the old brittle exact-string-match
 * grouping that fragmented "Chicken Breast" across stores into
 * single-store orphans.
 *
 * Within each resolved cluster, the representative (name/image/category)
 * is chosen by score, not by insertion order or name length — see
 * buildGroupEntry. The returned groups are sorted by how well their
 * chosen representative matches `query`, so the most relevant categories
 * lead the grid.
 *
 * When a semantic group mixes true per-piece listings ("Roma Tomato, Each")
 * with bulk ones (a bag, or priced by the pound), it's split into two
 * separate Stage 1 cards — shoppers buying "one tomato" and shoppers buying
 * "a bag of tomatoes" are making a different decision, and collapsing them
 * into one comparison would hide that. The split only happens when both
 * kinds actually coexist in this search's results; a category sold only one
 * way keeps its plain name, no "(Single)" qualifier needed. */
function buildDynamicProductGroups(products: ApiProduct[], query: string): ProductGroup[] {
  const byKey = new Map<string, ApiProduct[]>();
  const order: string[] = [];
  for (const product of products) {
    const key = computeIdentity(product).clusterTokens.join(' ');
    if (!key) continue;
    if (!byKey.has(key)) {
      byKey.set(key, []);
      order.push(key);
    }
    byKey.get(key)!.push(product);
  }

  // Union-find over the distinct cluster keys, merging any pair whose
  // token sets are fuzzy-equal (see identitiesFuzzyEqual).
  const parent = new Map(order.map((k) => [k, k]));
  function find(k: string): string {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = k;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  function union(a: string, b: string) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const tokensByKey = new Map(order.map((k) => [k, k.split(' ').filter(Boolean)]));
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      if (identitiesFuzzyEqual(tokensByKey.get(order[i])!, tokensByKey.get(order[j])!)) {
        union(order[i], order[j]);
      }
    }
  }

  const mergedByRoot = new Map<string, ApiProduct[]>();
  const rootOrder: string[] = [];
  for (const key of order) {
    const root = find(key);
    if (!mergedByRoot.has(root)) {
      mergedByRoot.set(root, []);
      rootOrder.push(root);
    }
    mergedByRoot.get(root)!.push(...byKey.get(key)!);
  }

  foldOrphanedSingleStoreClusters(rootOrder, mergedByRoot, tokensByKey);

  const result: ProductGroup[] = [];
  for (const root of rootOrder) {
    if (!mergedByRoot.has(root)) continue; // absorbed into another root above
    result.push(...buildSplitGroupEntries(root, mergedByRoot.get(root)!, query));
  }

  return result
    .map((group) => ({ group, relevance: queryRelevanceScore(query, group.name) }))
    .sort((a, b) => b.relevance - a.relevance)
    .map(({ group }) => group);
}

/** Groups a set of "direct match" listings into one card per semantic
 * product, spanning every store that carries it — the public entry point
 * both apps' search screens use.
 *
 * When the active search `query` matches a curated grocery taxonomy entry
 * (see groceryTaxonomy.ts — "milk," "chicken," "apples," ...), products are
 * classified into that entry's natural subtypes first (Whole Milk, 2% Milk,
 * Chicken Breast, Chicken Thighs, ...), each rendered under its canonical
 * label rather than whatever one listing's raw name happened to be.
 * Anything that doesn't name a specific subtype the taxonomy anticipated —
 * because the query has no taxonomy entry at all, or a listing just doesn't
 * say which variety it is — falls through to the original dynamic identity-
 * clustering pass (buildDynamicProductGroups) exactly as before, so no
 * product is ever dropped for lacking a taxonomy match. */
export function buildProductGroups(products: ApiProduct[], query: string): ProductGroup[] {
  const entry = findTaxonomyEntry(query);
  if (!entry) return buildDynamicProductGroups(products, query);

  const { groups: taxonomyGroups, leftover } = buildTaxonomyProductGroups(products, entry);
  const leftoverGroups = leftover.length > 0 ? buildDynamicProductGroups(leftover, query) : [];

  return [...taxonomyGroups, ...leftoverGroups]
    .map((group) => ({ group, relevance: queryRelevanceScore(query, group.name) }))
    .sort((a, b) => b.relevance - a.relevance)
    .map(({ group }) => group);
}

/**
 * Debug funnel logging for the category-assignment stage — makes it
 * immediately obvious when (and why) a store's direct-match products
 * failed to surface in any visible category, the exact failure mode the
 * "Sweet Corn" bug this file's tests guard against was caused by. Call
 * once per search, right after `buildProductGroups` runs, with the same
 * `direct` product list that was passed in. Cheap: a handful of Set/filter
 * operations over an already-small per-search result set, never gated
 * behind a flag since it's the primary tool for diagnosing a future
 * regression of this exact bug.
 */
export function logCategoryAssignment(directProducts: ApiProduct[], groups: ProductGroup[], query: string): void {
  const byStore = new Map<StoreName, ApiProduct[]>();
  for (const product of directProducts) {
    if (!byStore.has(product.store)) byStore.set(product.store, []);
    byStore.get(product.store)!.push(product);
  }

  for (const [store, products] of byStore) {
    const assignedIds = new Set<string>();
    const perCategoryCounts: string[] = [];
    for (const group of groups) {
      const count = group.listings.filter((l) => l.store === store).length;
      if (count === 0) continue;
      perCategoryCounts.push(`${group.name}: ${count}`);
      for (const listing of group.listings) {
        if (listing.store === store) assignedIds.add(listing.id);
      }
    }
    const lost = products.filter((product) => !assignedIds.has(product.id));

    console.log(
      `[CategoryAssignment] query="${query}" store=${store} `
      + `directMatches=${products.length} assigned=${assignedIds.size} `
      + `categories=[${perCategoryCounts.join(', ') || 'none'}]`,
    );
    for (const product of lost) {
      console.log(
        `[CategoryAssignment] EXCLUDED "${product.name}" (${store}) for query "${query}" `
        + `— reason: did not land in any category group`,
      );
    }
  }
}

/** Turns a sibling group's (or a tangential related product's) full name
 * into a short, chip-sized refinement label relative to whatever's
 * currently being viewed — "Organic Fuji Apples" next to a "Fuji Apples"
 * comparison becomes "Organic Fuji," not the whole name a shopper already
 * knows the gist of. Used by RefinementSection's "Related categories"
 * chips at both layers: Stage 2 passes a sibling ProductGroup's name
 * against the current group's name; Stage 1 passes single-store groups'
 * and tangential related products' own names against the raw search
 * query. `brand` is optional and only meaningful for the Stage 1 case —
 * sibling/single-store group names are already brand-free (see
 * buildGroupEntry), but a tangential related product's raw name isn't. */
export function shortenSiblingLabel(rawName: string, currentContextName: string, brand?: string): string {
  const name = brand ? stripBrandWords(rawName, brand) : rawName;
  const currentHead = singularHeadNoun(currentContextName);
  const currentModifiers = tokenize(currentContextName)
    .filter((w) => !GROUP_FILLER_WORDS.has(w) && singularize(w) !== currentHead);

  const isSingle = /\(single\)\s*$/i.test(name);
  const base = name.replace(/\s*\(single\)\s*$/i, '').trim();
  const words = base.split(/\s+/).filter(Boolean);
  const distinguishing = words.filter((w) => singularize(w.toLowerCase()) !== currentHead);

  // If the only thing distinguishing this sibling is that it's sold
  // individually — same variety/modifiers as what's already being viewed
  // — "Individual" alone says it; repeating "Fuji" back would be noise.
  const sameAsCurrentModifiers = distinguishing.length === currentModifiers.length
    && distinguishing.every((w, i) => w.toLowerCase() === currentModifiers[i]);
  if (isSingle && sameAsCurrentModifiers) return 'Individual';

  const label = distinguishing.length > 0 ? distinguishing.join(' ') : base;
  return isSingle ? `${label} (Individual)` : label;
}

// ─── Category-layer routing ────────────────────────────────────────────────

// A category grid only earns its extra click when it's actually organizing
// a meaningful slice of the results — fewer than this many distinct, real
// multi-store categories isn't a real choice to present to a shopper (see
// categoryLayerIsMeaningful). Deliberately the *only* gate: an earlier
// version also required the categorized share of results to cover at
// least half of all direct matches ("coverage"), which meant a search with
// a large single-store long tail (very common — most searches have at
// least a few store-exclusive stragglers) would bypass the category grid
// even with five, six, or more genuine multi-store categories. That
// silently defeated the count check almost every time and is why the grid
// was being skipped far more often than intended — count alone, on a
// properly deduplicated/filtered list of categories, is the whole rule.
const MIN_MEANINGFUL_CATEGORIES = 3;
// A taxonomy-backed item (see groceryTaxonomy.ts) doesn't need the same bar
// as emergent clustering — the taxonomy itself is the evidence that these
// are real, distinct shopping choices (e.g. "Bananas" only ever has
// Organic/Conventional, exactly 2, and that split is still the meaningful
// choice a shopper is making — requiring 3 would mean this item's category
// grid could *never* show).
const MIN_MEANINGFUL_TAXONOMY_CATEGORIES = 2;

/** Counts only valid, unique, non-empty categories: a blank/placeholder
 * name, a name that's a case-insensitive duplicate of one already counted,
 * or a group with zero listings, are all excluded before counting — so the
 * Stage-1/Stage-2 routing decision below is never inflated or deflated by
 * a degenerate entry. Exported so callers can log the raw vs. filtered vs.
 * final counts for debugging (see SearchScreen.tsx / page.tsx). */
export function countMeaningfulCategories(groups: ProductGroup[]): number {
  const seen = new Set<string>();
  for (const g of groups) {
    const name = g.name?.trim().toLowerCase();
    if (!name) continue; // placeholder/null/empty name
    if (g.listings.length === 0) continue; // no actual products
    seen.add(name); // Set dedupes case-insensitively via the lowercased key
  }
  return seen.size;
}

/** Whether Stage 1's category grid is worth showing at all for this
 * search, judged purely from the shape of the results — never a
 * per-product/per-query special case. Two thresholds: a taxonomy-backed
 * search (see groceryTaxonomy.ts) needs only 2 real subtype categories —
 * "Chicken Breast" vs. "Chicken Thighs" *is* the meaningful choice for a
 * "chicken" search, and requiring 3 would mean some taxonomy items (e.g.
 * Bananas: Organic vs. Conventional) could never show the grid at all — a
 * search resolved entirely by emergent dynamic clustering still needs 3,
 * since without a curated taxonomy backing them, 2 loosely-related
 * clusters aren't reliably a real choice worth an extra click. Used by
 * both apps' search screen to decide whether to route straight into the
 * same Product Comparison View that normally follows tapping a category —
 * see buildCombinedGroup. */
export function categoryLayerIsMeaningful(multiStoreGroups: ProductGroup[]): boolean {
  const taxonomyGroups = multiStoreGroups.filter((g) => g.source === 'taxonomy');
  if (countMeaningfulCategories(taxonomyGroups) >= MIN_MEANINGFUL_TAXONOMY_CATEGORIES) return true;
  return countMeaningfulCategories(multiStoreGroups) >= MIN_MEANINGFUL_CATEGORIES;
}

/** A synthetic "category" spanning every direct-match product from a
 * search — used to route straight into the Product Comparison View when
 * categoryLayerIsMeaningful says the category grid isn't worth the click.
 * It's the exact same view a real category opens into, just fed the whole
 * result set instead of one cluster's listings — no third UI.
 * `id` is deliberately never a real cluster id (buildProductGroups never
 * produces this string), so the comparison view's own "sibling
 * categories" lookup still naturally offers every real category it found
 * as an optional refinement chip, even though none of them was worth
 * forcing a click into. */
export function buildCombinedGroup(products: ApiProduct[], query: string): ProductGroup {
  const storeCount = new Set(products.map((p) => p.store)).size;
  const trimmed = query.trim();
  const name = trimmed.length > 0
    ? trimmed.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1))
    : 'All Products';
  return {
    id: '__all_direct__',
    name,
    subtitle: `${storeCount} store${storeCount !== 1 ? 's' : ''}`,
    storeCount,
    category: products[0] ? categorizeProduct(products[0]) : 'Other',
    image_url: undefined,
    listings: products,
  };
}

// ─── Unit price normalization ─────────────────────────────────────────────

type UnitDimension = 'weight' | 'volume' | 'count';

interface ParsedSize {
  dimension: UnitDimension;
  /** Normalized amount — oz for weight, fl oz for volume, raw count for count. */
  amount: number;
}

const FRACTION_WORDS: Record<string, number> = { half: 0.5, quarter: 0.25, double: 2, triple: 3 };

// (regex, dimension, multiplier to the dimension's base unit)
// "fl oz" is collapsed to the single token "floz" before matching (see
// parseSize) — the general single-token unit regex below wouldn't otherwise
// see the "oz" half of a two-word "fl oz" unit.
const SIZE_PATTERNS: [RegExp, UnitDimension, number][] = [
  [/floz/i, 'volume', 1],
  [/gal(?:lon)?s?/i, 'volume', 128],
  [/qts?|quarts?/i, 'volume', 32],
  [/pts?|pints?/i, 'volume', 16],
  [/ml|milliliters?/i, 'volume', 0.033814],
  [/\bl\b|liters?|litres?/i, 'volume', 33.814],
  [/oz|ounces?/i, 'weight', 1],
  [/lbs?|pounds?/i, 'weight', 16],
  [/kg|kilograms?/i, 'weight', 35.274],
  [/\bg\b|grams?/i, 'weight', 0.035274],
  [/dozen/i, 'count', 12],
  [/ct|count|ea|each/i, 'count', 1],
];

/** Parses a free-text size string (e.g. "Half Gallon", "3 lb Bag", "12 ct")
 * into a normalized quantity. Returns null when nothing recognizable is
 * found — callers fall back to showing total price only, never a fabricated
 * unit price. */
export function parseSize(size: string): ParsedSize | null {
  if (!size) return null;
  // Collapse the two-word "fl oz" / "fl. oz." / "fl ounces" unit into one
  // token so the single-token matching below (both branches) sees it —
  // otherwise only the "fl" half would ever reach SIZE_PATTERNS.
  const lower = size.toLowerCase().replace(/fl\.?\s*(oz\.?|ounces?)/g, 'floz');

  // "Half Gallon" / "Double Pack" — a leading fraction/multiplier word with
  // no explicit number, applied to whatever unit follows it.
  const fractionMatch = lower.match(/\b(half|quarter|double|triple)\b\s+([a-z]+)/);
  if (fractionMatch) {
    const [, word, unitWord] = fractionMatch;
    const pattern = SIZE_PATTERNS.find(([re]) => re.test(unitWord));
    if (pattern) {
      const [, dimension, multiplier] = pattern;
      return { dimension, amount: FRACTION_WORDS[word] * multiplier };
    }
  }

  const numberMatch = lower.match(/(\d+(?:\.\d+)?)\s*([a-z.]+)/);
  if (numberMatch) {
    const [, qtyStr, unitWord] = numberMatch;
    const qty = parseFloat(qtyStr);
    const pattern = SIZE_PATTERNS.find(([re]) => re.test(unitWord));
    if (pattern && qty > 0) {
      const [, dimension, multiplier] = pattern;
      return { dimension, amount: qty * multiplier };
    }
  }

  // A bare "Each"/"Ea" with no leading number.
  if (/\beach\b|\bea\b/.test(lower)) return { dimension: 'count', amount: 1 };

  return null;
}

/** The last significant word of a group's name, singularized — used to
 * build a natural per-unit label like "$/apple" for count-based products. */
function singularHeadNoun(groupName: string): string {
  const words = tokenize(groupName).filter((w) => !GROUP_FILLER_WORDS.has(w));
  const head = words[words.length - 1] ?? 'item';
  return singularize(head);
}

export interface UnitPrice {
  /** Always per base unit (1 oz for weight, 1 fl oz for volume, 1 item for
   * count) — never per lb/gallon/dozen, even when `label` displays one of
   * those. This is what makes `value` safe to compare/subtract across
   * listings; previously `value` itself switched scale (e.g. $/oz vs $/lb)
   * depending on a single listing's own package size, so subtracting two
   * listings' unit prices could silently mix units up to 128x apart — the
   * root cause of wildly inflated "Save $X" figures. */
  value: number;
  label: string;
  dimension: UnitDimension;
}

/** The normalized, comparable price for one listing — e.g. "$0.62 / apple",
 * "$0.31 / oz", "$4.20 / lb", "$0.05 / fl oz", "$2.80 / gallon". `label`
 * picks whichever display unit reads best for this package size, but that
 * choice never feeds back into `value`, which stays in a single base unit
 * per dimension so it's always safe to compare across listings. */
export function getUnitPrice(product: ApiProduct, groupName: string): UnitPrice | null {
  const parsed = parseSize(product.size);
  if (!parsed || parsed.amount <= 0) return null;

  const value = product.price / parsed.amount;

  let unitPrice: UnitPrice;
  if (parsed.dimension === 'count') {
    const label = parsed.amount >= 12
      ? `$${(value * 12).toFixed(2)} / dozen`
      : `$${value.toFixed(2)} / ${singularHeadNoun(groupName)}`;
    unitPrice = { value, label, dimension: 'count' };
  } else if (parsed.dimension === 'weight') {
    const label = parsed.amount >= 16
      ? `$${(value * 16).toFixed(2)} / lb`
      : `$${value.toFixed(2)} / oz`;
    unitPrice = { value, label, dimension: 'weight' };
  } else {
    // volume
    const label = parsed.amount >= 64
      ? `$${(value * 128).toFixed(2)} / gallon`
      : `$${value.toFixed(2)} / fl oz`;
    unitPrice = { value, label, dimension: 'volume' };
  }

  return unitPrice;
}

// ─── Comparison ranking ────────────────────────────────────────────────────

export interface EnrichedListing {
  product: ApiProduct;
  unitPrice: UnitPrice | null;
  distanceMiles: number | null;
}

function enrichOne(product: ApiProduct, groupNameForNoun: string, userCoords: Coordinates | null): EnrichedListing {
  return {
    product,
    unitPrice: getUnitPrice(product, groupNameForNoun),
    distanceMiles:
      userCoords && product.location?.latitude != null && product.location?.longitude != null
        ? haversineDistanceMiles(userCoords, {
            latitude: product.location.latitude,
            longitude: product.location.longitude,
          })
        : null,
  };
}

export function enrichListings(
  group: ProductGroup,
  userCoords: Coordinates | null,
): EnrichedListing[] {
  return group.listings.map((product) => enrichOne(product, group.name, userCoords));
}

/** Same enrichment as `enrichListings`, but for a flat pool of listings that
 * doesn't belong to one semantic ProductGroup — the "Browse Individual
 * Products" / "More Categories" refinement options (RefinementSection)
 * deliberately show listings spanning several varieties at once (every
 * apple variety a store carries, not just Fuji), so there's no single
 * group name to hand `getUnitPrice` for the count-noun — each listing uses
 * its own full name instead, which still resolves the right noun per item. */
export function enrichProducts(products: ApiProduct[], userCoords: Coordinates | null): EnrichedListing[] {
  return products.map((product) => enrichOne(product, product.name, userCoords));
}

/** The comparison screen's Filter & Sort options — moved here (off Stage 1)
 * since sorting/filtering only makes sense once a shopper has already
 * picked one category to compare. `lowest_unit_price` and `highest_rated`
 * and `largest_savings` are the category-aware additions (see
 * filterSchemaService.buildSortOptions, which decides which of these are
 * actually worth showing for the current result set and what to label
 * `lowest_unit_price` as — "Lowest Price per Lb," "... per Gallon," "...
 * per Egg," etc. — depending on how these listings are actually priced). */
export type ComparisonSort =
  | 'best_value'
  | 'lowest_unit_price'
  | 'lowest_total'
  | 'closest'
  | 'highest_rated'
  | 'organic_first'
  | 'largest_savings';

/** One dynamically-generated Filter & Sort facet (see filterSchemaService,
 * which is the only place these are actually constructed — this interface
 * just describes the shape so comparisonService can apply one without
 * needing to import the schema builder itself and create a dependency
 * cycle). `options` only ever lists values genuinely present in the
 * current result set — never a fabricated universal list — and `matches`
 * is the same predicate the schema builder used to decide that, so
 * filtering and schema-generation can never disagree. */
export interface AttributeFilterDef {
  key: string;
  label: string;
  options: { value: string; label: string }[];
  matches: (product: ApiProduct, optionValue: string) => boolean;
}

export interface ComparisonFilters {
  sort: ComparisonSort;
  inStockOnly: boolean;
  /** Empty set = every package size included. */
  sizes: Set<string>;
  /** Keyed by AttributeFilterDef.key — e.g. `{ 'fat-content': Set(['2%']),
   * organic: Set(['yes']) }`. An empty (or absent) set for a key means
   * every value of that facet is included, same convention as `sizes`. */
  attributes: Record<string, Set<string>>;
}

export function defaultComparisonFilters(): ComparisonFilters {
  return { sort: 'best_value', inStockOnly: false, sizes: new Set(), attributes: {} };
}

export function countActiveComparisonFilters(filters: ComparisonFilters): number {
  let count = 0;
  if (filters.sort !== 'best_value') count += 1;
  if (filters.inStockOnly) count += 1;
  if (filters.sizes.size > 0) count += 1;
  for (const selected of Object.values(filters.attributes)) {
    if (selected.size > 0) count += 1;
  }
  return count;
}

/** Availability/Package Size/dynamic-attribute filters, applied to a
 * group's raw listings before anything downstream (hero pick, store
 * sections) ever sees them — so every part of the comparison screen agrees
 * on what's actually in view. `attributeDefs` is whatever
 * filterSchemaService.buildFilterSchema generated for these same listings
 * — a product passes a facet if it matches *any* selected value within it
 * (e.g. "2%" or "Skim" selected together), and must pass every facet that
 * has a selection (standard faceted-search AND-across/OR-within semantics). */
export function applyComparisonFilters(
  listings: ApiProduct[],
  filters: ComparisonFilters,
  attributeDefs: AttributeFilterDef[],
): ApiProduct[] {
  return listings.filter((p) => {
    if (filters.inStockOnly && p.inStock === false) return false;
    if (filters.sizes.size > 0 && !filters.sizes.has(p.size)) return false;
    for (const def of attributeDefs) {
      const selected = filters.attributes[def.key];
      if (selected && selected.size > 0) {
        const matchesAny = [...selected].some((value) => def.matches(p, value));
        if (!matchesAny) return false;
      }
    }
    return true;
  });
}

function compareByUnitPrice(a: EnrichedListing, b: EnrichedListing): number {
  const au = a.unitPrice?.value ?? Infinity;
  const bu = b.unitPrice?.value ?? Infinity;
  return au - bu;
}

/** The chosen sort's primary ordering between two listings — shared by both
 * the hero pick (always 'best_value') and each store's browsing row
 * (whatever sort the shopper picked in Filter & Sort). `largest_savings`
 * isn't handled here — it needs the whole array (the "worst" price to save
 * against), not just a pairwise comparison — see savingsValue/
 * rankWithinStore below; it falls through to the best_value ordering here
 * only as a defensive fallback that should never actually be hit. */
function compareListings(sort: ComparisonSort) {
  return (a: EnrichedListing, b: EnrichedListing): number => {
    switch (sort) {
      case 'lowest_unit_price':
        return compareByUnitPrice(a, b);
      case 'lowest_total':
        return a.product.price - b.product.price || compareByUnitPrice(a, b);
      case 'closest':
        return (a.distanceMiles ?? Infinity) - (b.distanceMiles ?? Infinity) || compareByUnitPrice(a, b);
      case 'highest_rated':
        return b.product.rating - a.product.rating || compareByUnitPrice(a, b);
      case 'organic_first': {
        const ao = isOrganicProduct(a.product) ? 0 : 1;
        const bo = isOrganicProduct(b.product) ? 0 : 1;
        return ao - bo || compareByUnitPrice(a, b);
      }
      case 'best_value':
      default:
        return (
          compareByUnitPrice(a, b)
          || a.product.price - b.product.price
          || (a.distanceMiles ?? Infinity) - (b.distanceMiles ?? Infinity)
        );
    }
  };
}

/** Global "best value" ordering across every store — cheapest unit price,
 * then cheapest total price, then closest. Feeds the single featured
 * recommendation at the top of the comparison screen — always true best
 * value, regardless of how the shopper has the store rows sorted. */
function rankByBestValue(listings: EnrichedListing[]): EnrichedListing[] {
  return [...listings].sort(compareListings('best_value'));
}

const MIN_MEANINGFUL_SAVINGS = 0.01;
/** A single grocery item saving more than 3x its own price, or more than
 * $50 outright, is not a realistic cross-store comparison — it almost
 * always means the "worst" price it was measured against belongs to a
 * different unit, size, or product entirely. Treated as a sanity ceiling,
 * not a hard business rule: legitimate bulk-size savings can exceed a
 * product's own price (e.g. a 5 lb bag vs. a tiny per-lb price elsewhere),
 * so this only rejects the extreme, clearly-wrong end of that range. */
const MAX_SAVINGS_MULTIPLE_OF_PRICE = 3;
const MAX_REALISTIC_SAVINGS_DOLLARS = 50;

/** Guards every "Save $X" figure before it reaches the UI. Rejects
 * negative/NaN/Infinite results (malformed or mismatched price data) and
 * suspiciously large ones (almost always a unit mismatch slipping past the
 * dimension checks upstream) rather than ever showing a number like
 * "Save $159.89" on an $8 product. */
function isPlausibleSavings(savings: number, productPrice: number): boolean {
  if (!Number.isFinite(savings) || !Number.isFinite(productPrice)) {
    console.log(`[Savings] Rejected: non-finite value (savings=${savings}, productPrice=${productPrice})`);
    return false;
  }
  if (savings <= MIN_MEANINGFUL_SAVINGS) return false;
  if (productPrice <= 0) {
    console.log(`[Savings] Rejected: invalid product price ($${productPrice})`);
    return false;
  }
  if (savings > productPrice * MAX_SAVINGS_MULTIPLE_OF_PRICE || savings > MAX_REALISTIC_SAVINGS_DOLLARS) {
    console.log(
      `[Savings] Rejected: suspiciously large savings $${savings.toFixed(2)} vs product price `
      + `$${productPrice.toFixed(2)} (ratio=${(savings / productPrice).toFixed(1)}x) — hiding badge instead of showing it`,
    );
    return false;
  }
  return true;
}

/** How much buying this one listing's package size would have cost at
 * `worstUnitValue` (the priciest per-unit option in the set being ranked)
 * instead of its own unit price — same "equivalent quantity" math as
 * getBestValueSummary's savings figure, just computed per-listing so
 * `largest_savings` can rank by it. Zero (never negative) when this
 * listing has no unit price, is itself the priciest option, or the result
 * fails `isPlausibleSavings` (see that function for why). */
function savingsValue(listing: EnrichedListing, worstUnitValue: number): number {
  if (!listing.unitPrice || !Number.isFinite(worstUnitValue) || worstUnitValue <= listing.unitPrice.value) return 0;
  const equivalentQuantity = listing.product.price / listing.unitPrice.value;
  const raw = (worstUnitValue - listing.unitPrice.value) * equivalentQuantity;
  return isPlausibleSavings(raw, listing.product.price) ? raw : 0;
}

/** "Intelligent Ordering" within one store's product row — the chosen sort
 * first, popularity (real review rating, never a fabricated score) as the
 * tiebreak. Deliberately never plain total-package-price by default.
 * `largest_savings` is handled as its own pass rather than through
 * `compareListings` since it needs the worst unit price across the whole
 * array being ranked, not just the pair being compared. */
function rankWithinStore(listings: EnrichedListing[], sort: ComparisonSort): EnrichedListing[] {
  if (sort === 'largest_savings') {
    // Only ever compare unit prices measured in the same dimension (weight
    // vs. weight, volume vs. volume, count vs. count) — a group can contain
    // a mix if clustering pulled in a mis-sized or mis-categorized listing,
    // and comparing e.g. a $/oz weight price against a $/fl oz volume price
    // would be exactly the kind of unrelated-field math this feature must
    // never do.
    const withUnitPrice = listings.filter((l) => l.unitPrice != null);
    const byDimension = new Map<UnitDimension, EnrichedListing[]>();
    for (const l of withUnitPrice) {
      const dim = l.unitPrice!.dimension;
      if (!byDimension.has(dim)) byDimension.set(dim, []);
      byDimension.get(dim)!.push(l);
    }
    const worstByDimension = new Map<UnitDimension, number>();
    for (const [dim, group] of byDimension) {
      worstByDimension.set(dim, Math.max(...group.map((l) => l.unitPrice!.value)));
    }
    return [...listings].sort((a, b) => {
      const aWorst = a.unitPrice ? worstByDimension.get(a.unitPrice.dimension) ?? -Infinity : -Infinity;
      const bWorst = b.unitPrice ? worstByDimension.get(b.unitPrice.dimension) ?? -Infinity : -Infinity;
      return savingsValue(b, bWorst) - savingsValue(a, aWorst) || b.product.rating - a.product.rating;
    });
  }
  const cmp = compareListings(sort);
  return [...listings].sort((a, b) => cmp(a, b) || b.product.rating - a.product.rating);
}

export interface BestValueSummary {
  best: EnrichedListing;
  savings: number | null;
}

/** The single "Best Value" recommendation for the comparison screen's
 * featured card — cheapest unit price across every store and every product
 * variant in this group, plus how much buying the same quantity at the
 * priciest option here would have cost, when that's a real, known,
 * plausible number (never a fabricated or mismatched one — see
 * isPlausibleSavings). */
export function getBestValueSummary(listings: EnrichedListing[]): BestValueSummary | null {
  if (listings.length === 0) return null;
  const best = rankByBestValue(listings)[0];

  // Only compare the best pick's unit price against other listings measured
  // in the same dimension — never subtract a $/lb figure from a $/fl oz one,
  // even if a mixed-dimension listing slipped into this group.
  const comparable = best.unitPrice
    ? listings.filter((l) => l.unitPrice != null && l.unitPrice.dimension === best.unitPrice!.dimension)
    : [];
  let savings: number | null = null;
  if (listings.length > 1 && best.unitPrice && comparable.length > 1) {
    const worstUnitValue = Math.max(...comparable.map((l) => l.unitPrice!.value));
    if (worstUnitValue > best.unitPrice.value) {
      // best.product.price / best.unitPrice.value is the best listing's own
      // package size in base units (oz/fl oz/item) — multiplying the
      // per-base-unit price gap by that gives "what buying this same amount
      // would have cost at the priciest option here."
      const equivalentQuantity = best.product.price / best.unitPrice.value;
      const equivalentSavings = (worstUnitValue - best.unitPrice.value) * equivalentQuantity;
      const valid = isPlausibleSavings(equivalentSavings, best.product.price);
      savings = valid ? equivalentSavings : null;
      console.log(
        `[Savings] getBestValueSummary best="${best.product.name}" (${best.product.store}) `
        + `bestUnitValue=$${best.unitPrice.value.toFixed(4)}/${best.unitPrice.dimension} `
        + `worstUnitValue=$${worstUnitValue.toFixed(4)} equivalentQuantity=${equivalentQuantity.toFixed(2)} `
        + `rawSavings=$${equivalentSavings.toFixed(2)} -> ${valid ? `showing $${equivalentSavings.toFixed(2)}` : 'hidden (implausible)'}`,
      );
    }
  }

  return { best, savings };
}

// ─── Per-store browsing sections ──────────────────────────────────────────

export interface StoreSection {
  store: StoreName;
  /** Every matching product this store carries, ranked by rankWithinStore —
   * the horizontally-scrollable row a shopper browses. */
  listings: EnrichedListing[];
  distanceMiles: number | null;
  bestUnitPrice: UnitPrice | null;
  bestPackagePrice: number;
  organicAvailable: boolean;
}

/** Groups already-enriched listings into a "Trader Joe's / Sprouts / Kroger
 * / Aldi" section per carrying store — mirroring how a shopper actually
 * browses one store's aisle rather than a single flattened cross-store
 * ranking. Both the ranking within each store and the order the store
 * sections themselves appear in follow the chosen `sort`. Factored out of
 * `buildStoreSections` so the same store-sectioning logic also powers
 * RefinementSection's "Browse Individual Products" option, which sections
 * a flat, ungrouped pool of listings (every variety a store carries, not
 * one semantic group) rather than a single ProductGroup — see
 * buildStoreSectionsFromProducts below.
 * Cross-store section *order* only distinguishes the sorts a shopper would
 * actually notice at that granularity (total price, distance, organic
 * availability); the newer per-listing-only sorts (unit price, rating,
 * savings) fall through to the default best-unit-price ordering, since
 * that's still the most useful "which store first" signal regardless of
 * exactly how products within each store are ranked. */
function buildStoreSectionsFromListings(
  enriched: EnrichedListing[],
  sort: ComparisonSort = 'best_value',
): StoreSection[] {
  const byStore = new Map<StoreName, EnrichedListing[]>();
  for (const listing of enriched) {
    if (!byStore.has(listing.product.store)) byStore.set(listing.product.store, []);
    byStore.get(listing.product.store)!.push(listing);
  }

  const sections = [...byStore.entries()].map(([store, listings]): StoreSection => {
    const ranked = rankWithinStore(listings, sort);
    const withUnitPrice = ranked.filter((l) => l.unitPrice != null);
    const bestUnitPrice = withUnitPrice.length > 0
      ? withUnitPrice.reduce((best, l) => (l.unitPrice!.value < best.unitPrice!.value ? l : best)).unitPrice
      : null;
    return {
      store,
      listings: ranked,
      distanceMiles: ranked[0]?.distanceMiles ?? null,
      bestUnitPrice,
      bestPackagePrice: Math.min(...ranked.map((l) => l.product.price)),
      organicAvailable: ranked.some((l) => isOrganicProduct(l.product)),
    };
  });

  return sections.sort((a, b) => {
    switch (sort) {
      case 'lowest_total':
        return a.bestPackagePrice - b.bestPackagePrice;
      case 'closest':
        return (a.distanceMiles ?? Infinity) - (b.distanceMiles ?? Infinity);
      case 'organic_first': {
        const ao = a.organicAvailable ? 0 : 1;
        const bo = b.organicAvailable ? 0 : 1;
        return ao - bo || (a.bestUnitPrice?.value ?? Infinity) - (b.bestUnitPrice?.value ?? Infinity);
      }
      case 'best_value':
      default:
        return (a.bestUnitPrice?.value ?? Infinity) - (b.bestUnitPrice?.value ?? Infinity);
    }
  });
}

export function buildStoreSections(
  group: ProductGroup,
  userCoords: Coordinates | null,
  sort: ComparisonSort = 'best_value',
): StoreSection[] {
  return buildStoreSectionsFromListings(enrichListings(group, userCoords), sort);
}

/** Same per-store sectioning, but for a flat pool of listings that spans
 * several semantic groups at once (every apple variety a store carries,
 * not just Fuji) — see enrichProducts for why unit-price nouns are
 * resolved per-listing here instead of from one shared group name. */
export function buildStoreSectionsFromProducts(
  products: ApiProduct[],
  userCoords: Coordinates | null,
  sort: ComparisonSort = 'best_value',
): StoreSection[] {
  return buildStoreSectionsFromListings(enrichProducts(products, userCoords), sort);
}
