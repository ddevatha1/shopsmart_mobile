// Tests the pure, network-free piece of the Whole Foods locator: mapping
// a raw /api/stores/{id}/summary response to a WholeFoodsStore (or
// rejecting an incomplete/closed one). Same convention as
// krogerLocator.test.ts/tomThumbLocator.test.ts — no network access, no
// fetch mocking (this repo's test suite doesn't mock fetch anywhere; the
// network-calling orchestration functions — fetchStoreSummary,
// loadDirectory, findNearestStoreUncached — are exercised indirectly
// through this building block instead).
//
// The fixture (__fixtures__/wholefoods-store-summary.json) is a real,
// live-captured response for storeId 10819 (Whole Foods Market -
// McKinney, near the task's own zip 75035 example).
//
// Run with: npm test (from backend/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toWholeFoodsStore } from './wholeFoodsLocator.ts';

const REAL_SUMMARY = JSON.parse(
  readFileSync(new URL('./__fixtures__/wholefoods-store-summary.json', import.meta.url), 'utf-8'),
);

test('toWholeFoodsStore maps a real captured summary to a complete WholeFoodsStore', () => {
  const store = toWholeFoodsStore(REAL_SUMMARY);
  assert.ok(store, 'expected a WholeFoodsStore, got undefined');
  assert.equal(store!.storeId, 10819);
  assert.equal(store!.location.name, 'Whole Foods Market - McKinney');
  assert.equal(store!.location.storeId, '10819');
  assert.equal(store!.location.address, '8701 W University Dr.');
  assert.equal(store!.location.city, 'McKinney');
  assert.equal(store!.location.state, 'TX');
  // ZIP+4 ("75071-3324") is truncated to the plain 5-digit ZIP this app's
  // shared StoreLocation contract expects.
  assert.equal(store!.location.zip, '75071');
  assert.equal(store!.location.latitude, 33.21731);
  assert.equal(store!.location.longitude, -96.73206);
  assert.equal(store!.location.source, 'wholefoodsmarket-api');
  assert.equal(store!.location.metadata?.storeId, 10819);
});

test('toWholeFoodsStore rejects a closed/not-open store rather than treating it as viable', () => {
  assert.equal(toWholeFoodsStore({ ...REAL_SUMMARY, status: 'Closed' }), undefined);
  assert.equal(toWholeFoodsStore({ ...REAL_SUMMARY, status: undefined }), undefined);
});

test('toWholeFoodsStore never fabricates an address — returns undefined when required fields are missing', () => {
  assert.equal(toWholeFoodsStore({ status: 'Open' }), undefined, 'no storeId, no address at all');
  assert.equal(
    toWholeFoodsStore({ storeId: 1, status: 'Open', primaryLocation: { address: { CITY: 'McKinney' } } }),
    undefined,
    'missing street/state/zip',
  );
  assert.equal(
    toWholeFoodsStore({
      storeId: 1,
      status: 'Open',
      primaryLocation: { address: { STREET_ADDRESS_LINE1: '1 Main St', CITY: 'X', STATE: 'TX', ZIP_CODE: '' } },
    }),
    undefined,
    'empty zip still counts as missing',
  );
});

test('toWholeFoodsStore tolerates a missing displayName by falling back to city', () => {
  const store = toWholeFoodsStore({ ...REAL_SUMMARY, displayName: undefined });
  assert.equal(store!.location.name, 'Whole Foods Market - McKinney');
});
