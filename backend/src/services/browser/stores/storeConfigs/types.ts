/**
 * The minimal, purely-declarative shape a new store needs to supply to
 * onboard onto the generic browser-extraction framework — no functions
 * required (unlike `BrowserStoreConfig` in `../../types.ts`, which this
 * gets converted into — see `StoreRegistry.ts`'s `toBrowserStoreConfig`).
 * The goal this shape is designed for: writing one of these is a
 * five-minute task, not a new scraper file.
 */
export interface StoreOnboardingConfig {
  storeName: string;
  /** The page to load first — a plain storefront homepage is enough; the
   * generic search-input detection (see BrowserAdapter.ts) takes it from
   * there unless `buildSearchUrl` is given below. */
  homepage: string;
  /** Only needed if the generic search-input selector heuristics fail for
   * this specific site's markup. */
  searchInputSelector?: string;
  /** A CSS selector for a delivery-zip/postal-code input, only needed if
   * the generic zip-input heuristic (see BrowserAdapter.ts) can't find it
   * on its own. */
  locationSelector?: string;
  /** Only needed for sites whose search-results page is reachable via a
   * plain URL query param — when omitted, the framework just loads
   * `homepage` and types into whatever search box it finds there. */
  buildSearchUrl?(query: string, zipcode?: string): string;
}
