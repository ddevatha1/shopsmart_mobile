import type { ApiProduct } from '../models/types';
import { isOrganicProduct } from '../utils/filterProducts';
import {
  getUnitPrice,
  isSoldIndividually,
  type AttributeFilterDef,
  type ComparisonSort,
} from './comparisonService';

/**
 * Turns a raw listing pool into a Filter & Sort *schema* — which facets are
 * worth showing and which sort options make sense — the way Amazon adapts
 * "Phone Model / Material / MagSafe" for a phone-case search versus
 * "Serving Size / Whole-2%-Skim / Organic" for milk. There is no
 * structured per-store product-attribute feed to read this from (see
 * groceryCategoryService's and filterProducts.ts's own notes on this — no
 * scraper reliably populates `certifications`), so exactly like those,
 * this is a curated keyword taxonomy applied to `product.name`, not a
 * fabricated one: every facet and every option it offers is generated
 * fresh from *this* result set, and a facet/option that matches nothing
 * currently in view is simply never shown (see the `attr`/`enumAttr`
 * helpers below) — "dynamic" means the values are always real, not that
 * the taxonomy of what to look for is reinvented per search.
 */

// ─── Attribute taxonomy ────────────────────────────────────────────────────

type EnumOption = [value: string, label: string, pattern: RegExp];

function nameOf(product: ApiProduct): string {
  return product.name.toLowerCase();
}

/** A single yes/no facet ("Organic," "Free Range," ...) — included only if
 * at least one listing in the current results actually matches. */
function booleanAttribute(
  key: string,
  label: string,
  predicate: (product: ApiProduct) => boolean,
  listings: ApiProduct[],
): AttributeFilterDef | null {
  if (!listings.some(predicate)) return null;
  return {
    key,
    label,
    options: [{ value: 'yes', label }],
    matches: (product) => predicate(product),
  };
}

function keywordAttribute(key: string, label: string, pattern: RegExp, listings: ApiProduct[]): AttributeFilterDef | null {
  return booleanAttribute(key, label, (p) => pattern.test(nameOf(p)), listings);
}

/** A multi-value facet ("Whole / 2% / Skim," "Jasmine / Basmati / Brown /
 * White," ...) — only the option values genuinely present in the current
 * results are offered, in the taxonomy's own order (not alphabetical —
 * lets the taxonomy put the most common value first). */
function enumAttribute(key: string, label: string, options: EnumOption[], listings: ApiProduct[]): AttributeFilterDef | null {
  const present = options.filter(([, , pattern]) => listings.some((p) => pattern.test(nameOf(p))));
  if (present.length === 0) return null;
  return {
    key,
    label,
    options: present.map(([value, optionLabel]) => ({ value, label: optionLabel })),
    matches: (product, value) => {
      const match = present.find(([v]) => v === value);
      return match != null && match[2].test(nameOf(product));
    },
  };
}

/** A facet built straight from a field's own distinct values ("Brand,"
 * "Store") rather than a keyword taxonomy — only worth showing when the
 * current results actually carry more than one distinct value; a
 * single-store, single-brand result set has nothing to filter there. */
function fieldAttribute(key: string, label: string, getValue: (p: ApiProduct) => string, listings: ApiProduct[]): AttributeFilterDef | null {
  const values = [...new Set(listings.map(getValue).filter((v) => v.length > 0))];
  if (values.length < 2) return null;
  return {
    key,
    label,
    options: values.map((v) => ({ value: v, label: v })),
    matches: (product, value) => getValue(product) === value,
  };
}

// Fat-content synonyms mirror comparisonService's MILK_FAT_SYNONYMS — "2%
// Reduced Fat" and "Low Fat" are store-label wording for the same 2%/1%
// products, not different products, so the filter treats them as the same
// option rather than fragmenting "2%" into two chips a shopper would have
// to know to select both.
const MILK_FAT_OPTIONS: EnumOption[] = [
  ['whole', 'Whole', /\bwhole\b/i],
  ['2%', '2%', /\b2%|\breduced[\s-]*fat\b/i],
  ['1%', '1%', /\b1%|\blow[\s-]*fat\b/i],
  ['skim', 'Skim', /\bskim\b|\bfat[\s-]*free\b|\bnon[\s-]*fat\b/i],
];

const EGG_COLOR_OPTIONS: EnumOption[] = [
  ['brown', 'Brown', /\bbrown\b/i],
  ['white', 'White', /\bwhite\b/i],
];

