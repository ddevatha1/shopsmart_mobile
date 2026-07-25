/**
 * The store-onboarding registry — a lookup of every store the generic
 * browser framework has a config for, plus the one piece of translation
 * work needed to actually run one: converting the lean, purely-declarative
 * `StoreOnboardingConfig` (see storeConfigs/types.ts) into the
 * `BrowserStoreConfig` shape `BrowserAdapter.ts`'s engine already expects.
 *
 * That engine is untouched by this file — a `locationSelector` string just
 * becomes a generic fill-and-submit `setLocation` function here, and a
 * missing `buildSearchUrl` means "start from the homepage and let the
 * framework's own search-input detection do the rest," exactly how this
 * framework was already validated against Trader Joe's/Aldi.
 */
import type { Page } from 'playwright';
import type { StoreLocation } from '../../../types/index.ts';
import type { BrowserStoreConfig } from '../types.ts';
import { STORE_CONFIGS } from './storeConfigs/index.ts';
import type { StoreOnboardingConfig } from './storeConfigs/types.ts';

export type { StoreOnboardingConfig };

const registry = new Map<string, StoreOnboardingConfig>(STORE_CONFIGS.map(c => [c.storeName, c]));

/** Adds or replaces a store config at runtime — the same "minutes, not
 * days" onboarding path also works without editing storeConfigs/index.ts,
 * e.g. from a quick script while iterating on a new store. */
export function registerStore(config: StoreOnboardingConfig): void {
  registry.set(config.storeName, config);
}

export function getStoreConfig(storeName: string): StoreOnboardingConfig | undefined {
  return registry.get(storeName);
}

export function listStores(): StoreOnboardingConfig[] {
  return [...registry.values()];
}

export function toBrowserStoreConfig(config: StoreOnboardingConfig, location?: StoreLocation): BrowserStoreConfig {
  return {
    storeName: config.storeName,
    buildSearchUrl: config.buildSearchUrl ?? (() => config.homepage),
    searchInputSelector: config.searchInputSelector,
    location,
    setLocation: config.locationSelector
      ? async (page: Page, zipcode: string): Promise<void> => {
          const input = page.locator(config.locationSelector!).first();
          if ((await input.count().catch(() => 0)) === 0) return;
          if (!(await input.isVisible().catch(() => false))) return;
          await input.click().catch(() => {});
          await input.fill(zipcode).catch(() => {});
          await input.press('Enter').catch(() => {});
        }
      : undefined,
  };
}
