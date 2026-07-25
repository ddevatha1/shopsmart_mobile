/**
 * Whole Foods — compatibility evaluation only, not an integration
 * candidate.
 *
 * Fully integrated into Amazon's ordering/pricing systems
 * (docs/store_api_audit.md) — the same anti-bot/legal risk profile as
 * Amazon.com applies regardless of what wholefoodsmarket.com's own
 * storefront does technically.
 */
import type { StoreOnboardingConfig } from './types.ts';

export const wholeFoods: StoreOnboardingConfig = {
  storeName: 'Whole Foods',
  homepage: 'https://www.wholefoodsmarket.com/',
};
