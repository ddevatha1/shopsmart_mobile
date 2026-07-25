/**
 * Walmart — compatibility evaluation only, not an integration candidate.
 *
 * Live reconnaissance: a plain GET returns HTTP 200 with real content, but
 * the page source contains multiple live references to PerimeterX bot-
 * management — confirmed infrastructure, not a guess. Whether a real
 * automated browser session gets challenged by it (PerimeterX typically
 * fingerprints browser/JS behavior, which a bare curl request never
 * triggers) is exactly what StoreDiscoveryRunner exists to check, without
 * attempting to solve or bypass anything it finds.
 */
import type { StoreOnboardingConfig } from './types.ts';

export const walmart: StoreOnboardingConfig = {
  storeName: 'Walmart',
  homepage: 'https://www.walmart.com/',
};
