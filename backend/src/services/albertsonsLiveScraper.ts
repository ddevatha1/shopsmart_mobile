/**
 * Albertsons product search — intentionally unimplemented, on purpose, not
 * by oversight.
 *
 * Every other store adapter in this app resolves products from a real,
 * legitimately-reachable source with no user login involved: Kroger's
 * official public developer API, Aldi/Sprouts' anonymous Instacart-platform
 * session, Trader Joe's public storefront GraphQL. Albertsons has no
 * equivalent — its real shopping/product catalog (the "Nimbus" API) sits
 * behind full Okta account authentication (a real username/password, not an
 * app-level API key), the same as scraping a real shopper's logged-in
 * session. That's not a legitimate, stable data source this app has access
 * to, and scraping a personal account's session would be exactly the kind
 * of brittle, ToS-fragile hack this app avoids everywhere else — so this
 * file never fabricates or half-fakes Albertsons product data.
 *
 * `albertsonsLocator.ts` (a real, live, unauthenticated source — see its
 * own header comment) is still fully wired, so Albertsons stores exist and
 * resolve correctly wherever location data alone is useful. Only product
 * search is unavailable.
 *
 * `searchAlbertsons` always resolves to an empty product list — never
 * throws, never blocks the other three stores, never shows a fabricated or
 * stale price — and searchService.ts marks its store status as
 * `'unavailable'` (not `'error'`) so the UI can say "temporarily
 * unavailable" instead of implying something broke. The moment a
 * legitimate product data source exists (the user's own Albertsons
 * developer/business API access, or a future public endpoint), only this
 * one file needs to change — the StoreAdapter-shaped contract
 * (search/normalize/locate) is already in place.
 */
import type { ApiProduct } from '../types/index.ts';
import { createAlbertsonsLocator } from './locators/albertsonsLocator.ts';
import type { PreciseCoords } from './locators/types.ts';

export const albertsonsLocator = createAlbertsonsLocator();

/** Kept for interface-completeness with every other store's `normalize*`
 * export (see the shared StoreAdapter shape in AGENTS.md) — there is no raw
 * Albertsons product shape to normalize from yet, so this is a documented
 * no-op rather than an omitted function other code might assume exists. */
export function normalizeAlbertsonsProduct(): ApiProduct | null {
  return null;
}

export async function searchAlbertsons(_query: string, _zipcode: string, _preciseCoords?: PreciseCoords): Promise<ApiProduct[]> {
  return [];
}

export function searchAlbertsonsWithTimeout(
  query: string,
  zipcode: string,
  _timeoutMs: number,
  preciseCoords?: PreciseCoords,
): Promise<ApiProduct[]> {
  return searchAlbertsons(query, zipcode, preciseCoords);
}

export async function warmAlbertsons(): Promise<void> {
  // No session/token to warm — the locator warms itself independently via
  // warmAlbertsonsDirectory() in albertsonsLocator.ts, called directly from
  // warmupService.ts alongside the other stores' warm-ups.
}
