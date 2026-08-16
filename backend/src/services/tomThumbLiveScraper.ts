/**
 * Tom Thumb product search — intentionally unimplemented, on purpose, not
 * by oversight. Read this before assuming a scraper "just needs more work."
 *
 * Tom Thumb (an Albertsons Companies banner) DOES expose a real, unauthenticated
 * product-search endpoint with no account/login wall at all:
 *
 *   GET /abs/pub/xapi/pgmsearch/v1/search/products
 *       ?q={query}&storeid={id}&banner=tomthumb&...
 *
 * Confirmed live: typing a real query into tomthumb.com's own search box
 * returns real per-store prices, sale badges, SNAP eligibility, and ratings
 * with zero sign-in required (only *adding an item to cart* prompts "Sign
 * in to add"). That's a materially better situation than Albertsons.com's
 * own product catalog (see albertsonsLiveScraper.ts, which is gated behind
 * full Okta account auth) — so this might look like the obvious next
 * scraper to build the same way as Aldi/Sprouts/Trader Joe's. It isn't, for
 * a specific, verified reason:
 *
 * This endpoint sits behind Akamai Bot Manager, and — unlike aldi.us or
 * shop.sprouts.com — it silently drops (not rejects: the connection simply
 * never completes a response, no 403, no captcha page) any request that
 * doesn't originate from genuine, un-instrumented human interaction in a
 * real browser tab. Verified four independent ways against this exact URL;
 * all four hung until timeout with no response at all:
 *   1. A plain `curl`, even carrying the correct `ocp-apim-subscription-key`
 *      (that same key, extracted the same way, works fine against the
 *      *store-resolver* endpoint below — see tomThumbLocator.ts — which has
 *      no such protection; this isn't a bad key, it's endpoint-specific).
 *   2. Playwright's bare `request.newContext()` (no browser at all).
 *   3. A real headless Chromium launched via this app's own
 *      `launchChromium()`, with the exact stealth patches
 *      traderJoesLiveScraper.ts/sproutsLiveScraper.ts already use
 *      (`navigator.webdriver` override, container-safe launch args) — even
 *      AFTER a full, real page load of tomthumb.com's own search-results
 *      page, an in-page `fetch()` to this same URL still hangs.
 *   4. JavaScript injected via Chrome DevTools Protocol into an actual,
 *      full, non-headless, human Chrome browser (not Playwright) — the
 *      exact same in-page `fetch()` call a real user's own typing and
 *      Enter key reliably succeeds at (confirmed: typing "apples" into the
 *      real search box returns real results every time) hangs the instant
 *      it's invoked via CDP's `Runtime.evaluate` instead of genuine UI
 *      input.
 *
 * Result (4) is the tell: it isn't the TLS fingerprint or missing cookies —
 * Akamai is detecting CDP-driven script execution itself, inside an
 * otherwise completely real, human-operated browser. There's no version of
 * "run this from Node" or "drive a browser from Node" that gets past that;
 * only genuine, un-instrumented human interaction does. Making this
 * reliable would mean either a paid residential-proxy/anti-fingerprint
 * bypass service, or literally keeping a real, continuously human-operated
 * browser session running as backend infrastructure — both well outside
 * what this app does anywhere else, and exactly the kind of brittle,
 * ToS-fragile approach albertsonsLiveScraper.ts's own header comment
 * already rejected for this same corporate family. This file makes the
 * same call, for a different but equally solid reason: intentionally
 * empty, never faked, never half-implemented against a schema nobody ever
 * actually saw (every attempt above was blocked before a real response
 * body was ever obtained, so there is no verified product JSON shape to
 * normalize from either).
 *
 * `tomThumbLocator.ts` (a real, live, unauthenticated source — its own
 * store-resolver and local.tomthumb.com endpoints have no such protection)
 * is still fully wired, so Tom Thumb stores exist and resolve correctly
 * wherever location data alone is useful. Only product search is
 * unavailable — searchService.ts marks its store status as `'unavailable'`
 * (not `'error'`), same as Albertsons, so the UI can say "temporarily
 * unavailable" instead of implying something broke.
 */
import type { ApiProduct } from '../types/index.ts';
import { createTomThumbLocator } from './locators/tomThumbLocator.ts';
import type { PreciseCoords } from './locators/types.ts';

export const tomThumbLocator = createTomThumbLocator();

/** Kept for interface-completeness with every other store's `normalize*`
 * export (see aldiLiveScraper.ts/sproutsLiveScraper.ts/traderJoesLiveScraper.ts/
 * krogerLiveScraper.ts) — there is no verified raw Tom Thumb product JSON
 * shape to normalize from (see this file's header comment), so this is a
 * documented no-op rather than an omitted function other code might assume
 * exists. */
export function normalizeTomThumbProduct(): ApiProduct | null {
  return null;
}

export async function searchTomThumb(
  _query: string,
  _zipcode: string,
  _preciseCoords?: PreciseCoords,
): Promise<ApiProduct[]> {
  return [];
}

export function searchTomThumbWithTimeout(
  query: string,
  zipcode: string,
  _timeoutMs: number,
  preciseCoords?: PreciseCoords,
): Promise<ApiProduct[]> {
  return searchTomThumb(query, zipcode, preciseCoords);
}

export async function warmTomThumb(): Promise<void> {
  // No session/token to warm for product search (there is none — see this
  // file's header comment). The locator warms itself independently via
  // warmTomThumb in tomThumbLocator.ts, called directly from
  // warmupService.ts alongside the other stores' warm-ups.
}
