/**
 * Stater Bros — NOT run through the full discovery pipeline.
 *
 * Live reconnaissance (a plain unauthenticated GET, the same low-risk
 * check used for every other candidate here) returned HTTP 403 with a
 * Cloudflare "Just a moment..." interstitial — an active managed
 * challenge, the same category already confirmed for Meijer/H-E-B/Hy-Vee/
 * WinCo Foods. Kept here as a record only.
 */
import type { StoreOnboardingConfig } from './types.ts';

export const staterBros: StoreOnboardingConfig = {
  storeName: 'Stater Bros',
  homepage: 'https://www.staterbros.com/',
};
