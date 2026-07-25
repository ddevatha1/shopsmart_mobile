/** Grocery Outlet — reconnaissance passed (HTTP 200). A "captcha" string is
 * present, confirmed to be a Gravity Forms reCAPTCHA field (a contact/
 * feedback form), not a page-blocking challenge. */
import type { StoreOnboardingConfig } from './types.ts';

export const groceryOutlet: StoreOnboardingConfig = {
  storeName: 'Grocery Outlet',
  homepage: 'https://www.groceryoutlet.com/',
};