const BREAD_TYPE_OPTIONS: EnumOption[] = [
  ['whole-wheat', 'Whole Wheat', /\bwhole[\s-]*wheat\b/i],
  ['sourdough', 'Sourdough', /\bsourdough\b/i],
  ['multigrain', 'Multigrain', /\bmulti[\s-]*grain\b/i],
  ['rye', 'Rye', /\brye\b/i],
  ['white', 'White', /\bwhite\b/i],
];

const RICE_TYPE_OPTIONS: EnumOption[] = [
  ['jasmine', 'Jasmine', /\bjasmine\b/i],
  ['basmati', 'Basmati', /\bbasmati\b/i],
  ['wild', 'Wild', /\bwild\b/i],
  ['brown', 'Brown', /\bbrown\b/i],
  ['white', 'White', /\bwhite\b/i],
];

const APPLE_VARIETY_OPTIONS: EnumOption[] = [
  ['fuji', 'Fuji', /\bfuji\b/i],
  ['gala', 'Gala', /\bgala\b/i],
  ['honeycrisp', 'Honeycrisp', /\bhoneycrisp\b/i],
  ['pink-lady', 'Pink Lady', /\bpink[\s-]*lady\b/i],
  ['granny-smith', 'Granny Smith', /\bgranny[\s-]*smith\b/i],
  ['red-delicious', 'Red Delicious', /\bred[\s-]*delicious\b/i],
  ['golden-delicious', 'Golden Delicious', /\bgolden[\s-]*delicious\b/i],
  ['envy', 'Envy', /\benvy\b/i],
  ['jazz', 'Jazz', /\bjazz\b/i],
  ['empire', 'Empire', /\bempire\b/i],
  ['mcintosh', 'McIntosh', /\bmcintosh\b/i],
  ['cortland', 'Cortland', /\bcortland\b/i],
];

/** Which curated attribute set applies — detected from whatever the
 * listings' own names actually say, same "honest keyword signal" approach
 * as groceryCategoryService.categorizeProduct, just one level more
 * specific (finer than the 10-bucket GroceryCategory, e.g. telling milk
 * apart from eggs within "Dairy & Eggs"). Falls back to 'general' (just
 * the universal facets below) for any product kind without its own
 * curated list yet — never a guess at attributes that might not apply. */
type ProductKind = 'milk' | 'eggs' | 'apples' | 'bread' | 'rice' | 'general';

function detectProductKind(listings: ApiProduct[]): ProductKind {
  const blob = listings.map(nameOf).join(' ');
  if (/\bmilk\b/.test(blob)) return 'milk';
  if (/\begg/.test(blob)) return 'eggs';
  if (/\bapple/.test(blob)) return 'apples';
  if (/\bbread\b/.test(blob)) return 'bread';
  if (/\brice\b/.test(blob)) return 'rice';
  return 'general';
}

/** Every facet worth offering for this result set — kind-specific facets
 * first, then the universal ones every category can meaningfully offer. */
export function buildAttributeDefs(listings: ApiProduct[]): AttributeFilterDef[] {
  const kind = detectProductKind(listings);
  const defs: (AttributeFilterDef | null)[] = [];

  if (kind === 'milk') {
    defs.push(enumAttribute('fat-content', 'Type', MILK_FAT_OPTIONS, listings));
    defs.push(keywordAttribute('lactose-free', 'Lactose Free', /\blactose[\s-]*free\b/i, listings));
    defs.push(keywordAttribute('a2', 'A2', /\ba2\b/i, listings));
    defs.push(keywordAttribute('grass-fed', 'Grass Fed', /\bgrass[\s-]*fed\b/i, listings));
  } else if (kind === 'eggs') {
    defs.push(enumAttribute('color', 'Color', EGG_COLOR_OPTIONS, listings));
    defs.push(keywordAttribute('free-range', 'Free Range', /\bfree[\s-]*range\b/i, listings));
    defs.push(keywordAttribute('cage-free', 'Cage Free', /\bcage[\s-]*free\b/i, listings));
    defs.push(keywordAttribute('pasture-raised', 'Pasture Raised', /\bpasture[\s-]*raised\b/i, listings));
  } else if (kind === 'apples') {
    defs.push(enumAttribute('variety', 'Variety', APPLE_VARIETY_OPTIONS, listings));
    defs.push(booleanAttribute('package-type-individual', 'Sold Individually', (p) => isSoldIndividually(p), listings));
  } else if (kind === 'bread') {
    defs.push(enumAttribute('type', 'Type', BREAD_TYPE_OPTIONS, listings));
    defs.push(keywordAttribute('gluten-free', 'Gluten Free', /\bgluten[\s-]*free\b/i, listings));
  } else if (kind === 'rice') {
    defs.push(enumAttribute('type', 'Type', RICE_TYPE_OPTIONS, listings));
  }

  // Universal — meaningful for any category, so always considered
  // regardless of kind.
  defs.push(booleanAttribute('organic', 'Organic', isOrganicProduct, listings));
  defs.push(fieldAttribute('brand', 'Brand', (p) => p.brand, listings));
  defs.push(fieldAttribute('store', 'Store', (p) => p.store, listings));

  return defs.filter((d): d is AttributeFilterDef => d != null);
}

