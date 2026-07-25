/**
 * Sprouts / Trader Joe's / Aldi, run through the discovery pipeline as
 * validation controls, not as new integration candidates — all three
 * already have working, production direct-API adapters
 * (sproutsLiveScraper.ts, traderJoesLiveScraper.ts, aldiLiveScraper.ts)
 * that this framework should never replace. The point of testing them
 * here is to have a known-good baseline: if the discovery runner can't
 * score these as compatible, that's a signal something regressed in the
 * framework itself, not a finding about these three stores.
 */
import type { StoreOnboardingConfig } from './types.ts';

export const sproutsValidation: StoreOnboardingConfig = {
  storeName: 'Sprouts (validation control)',
  homepage: 'https://www.sprouts.com/',
};

export const traderJoesValidation: StoreOnboardingConfig = {
  storeName: "Trader Joe's (validation control)",
  homepage: 'https://www.traderjoes.com/home/products',
};

export const aldiValidation: StoreOnboardingConfig = {
  storeName: 'Aldi (validation control)',
  homepage: 'https://www.aldi.us/',
};
