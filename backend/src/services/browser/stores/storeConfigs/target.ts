/**
 * Target — compatibility evaluation only, not an integration candidate.
 *
 * Note independent of technical compatibility: Target's own Terms of
 * Service explicitly prohibit automated data collection
 * (docs/store_api_audit.md). A "technically compatible" result below
 * would still not make this a recommended integration — this evaluation
 * answers "does the site work with this framework," not "should ShopSmart
 * integrate it."
 */
import type { StoreOnboardingConfig } from './types.ts';

export const target: StoreOnboardingConfig = {
  storeName: 'Target',
  homepage: 'https://www.target.com/',
};
