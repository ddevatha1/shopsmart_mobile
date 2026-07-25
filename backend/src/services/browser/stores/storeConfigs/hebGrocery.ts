/**
 * H-E-B — compatibility evaluation only, not an integration candidate.
 *
 * Already confirmed, twice (docs/store_api_audit.md, and again this
 * session), to serve an Imperva Incapsula challenge instead of real
 * content — a near-empty response with an Incapsula resource marker, on
 * both the homepage and robots.txt, to a plain unauthenticated request.
 * Included in the discovery run anyway so the actual tool produces a
 * proper structured report rather than carrying over a note from a
 * different check.
 */
import type { StoreOnboardingConfig } from './types.ts';

export const hebGrocery: StoreOnboardingConfig = {
  storeName: 'H-E-B',
  homepage: 'https://www.heb.com/',
};
