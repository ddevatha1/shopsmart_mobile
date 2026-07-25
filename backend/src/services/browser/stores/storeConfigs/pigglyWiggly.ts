/** Piggly Wiggly — reconnaissance passed (HTTP 200, no challenge
 * signature). Note: Piggly Wiggly is a franchise with fragmented,
 * independent regional ownership — pigglywiggly.com may be a corporate/
 * directory site rather than a real storefront with product search; the
 * discovery run itself is what determines that, not assumed here. */
import type { StoreOnboardingConfig } from './types.ts';

export const pigglyWiggly: StoreOnboardingConfig = {
  storeName: 'Piggly Wiggly',
  homepage: 'https://www.pigglywiggly.com/',
};
