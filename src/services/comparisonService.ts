import type { ApiProduct, StoreName } from '../models/types';
import { categorizeProduct, type GroceryCategory } from './groceryCategoryService';
import { isOrganicProduct } from '../utils/filterProducts';
import { haversineDistanceMiles } from '../utils/geo';
import type { Coordinates } from './locationService';

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
  'pre', 'cut', 'sliced', 'a', 'an', 'the', 'of', 'and', 'with', 'in', 'from', 'for',
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

/** Canonical grouping key — two listings (any store) that reduce to the same
 * key are the "same product" for comparison purposes.
 *
 * Strips the listing's own `brand` out of its name before keying — every
 * store scraper carries brand as its own field, separate from `name` (see
 * e.g. krogerLiveScraper/aldiLiveScraper), specifically because a brand
 * prefix ("Sprouts Organic Whole Milk," "Simply Nature ...," "Simple Truth
 * ...," "Organic Valley ...") is store- or label-specific dressing on top
 * of the same underlying product, not part of what the product *is*. Left
 * unstripped, every private-label and every differently-branded national
 * item fragments into its own single-store Stage-1 category — this is the
 * general form of "Sprouts' milk didn't show up in the Milk category," and
 * it applies to every product, not just milk, since every store's listings
 * carry a brand prefix the same way. */
function getGroupKey(product: ApiProduct): string {
  const brandWords = new Set(tokenize(product.brand ?? '').map(singularize));
  const words = tokenize(canonicalizeFatContentWording(product.name))
    .map(singularize)
    .filter((w) => {
      if (brandWords.has(w)) return false;
      if (GROUP_FILLER_WORDS.has(w)) return false;
      if (GROUP_UNIT_WORDS.has(w) || GROUP_UNIT_WORDS.has(singularize(w))) return false;
      if (isNumericToken(w)) return false;
      // A lone letter is never a product's identity on its own — it's
      // almost always the tail end of a multi-word brand already stripped
      // above (e.g. "Simple Truth" leaving a stray "s" behind is not a
      // concern here, but a defensive floor is still worth keeping).
      if (w.length === 1) return false;
      return true;
    });
  return [...new Set(words)].sort().join(' ');
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
}

/** A listing's name with its own `brand` words removed, whitespace and
 * stray leading/trailing punctuation cleaned up — same rule as the
 * subtitle above (never expose a single store's/private-label's brand on
 * a Stage-1 card), just applied to `name` instead of a separate caption.
 * Falls back to the untouched name if stripping the brand would leave
 * nothing (a bare brand name with no other words). */
function stripBrandFromDisplayName(product: ApiProduct): string {
  const brandWords = tokenize(product.brand ?? '');
  if (brandWords.length === 0) return product.name;

  let cleaned = product.name;
  for (const word of brandWords) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cleaned = cleaned.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), '');
  }
  cleaned = cleaned.replace(/\s{2,}/g, ' ').replace(/^[\s,.\-]+|[\s,.\-]+$/g, '').trim();
  return cleaned.length > 0 ? cleaned : product.name;
}

function buildGroupEntry(id: string, listings: ApiProduct[]): ProductGroup {
  // The shortest brand-free name is the most "canonical" — least likely to
  // carry leftover store-specific marketing copy — so it becomes the
  // group's display name.
  const candidates = listings.map((p) => ({ product: p, displayName: stripBrandFromDisplayName(p) }));
  const representative = candidates.reduce((shortest, c) =>
    c.displayName.length < shortest.displayName.length ? c : shortest, candidates[0]);
  const storeCount = new Set(listings.map((p) => p.store)).size;

  return {
    id,
    name: representative.displayName,
    subtitle: `${storeCount} store${storeCount !== 1 ? 's' : ''}`,
    storeCount,
    category: categorizeProduct(representative.product),
    image_url: representative.product.image_url,
    listings,
  };
}

/** True for a listing genuinely sold as one piece — a real, parsed signal
 * (see parseSize below), never a guess: "1 ct"/"Each"/"Ea" parse to a count
 * of exactly 1, whereas a "4 ct" multi-pack or a per-pound bulk listing do
 * not. Absent or unparseable size info defaults to false — never assumed. */
