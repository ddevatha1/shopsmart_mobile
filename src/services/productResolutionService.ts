import type { ApiProduct, CartItem, SearchResponse } from '../models/types';
import { searchRepository } from '../repositories/searchRepository';
import { useUserStore } from '../store/userStore';

/**
 * Product Resolution (Phase 4.3) — the one place free text (e.g. "milk")
 * gets turned into REAL, verified `ApiProduct` candidates. See
 * docs/assistant_ai_integration_review.md §3: this is deliberately the
 * "search half" of add_to_cart/remove_from_cart's safe design — it never
 * decides which product to act on, only what the real, honest candidate
 * set is. assistantDispatcher.ts owns what happens next (asking the
 * shopper to pick, then confirm) — see its own `dispatchAddToCart`/
 * `dispatchRemoveFromCart`.
 *
 * Never selects automatically when multiple reasonable products exist,
 * never falls back to "cheapest" or "first result" — see
 * `resolveProductRequest`'s own doc comment for the exact rule.
 */

export type ProductResolutionResult =
  | { status: 'resolved'; product: ApiProduct }
  | { status: 'needs_selection'; candidates: ApiProduct[] }
  | { status: 'not_found' };

// A voice/chat follow-up asking "which one?" over more than a handful of
// options stops being usable — capped, not because more candidates
// don't exist, but because presenting them wouldn't actually help the
// shopper choose.
const MAX_CANDIDATES = 8;

export interface ProductResolutionDependencies {
  search: (query: string, zipcode: string) => Promise<SearchResponse>;
  getZipcode: () => string;
}

const defaultDependencies: ProductResolutionDependencies = {
  search: (query, zipcode) => searchRepository.search(query, zipcode),
  getZipcode: () => useUserStore.getState().user?.zipcode ?? '',
};

/**
 * Resolves `query` to real search results via the SAME search service
 * the `search` intent already uses — no new lookup path. Rules:
 *  - Only 'direct' matches are ever candidates — a 'related' match (the
 *    query only appears as an ingredient/component, per the backend's
 *    own relevance classification) isn't a safe thing to add to a real
 *    cart; it may not even be the kind of product the shopper meant.
 *  - Exactly one direct match -> `resolved`. Zero -> `not_found`. More
 *    than one -> `needs_selection` with the real candidate list — NEVER
 *    auto-picked by price, position, or any other heuristic.
 */
export async function resolveProductRequest(
  query: string,
  deps: ProductResolutionDependencies = defaultDependencies,
): Promise<ProductResolutionResult> {
  const trimmed = query.trim();
  if (!trimmed) return { status: 'not_found' };

  const zipcode = deps.getZipcode();
  if (!zipcode) return { status: 'not_found' };

  const response = await deps.search(trimmed, zipcode);
  const direct = response.products.filter((p) => p.matchType !== 'related');

  if (direct.length === 0) return { status: 'not_found' };
  if (direct.length === 1) return { status: 'resolved', product: direct[0] };
  return { status: 'needs_selection', candidates: direct.slice(0, MAX_CANDIDATES) };
}

/**
 * The `remove_from_cart` counterpart — resolves against the shopper's
 * OWN current cart contents, never the full catalog: the candidate
 * universe for "what can I remove" is inherently bounded to what's
 * already there. Pure and synchronous (no network call needed — cart
 * items are already in memory), matching the exact same three-way
 * result shape as `resolveProductRequest` for a consistent caller
 * experience.
 */
export function resolveCartItemForRemoval(query: string, cartItems: CartItem[]): ProductResolutionResult {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return { status: 'not_found' };

  const matches = cartItems
    .map((item) => item.product)
    .filter((product) => {
      const name = product.name.toLowerCase();
      return name.includes(normalizedQuery) || normalizedQuery.includes(name);
    });

  if (matches.length === 0) return { status: 'not_found' };
  if (matches.length === 1) return { status: 'resolved', product: matches[0] };
  return { status: 'needs_selection', candidates: matches.slice(0, MAX_CANDIDATES) };
}
