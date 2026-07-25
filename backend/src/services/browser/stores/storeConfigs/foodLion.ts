/**
 * Food Lion — NOT run against, on purpose.
 *
 * This retailer's shared robots.txt (confirmed live this session — see
 * docs/store_api_audit.md, "Ahold Delhaize family") explicitly names
 * ClaudeBot, GPTBot, ChatGPT-User, PerplexityBot, and Google-Extended as
 * disallowed from `/product/`, `/product-search/`, and `/browse-aisles/` —
 * exactly the paths a compatibility test would need to load. That's a
 * machine-readable, explicit access policy addressed to this exact class
 * of agent, not a generic "might be risky" caution.
 *
 * This config exists only as a record of a real candidate that was
 * considered. StoreCompatibilityTester has deliberately not been run
 * against it, and shouldn't be without a separate, explicit decision to
 * override that policy.
 */
import type { StoreOnboardingConfig } from './types.ts';

export const foodLion: StoreOnboardingConfig = {
  storeName: 'Food Lion',
  homepage: 'https://www.foodlion.com/',
};