function isSoldIndividually(product: ApiProduct): boolean {
  const parsed = parseSize(product.size);
  return parsed != null && parsed.dimension === 'count' && parsed.amount <= 1;
}

/** Groups a set of "direct match" listings (never `related` ones — those
 * stay in the existing tangential-matches section) into one card per
 * semantic product, spanning every store that carries it.
 *
 * When a semantic group mixes true per-piece listings ("Roma Tomato, Each")
 * with bulk ones (a bag, or priced by the pound), it's split into two
 * separate Stage 1 cards — shoppers buying "one tomato" and shoppers buying
 * "a bag of tomatoes" are making a different decision, and collapsing them
 * into one comparison would hide that. The split only happens when both
 * kinds actually coexist in this search's results; a category sold only one
 * way keeps its plain name, no "(Single)" qualifier needed. */
export function buildProductGroups(products: ApiProduct[]): ProductGroup[] {
  const byKey = new Map<string, ApiProduct[]>();
  const order: string[] = [];
  for (const product of products) {
    const key = getGroupKey(product);
    if (!key) continue;
    if (!byKey.has(key)) {
      byKey.set(key, []);
      order.push(key);
    }
    byKey.get(key)!.push(product);
  }

  const result: ProductGroup[] = [];
  for (const key of order) {
    const listings = byKey.get(key)!;
    const singlePiece = listings.filter(isSoldIndividually);
    const bulk = listings.filter((p) => !isSoldIndividually(p));

    let baseName: string | null = null;
    if (bulk.length > 0) {
      const bulkGroup = buildGroupEntry(key, bulk);
      baseName = bulkGroup.name;
      result.push(bulkGroup);
    }
    if (singlePiece.length > 0) {
      const singleGroup = buildGroupEntry(`${key}__single`, singlePiece);
      if (baseName) singleGroup.name = `${baseName} (Single)`;
      result.push(singleGroup);
    }
  }
  return result;
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
  value: number;
  label: string;
}

/** The normalized, comparable price for one listing — e.g. "$0.62 / apple",
 * "$0.31 / oz", "$4.20 / lb", "$0.05 / fl oz", "$2.80 / gallon". */
export function getUnitPrice(product: ApiProduct, groupName: string): UnitPrice | null {
  const parsed = parseSize(product.size);
  if (!parsed || parsed.amount <= 0) return null;

  if (parsed.dimension === 'count') {
    if (parsed.amount >= 12) {
      return { value: (product.price / parsed.amount) * 12, label: `$${((product.price / parsed.amount) * 12).toFixed(2)} / dozen` };
    }
    const noun = singularHeadNoun(groupName);
    const value = product.price / parsed.amount;
    return { value, label: `$${value.toFixed(2)} / ${noun}` };
  }

  if (parsed.dimension === 'weight') {
    if (parsed.amount >= 16) {
      const value = (product.price / parsed.amount) * 16;
      return { value, label: `$${value.toFixed(2)} / lb` };
    }
    const value = product.price / parsed.amount;
    return { value, label: `$${value.toFixed(2)} / oz` };
  }

  // volume
  if (parsed.amount >= 64) {
    const value = (product.price / parsed.amount) * 128;
    return { value, label: `$${value.toFixed(2)} / gallon` };
  }
  const value = product.price / parsed.amount;
  return { value, label: `$${value.toFixed(2)} / fl oz` };
}

// ─── Comparison ranking ────────────────────────────────────────────────────

export interface EnrichedListing {
  product: ApiProduct;
  unitPrice: UnitPrice | null;
  distanceMiles: number | null;
}

export function enrichListings(
  group: ProductGroup,
  userCoords: Coordinates | null,
): EnrichedListing[] {
  return group.listings.map((product) => ({
    product,
    unitPrice: getUnitPrice(product, group.name),
    distanceMiles:
      userCoords && product.location?.latitude != null && product.location?.longitude != null
        ? haversineDistanceMiles(userCoords, {
            latitude: product.location.latitude,
            longitude: product.location.longitude,
          })
        : null,
  }));
}

/** The comparison screen's Filter & Sort options — moved here (off Stage 1)
 * since sorting/filtering only makes sense once a shopper has already
 * picked one category to compare. */
export type ComparisonSort = 'best_value' | 'lowest_total' | 'closest' | 'organic_first';