// ─── Serving size ──────────────────────────────────────────────────────────

/** Every distinct package-size string actually present in these listings,
 * in first-seen order — "the available serving sizes should come from
 * actual search results," never an invented list of "typical" sizes. */
export function buildSizeOptions(listings: ApiProduct[]): string[] {
  return [...new Set(listings.map((p) => p.size).filter(Boolean))];
}

// ─── Contextual sort ───────────────────────────────────────────────────────

/** Picks whichever unit label ("lb," "gallon," "egg," "fl oz," "dozen,"
 * ...) most of these listings actually priced out to, so "Lowest Unit
 * Price" can read as "Lowest Price per Lb" for produce/meat, "... per
 * Gallon" for milk/beverages, "... per Egg" for eggs, etc. — the same
 * underlying sort (cheapest normalized price first) in every case, since
 * getUnitPrice already normalizes to the right dimension per product; only
 * the label changes. Returns null when nothing here parsed a unit price at
 * all, in which case the sort option falls back to a generic name. */
function dominantUnitLabel(listings: ApiProduct[]): string | null {
  const counts = new Map<string, number>();
  for (const product of listings) {
    const unit = getUnitPrice(product, product.name);
    if (!unit) continue;
    const suffix = unit.label.split(' / ')[1];
    if (!suffix) continue;
    counts.set(suffix, (counts.get(suffix) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [suffix, count] of counts) {
    if (count > bestCount) {
      best = suffix;
      bestCount = count;
    }
  }
  return best;
}

function capitalize(word: string): string {
  return word.length > 0 ? word[0].toUpperCase() + word.slice(1) : word;
}

/** The Sort By options worth offering for this result set — the universal
 * ones (Best Value, Lowest Unit Price, Lowest Total Price, Closest Store,
 * Highest Rated), relabeling "Lowest Unit Price" to match how these
 * listings are actually priced, plus "Organic First" / "Largest Savings"
 * only when they'd actually mean something here (at least one organic
 * listing; at least two priced listings to have a real gap to save). No
 * "Freshest" option — there's no harvest/expiration data anywhere in
 * ApiProduct to sort by, and inventing one would be exactly the fabricated
 * signal this app's other services (isOrganicProduct, categorizeProduct)
 * are deliberately built to avoid. */
export function buildSortOptions(listings: ApiProduct[]): { value: ComparisonSort; label: string }[] {
  const unitSuffix = dominantUnitLabel(listings);
  const options: { value: ComparisonSort; label: string }[] = [
    { value: 'best_value', label: 'Best Value' },
    { value: 'lowest_unit_price', label: unitSuffix ? `Lowest Price per ${capitalize(unitSuffix)}` : 'Lowest Unit Price' },
    { value: 'lowest_total', label: 'Lowest Total Price' },
    { value: 'closest', label: 'Closest Store' },
    { value: 'highest_rated', label: 'Highest Rated' },
  ];

  if (listings.some(isOrganicProduct)) {
    options.push({ value: 'organic_first', label: 'Organic First' });
  }

  const pricedCount = listings.filter((p) => getUnitPrice(p, p.name) != null).length;
  if (pricedCount >= 2) {
    options.push({ value: 'largest_savings', label: 'Largest Savings' });
  }

  return options;
}

// ─── Whole schema ──────────────────────────────────────────────────────────

export interface FilterSchema {
  sortOptions: { value: ComparisonSort; label: string }[];
  sizeOptions: string[];
  attributes: AttributeFilterDef[];
}

/** Everything CompareScreen's Filter & Sort sheet needs, generated fresh
 * from one call — callers should build this from the group's *unfiltered*
 * listings (so picking a filter never makes its own option disappear) and
 * memoize on that array reference; see CompareScreen's useMemo, which is
 * the "cache generated filter schemas" this module relies on rather than
 * maintaining a second memoization layer of its own. */
export function buildFilterSchema(listings: ApiProduct[]): FilterSchema {
  return {
    sortOptions: buildSortOptions(listings),
    sizeOptions: buildSizeOptions(listings),
    attributes: buildAttributeDefs(listings),
  };
}
