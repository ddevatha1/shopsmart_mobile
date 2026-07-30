import type { StoreName } from '../models/types';

/**
 * Each store's real logo, bundled locally (not fetched at runtime) since
 * the set of stores is small and fixed — no network dependency, no
 * loading/fallback state needed. Sourced from Wikimedia Commons/Wikipedia
 * (see assets/store-logos/README.md for provenance); used here purely for
 * store identification, the same way any price-comparison app shows a
 * retailer's own mark.
 */
export const storeLogos: Record<StoreName, number> = {
  "Trader Joe's": require('../../assets/store-logos/trader-joes.png'),
  Sprouts: require('../../assets/store-logos/sprouts.png'),
  Kroger: require('../../assets/store-logos/kroger.png'),
  Aldi: require('../../assets/store-logos/aldi.png'),
  Albertsons: require('../../assets/store-logos/albertsons.png'),
  'Harris Teeter': require('../../assets/store-logos/harris-teeter.png'),
};
