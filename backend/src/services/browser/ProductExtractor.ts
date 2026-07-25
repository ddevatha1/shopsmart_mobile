/**
 * The "JSON detector" + "product object finder" stage: given an arbitrary
 * JSON blob captured from a live network response — any grocery site, any
 * schema, never seen before — recursively finds objects that look like
 * real products, with no per-store knowledge of field names. Works by
 * matching a generic set of common aliases for each canonical product
 * field (every storefront calls "price" something slightly different) and
 * requiring at least a name + a plausible price before anything counts as
 * a candidate at all.
 *
 * The one deliberate anti-false-positive rule, beyond field matching: a
 * candidate only counts if it appeared alongside *multiple* similarly-
 * shaped siblings inside the same array. A lone object that happens to
 * have a "name" and a "price" field — a page's "current store" banner, a
 * promo card, a nav breadcrumb — is far more likely to be a coincidental
 * field-name collision than an actual product. A real product-search
 * response is a *list* of many products shaped the same way; requiring
 * that shared shape is what keeps this generic instead of a pile of
 * one-off exceptions per false-positive type this app happens to have
 * seen. Relevance to the shopper's actual query is deliberately NOT this
 * file's job — see SearchRanker.ts — so an unrelated-but-genuine product
 * list (e.g. "recommended for you") still produces valid candidates here;
 * filtering those out is a ranking problem, not a detection problem.
 */
import type { CanonicalField, FieldMatch, ProductCandidate } from './types.ts';

const FIELD_ALIASES: Record<CanonicalField, string[]> = {
  name: ['name', 'title', 'productName', 'itemName', 'itemTitle', 'item_title', 'displayName', 'description'],
  price: ['price', 'regularPrice', 'unitPrice', 'priceValue', 'currentPrice', 'salePrice', 'amount', 'listPrice'],
  id: ['id', 'productId', 'sku', 'itemId', 'pid', 'gtin'],
  upc: ['upc', 'gtin', 'barcode'],
  image: ['image', 'imageUrl', 'image_url', 'thumbnail', 'thumbnailUrl', 'photo', 'img', 'primary_image', 'primaryImage'],
  category: ['category', 'categoryName', 'productCategory', 'categoryPath'],
  department: ['department', 'departmentName'],
  aisle: ['aisle', 'aisleName', 'aisleLocation'],
  brand: ['brand', 'brandName', 'manufacturer'],
  promotions: ['promotions', 'promotion', 'onSale', 'dealBadge', 'badges'],
  availability: ['inStock', 'available', 'availability', 'stockStatus'],
};

// Only these two are load-bearing — everything else is bonus confidence
// signal. Requiring more (e.g. an image) would silently drop real product
// lists from sites whose search response happens to load images lazily.
const REQUIRED_FIELDS: CanonicalField[] = ['name', 'price'];

const MIN_SIBLINGS = 2;
const MAX_NAME_LENGTH = 200; // real product titles aren't paragraphs — filters out marketing copy blocks
const MIN_PLAUSIBLE_PRICE = 0.01;
const MAX_PLAUSIBLE_PRICE = 1000; // a generous grocery-price sanity ceiling, not a hard domain rule

const MAX_NESTED_PRICE_DEPTH = 3;
const PRICE_KEY_HINTS = ['price', 'amount', 'value', 'regular', 'current', 'cost'];

/** Real storefronts wrap price under all kinds of view-model shapes — a
 * fixed guess-list of sub-key names (`{ amount }`, `{ value }`, ...) covers
 * some, but not e.g. Aldi/Sprouts' own real shape,
 * `price.viewSection.priceValueString` (confirmed live in this app's own
 * aldiLiveScraper.ts/sproutsLiveScraper.ts). Rather than hardcode that one
 * more shape too — the whole point of this framework is not needing to —
 * this recurses a bounded depth into whatever object shape it finds,
 * trying keys whose *name* still hints at price/amount/value first, and
 * falling back to any other nested leaf that parses as a plausible number.
 * A strict string-format check (only things that actually look like a
 * price, not any string that happens to contain digits) keeps this from
 * false-matching an arbitrary numeric-looking string field. */
