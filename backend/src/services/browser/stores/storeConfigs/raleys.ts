/** Raley's — reconnaissance passed (HTTP 200). A "RecaptchaThreshold"
 * config value is present in an embedded config blob, not a page-blocking
 * challenge — the homepage itself renders normally. */
import type { StoreOnboardingConfig } from './types.ts';

export const raleys: StoreOnboardingConfig = {
  storeName: "Raley's",
  homepage: 'https://www.raleys.com/',
};
