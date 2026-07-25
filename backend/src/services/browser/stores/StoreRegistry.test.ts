// Pure, network-free tests for the registry lookup and the onboarding-
// config -> BrowserStoreConfig translation — no real browser involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getStoreConfig, listStores, registerStore, toBrowserStoreConfig } from './StoreRegistry.ts';

test('every store listed in storeConfigs/index.ts is resolvable by name', () => {
  const stores = listStores();
  assert.ok(stores.length >= 5, 'expected at least the 5 starting candidates to be registered');
  for (const store of stores) {
    assert.equal(getStoreConfig(store.storeName), store);
  }
});

test('registerStore adds a new store at runtime without touching the static list', () => {
  const before = listStores().length;
  registerStore({ storeName: '__test-store__', homepage: 'https://example.com/' });
  assert.equal(listStores().length, before + 1);
  assert.ok(getStoreConfig('__test-store__'));
});

test('toBrowserStoreConfig falls back to the homepage when buildSearchUrl is omitted', () => {
  const browserConfig = toBrowserStoreConfig({ storeName: 'Example', homepage: 'https://example.com/shop' });
  assert.equal(browserConfig.buildSearchUrl('milk'), 'https://example.com/shop');
  assert.equal(browserConfig.setLocation, undefined);
});

test('toBrowserStoreConfig preserves an explicit buildSearchUrl override', () => {
  const browserConfig = toBrowserStoreConfig({
    storeName: 'Example',
    homepage: 'https://example.com/',
    buildSearchUrl: (query) => `https://example.com/search?q=${query}`,
  });
  assert.equal(browserConfig.buildSearchUrl('milk'), 'https://example.com/search?q=milk');
});

test('toBrowserStoreConfig converts a locationSelector string into a setLocation function', () => {
  const browserConfig = toBrowserStoreConfig({
    storeName: 'Example',
    homepage: 'https://example.com/',
    locationSelector: 'input#zip',
  });
  assert.equal(typeof browserConfig.setLocation, 'function');
});