function coercePrice(value: unknown, depth = 0): number | null {
  if (depth > MAX_NESTED_PRICE_DEPTH) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === 'string') {
    if (!/^\s*\$?\s*\d+(\.\d{1,2})?\s*$/.test(value)) return null;
    const parsed = parseFloat(value.replace(/[^0-9.]/g, ''));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    const [hinted, rest] = [
      entries.filter(([k]) => PRICE_KEY_HINTS.some(hint => k.toLowerCase().includes(hint))),
      entries.filter(([k]) => !PRICE_KEY_HINTS.some(hint => k.toLowerCase().includes(hint))),
    ];
    for (const [, v] of [...hinted, ...rest]) {
      const inner = coercePrice(v, depth + 1);
      if (inner !== null) return inner;
    }
  }
  return null;
}

function coerceStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const strings = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    return strings.length > 0 ? strings : undefined;
  }
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (value === true) return ['On Sale'];
  return undefined;
}

function matchFields(obj: Record<string, unknown>): FieldMatch[] {
  const matches: FieldMatch[] = [];
  for (const field of Object.keys(FIELD_ALIASES) as CanonicalField[]) {
    for (const alias of FIELD_ALIASES[field]) {
      if (!(alias in obj)) continue;
      const raw = obj[alias];
      if (raw === null || raw === undefined) continue;

      if (field === 'price') {
        const price = coercePrice(raw);
        if (price === null || price < MIN_PLAUSIBLE_PRICE || price > MAX_PLAUSIBLE_PRICE) continue;
        matches.push({ field, sourceKey: alias, value: price });
        break;
      }
      if (field === 'name') {
        if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > MAX_NAME_LENGTH) continue;
        matches.push({ field, sourceKey: alias, value: raw.trim() });
        break;
      }
      if (field === 'promotions') {
        const arr = coerceStringArray(raw);
        if (!arr) continue;
        matches.push({ field, sourceKey: alias, value: arr });
        break;
      }
      matches.push({ field, sourceKey: alias, value: raw });
      break;
    }
  }
  return matches;
}

function hasRequiredFields(matches: FieldMatch[]): boolean {
  return REQUIRED_FIELDS.every(f => matches.some(m => m.field === f));
}

function confidenceFor(matches: FieldMatch[]): number {
  const totalPossible = Object.keys(FIELD_ALIASES).length;
  const distinctFields = new Set(matches.map(m => m.field)).size;
  return Math.min(1, distinctFields / totalPossible);
}

/** Recursively walks a JSON value, collecting objects from any array whose
 * elements look like products — keeping only arrays with at least
 * MIN_SIBLINGS qualifying elements (the shared-shape signal described
 * above). Walks into every element regardless of whether the array itself
 * qualified, since a real product list can be nested several envelope
 * objects deep, and a single response can legitimately contain more than
 * one such list. */
export function findProductCandidates(value: unknown, sourceUrl: string): ProductCandidate[] {
  const candidates: ProductCandidate[] = [];

  function walk(node: unknown): void {
    if (Array.isArray(node)) {
      const qualifying: { obj: Record<string, unknown>; matches: FieldMatch[] }[] = [];
      for (const item of node) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const matches = matchFields(item as Record<string, unknown>);
          if (hasRequiredFields(matches)) qualifying.push({ obj: item as Record<string, unknown>, matches });
        }
      }
      if (qualifying.length >= MIN_SIBLINGS) {
        for (const { obj, matches } of qualifying) {
          candidates.push({ raw: obj, matches, confidence: confidenceFor(matches), sourceUrl });
        }
      }
      for (const item of node) walk(item);
      return;
    }
    if (node && typeof node === 'object') {
      for (const v of Object.values(node as Record<string, unknown>)) walk(v);
    }
  }

  walk(value);
  return candidates;
}
