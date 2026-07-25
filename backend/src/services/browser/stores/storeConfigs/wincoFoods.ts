/**
 * WinCo Foods — reconnaissance done, compatibility testing not run.
 *
 * A plain, unauthenticated request to wincofoods.com (the same low-risk
 * check this app already ran for Meijer/H-E-B/Hy-Vee — see
 * docs/store_api_audit.md) returned an active Cloudflare *managed
 * challenge* (a JS/interactive challenge page — "Just a moment...",
 * `cType: 'managed'` — not a static block) on both the homepage and
 * `robots.txt`. That puts WinCo in the same confirmed-live-bot-defense
 * category as Meijer/H-E-B/Hy-Vee, not "unconfirmed."
 *
 * Kept here as a record of that finding, not as something
 * StoreCompatibilityTester should be run against without first deciding
 * whether to proceed past a confirmed challenge wall.
 */
import type { StoreOnboardingConfig } from './types.ts';

export const wincoFoods: StoreOnboardingConfig = {
  storeName: 'WinCo Foods',
  homepage: 'https://www.wincofoods.com/',
};
