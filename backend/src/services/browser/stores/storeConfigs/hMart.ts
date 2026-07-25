/** H Mart — reconnaissance passed (HTTP 200). A "captcha" string is present
 * on the homepage, but confirmed (by checking the surrounding markup) to
 * be a standard reCAPTCHA widget on the site's login/account flow, not a
 * page-blocking challenge — the homepage itself renders normally. */
import type { StoreOnboardingConfig } from './types.ts';

export const hMart: StoreOnboardingConfig = {
  storeName: 'H Mart',
  homepage: 'https://www.hmart.com/',
};
