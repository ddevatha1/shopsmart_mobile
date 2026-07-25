/**
 * Harris Teeter — included as a VALIDATION CONTROL, not a new integration
 * candidate. Harris Teeter is already fully supported in production via
 * Kroger's official Products/Locations API (see krogerLiveScraper.ts) — a
 * strictly better data source than browser extraction (documented,
 * credentialed, "Excellent" reliability per docs/store_api_audit.md).
 *
 * The reason to test the generic browser framework against it anyway: the
 * official API gives real ground-truth product data to sanity-check
 * browser-extracted results against, which none of the genuinely-new
 * candidates below can offer. This is not "another way to reach Harris
 * Teeter" — production should keep using the official API regardless of
 * what this config reports.
 *
 * Note: a live connectivity check against harristeeter.com from this
 * environment did not get a clean answer either way (the request didn't
 * complete) — logged here rather than guessed at.
 */
import type { StoreOnboardingConfig } from './types.ts';

export const harrisTeeter: StoreOnboardingConfig = {
  storeName: 'Harris Teeter (validation control)',
  homepage: 'https://www.harristeeter.com/',
};
