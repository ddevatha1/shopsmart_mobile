/**
 * Giant Food — NOT run against, on purpose.
 *
 * Same Ahold Delhaize platform and byte-for-byte identical robots.txt as
 * Food Lion (see foodLion.ts and docs/store_api_audit.md) — the same
 * explicit, machine-readable policy disallowing AI crawlers (including
 * ClaudeBot by name) from the paths a compatibility test would need.
 *
 * Note: "Giant Food" (Ahold Delhaize) is a different company from "Giant
 * Eagle" (independent, Pittsburgh-based) — a real naming collision worth
 * remembering, not the same retailer under a different config.
 *
 * This config exists only as a record. StoreCompatibilityTester has
 * deliberately not been run against it.
 */
import type { StoreOnboardingConfig } from './types.ts';

export const giantFood: StoreOnboardingConfig = {
  storeName: 'Giant Food',
  homepage: 'https://giantfood.com/',
};