export interface ComparisonFilters {
  sort: ComparisonSort;
  inStockOnly: boolean;
  organicOnly: boolean;
  /** Empty set = every package size included. */
  sizes: Set<string>;
}

export function defaultComparisonFilters(): ComparisonFilters {
  return { sort: 'best_value', inStockOnly: false, organicOnly: false, sizes: new Set() };
}

export function countActiveComparisonFilters(filters: ComparisonFilters): number {
  let count = 0;
  if (filters.sort !== 'best_value') count += 1;
  if (filters.inStockOnly) count += 1;
  if (filters.organicOnly) count += 1;
  if (filters.sizes.size > 0) count += 1;
  return count;
}

/** Availability/Organic/Package Size filters, applied to a group's raw
 * listings before anything downstream (hero pick, store sections) ever
 * sees them — so every part of the comparison screen agrees on what's
 * actually in view. */
export function applyComparisonFilters(listings: ApiProduct[], filters: ComparisonFilters): ApiProduct[] {
  return listings.filter((p) => {
    if (filters.inStockOnly && p.inStock === false) return false;
    if (filters.organicOnly && !isOrganicProduct(p)) return false;
    if (filters.sizes.size > 0 && !filters.sizes.has(p.size)) return false;
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
 * (whatever sort the shopper picked in Filter & Sort). */
function compareListings(sort: ComparisonSort) {
  return (a: EnrichedListing, b: EnrichedListing): number => {
    switch (sort) {
      case 'lowest_total':
        return a.product.price - b.product.price || compareByUnitPrice(a, b);
      case 'closest':
        return (a.distanceMiles ?? Infinity) - (b.distanceMiles ?? Infinity) || compareByUnitPrice(a, b);
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

/** "Intelligent Ordering" within one store's product row — the chosen sort
 * first, popularity (real review rating, never a fabricated score) as the
 * tiebreak. Deliberately never plain total-package-price by default. */
function rankWithinStore(listings: EnrichedListing[], sort: ComparisonSort): EnrichedListing[] {
  const cmp = compareListings(sort);
  return [...listings].sort((a, b) => cmp(a, b) || b.product.rating - a.product.rating);
}

export interface BestValueSummary {
  best: EnrichedListing;
  savings: number | null;
}

const MIN_MEANINGFUL_SAVINGS = 0.01;

/** The single "Best Value" recommendation for the comparison screen's
 * featured card — cheapest unit price across every store and every product
 * variant in this group, plus how much buying the same quantity at the
 * priciest option here would have cost, when that's a real, known number. */
export function getBestValueSummary(listings: EnrichedListing[]): BestValueSummary | null {
  if (listings.length === 0) return null;
  const best = rankByBestValue(listings)[0];

  const withUnitPrice = listings.filter((l) => l.unitPrice != null);
  let savings: number | null = null;
  if (listings.length > 1 && best.unitPrice && withUnitPrice.length > 1) {
    const worstUnitValue = Math.max(...withUnitPrice.map((l) => l.unitPrice!.value));
    if (worstUnitValue > best.unitPrice.value) {
      // best.product.price / best.unitPrice.value is the best listing's own
      // package size expressed in the unit price's display unit (e.g. how
      // many lbs/dozens/gallons it holds) — multiplying the per-unit price
      // gap by that gives "what buying this same amount would have cost at
      // the priciest option here," in the same terms the card displays.
      const equivalentQuantity = best.product.price / best.unitPrice.value;
      const equivalentSavings = (worstUnitValue - best.unitPrice.value) * equivalentQuantity;
      savings = equivalentSavings > MIN_MEANINGFUL_SAVINGS ? equivalentSavings : null;
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

/** Splits one product group's listings into a "Trader Joe's / Sprouts /
 * Kroger / Aldi" section per carrying store — mirroring how a shopper
 * actually browses one store's aisle rather than a single flattened
 * cross-store ranking. Both the ranking within each store and the order the
 * store sections themselves appear in follow the chosen `sort` (Filter &
 * Sort, scoped to this comparison screen — see ComparisonSort). */
export function buildStoreSections(
  group: ProductGroup,
  userCoords: Coordinates | null,
  sort: ComparisonSort = 'best_value',
): StoreSection[] {
  const enriched = enrichListings(group, userCoords);
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
