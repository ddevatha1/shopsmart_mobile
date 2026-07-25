/**
 * Wegmans — NOT run against, on purpose.
 *
 * Classified "Not Recommended" in docs/store_api_audit.md specifically for
 * a documented real-world history of actively pursuing unauthorized-access
 * enforcement — a legal/policy risk, independent of whatever the technical
 * feasibility turns out to be. High user demand doesn't change that
 * calculus (see the audit's own reasoning for Publix, the same category).
 *
 * This config exists only as a record. StoreCompatibilityTester has
 * deliberately not been run against it.
 */
import type { StoreOnboardingConfig } from './types.ts';

export const wegmans: StoreOnboardingConfig = {
  storeName: 'Wegmans',
  homepage: 'https://www.wegmans.com/',
};
