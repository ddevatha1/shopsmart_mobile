import type { ApiProduct, CartItem, PlanCandidate } from '../models/types';
import { categorizeProduct } from './groceryCategoryService';

// Words too generic/common to prove two product names are "the same kind of
// thing" on their own — a shared token has to clear both this list AND a
// minimum length, since short words like "half"/"free" collide across
// completely unrelated products (see the comment below).
const INSIGNIFICANT_WORDS = new Set([
  'organic', 'natural', 'fresh', 'premium', 'reduced', 'fat', 'free', 'whole',
  'half', 'gallon', 'quart', 'pint', 'ounce', 'ounces', 'pack', 'count', 'size',
  'original', 'classic', 'brand', 'store', 'gluten', 'sugar', 'grade',
]);

function significantTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !INSIGNIFICANT_WORDS.has(w)),
  );
}

function shareSignificantWord(a: string, b: string): boolean {
  const tokensA = significantTokens(a);
  for (const word of significantTokens(b)) {
    if (tokensA.has(word)) return true;
  }
  return false;
}

/** Do these two products look like the same *kind* of item? Requires both a
 * matching grocery category AND a shared significant word in their names —
 * either check alone can be fooled (see the header comment on
 * everyLineMatchesOriginal below for the real case that motivated this). */
export function looksLikeSameProductType(a: ApiProduct, b: ApiProduct): boolean {
  return categorizeProduct(a) === categorizeProduct(b) && shareSignificantWord(a.name, b.name);
}

/**
 * Cart Auto-Optimize's re-optimizer resolves each cart item by searching its
 * exact product name as free text — reliable for typical grocery-list
 * terms, but a long/specific name (e.g. "Kroger Lactose Free 2% Reduced Fat
 * Milk Half Gallon") can occasionally text-match into a wrong department
 * entirely. Found live, twice: it first matched a tea product onto "Half
 * Gallon" (both contain "half"), and even the grocery *category* classifier
 * agreed with that wrong match, because the tea's name happened to also
 * contain "Half and Half" — a real dairy product name, coincidentally.
 * Category alone isn't independent enough (same keyword-matching weakness
 * as the search that caused the mismatch), so looksLikeSameProductType also
 * requires the two product NAMES to share an actual significant word. A
 * plan failing either check is rejected outright, never shown with a
 * caveat: this is exactly the kind of mistake "never show misleading
 * savings" exists to catch.
 */
export function everyLineMatchesOriginal(candidate: PlanCandidate, originalItems: CartItem[]): boolean {
  const originalById = new Map(originalItems.map((i) => [i.product.id, i.product]));
  return candidate.storeAssignments.every((assignment) =>
    assignment.items.every((line) => {
      if (!line.product) return true;
      const original = originalById.get(line.listItemId);
      if (!original) return true;
      if (line.product.id === original.id) return true; // unchanged — trivially fine
      return looksLikeSameProductType(line.product, original);
    }),
  );
}
