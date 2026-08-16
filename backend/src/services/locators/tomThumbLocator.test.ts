// Tests the pure, network-free pieces of the Tom Thumb locator: scoping a
// mixed-banner storeresolver response down to real Tom Thumb stores, and
// mapping a raw candidate to a StoreLocation (or rejecting an incomplete
// one). Same convention as krogerLocator.test.ts/albertsonsLocator.test.ts
// — no network access, no fetch mocking (this repo's test suite doesn't
// mock fetch anywhere; the network-calling orchestration function itself,
// findNearestStoreUncached, is exercised indirectly through these building
// blocks instead).
//
// The fixture (__fixtures__/tomthumb-storeresolver.json) is a trimmed real
// capture from the live storeresolver endpoint for zip 75035 — the exact
// ZIP/city from the task's own worked example (Tom Thumb - Frisco, 11401
// Coit Rd) — including real same-zip Market Street (Albertsons Companies)
// results mixed in, which is exactly the cross-banner contamination
// `filterTomThumbCandidates` exists to filter out.
//
// "Missing prices" and "failed requests against the product-search API"
// aren't covered here — there is no product-search parsing in this
// integration at all (see tomThumbLiveScraper.ts's header comment for why);
// `tomThumbLiveScraper.test.ts` covers that empty/no-op behavior instead.
//
// Run with: npm test (from backend/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { filterTomThumbCandidates, toStoreLocation, type StoreResolverStore } from './tomThumbLocator.ts';

const REAL_ZIP_75035_RESPONSE = JSON.parse(
  readFileSync(new URL('./__fixtures__/tomthumb-storeresolver.json', import.meta.url), 'utf-8'),
) as StoreResolverStore[];

test('filterTomThumbCandidates keeps only real Tom Thumb stores out of a mixed-banner response', () => {
  const candidates = filterTomThumbCandidates(REAL_ZIP_75035_RESPONSE);
  assert.equal(candidates.length, 6, 'the real zip=75035 capture has 6 Tom Thumb entries mixed among 4 Market Street ones');
  assert.ok(candidates.every(c => c.polarisBannerName === 'tomthumb'), 'no Market Street/other-banner entry should survive the filter');
});

test('filterTomThumbCandidates preserves the API\'s own distance-ascending order (ZIP -> nearest store)', () => {
  const candidates = filterTomThumbCandidates(REAL_ZIP_75035_RESPONSE);
  // Real, live-verified result for zip 75035: nearest Tom Thumb is the
  // Frisco Coit Rd location, matching the task's own worked example.
  assert.equal(candidates[0].locationId, '11');
  assert.equal(candidates[0].address?.line1, '11401 Coit Rd');
  assert.equal(candidates[0].address?.city, 'Frisco');
  assert.equal(candidates[0].distance, 1.41);
  for (let i = 1; i < candidates.length; i++) {
    assert.ok(candidates[i].distance! >= candidates[i - 1].distance!, 'distances must stay ascending after filtering');
  }
});

test('filterTomThumbCandidates returns empty for a response with no Tom Thumb stores in range', () => {
  const onlyOtherBanners = REAL_ZIP_75035_RESPONSE.filter(s => s.polarisBannerName !== 'tomthumb');
  assert.deepEqual(filterTomThumbCandidates(onlyOtherBanners), []);
  assert.deepEqual(filterTomThumbCandidates([]), []);
});

test('toStoreLocation maps the real nearest Frisco candidate to a complete StoreLocation', () => {
  const nearest = filterTomThumbCandidates(REAL_ZIP_75035_RESPONSE)[0];
  const loc = toStoreLocation(nearest, { latitude: 33.1723415, longitude: -96.7693588 });
  assert.ok(loc, 'expected a StoreLocation, got undefined');
  assert.equal(loc!.name, 'Tom Thumb - Frisco');
  assert.equal(loc!.storeId, '11');
  assert.equal(loc!.address, '11401 Coit Rd');
  assert.equal(loc!.city, 'Frisco');
  assert.equal(loc!.state, 'TX');
  assert.equal(loc!.zip, '75035');
  assert.equal(loc!.latitude, 33.1723415);
  assert.equal(loc!.longitude, -96.7693588);
  assert.equal(loc!.source, 'tomthumb-storeresolver');
  assert.equal(loc!.metadata?.locationId, '11');
});

test('toStoreLocation is valid without coordinates too — lat/lng is optional on StoreLocation', () => {
  const nearest = filterTomThumbCandidates(REAL_ZIP_75035_RESPONSE)[0];
  const loc = toStoreLocation(nearest);
  assert.ok(loc);
  assert.equal(loc!.latitude, undefined);
  assert.equal(loc!.longitude, undefined);
});

test('toStoreLocation never fabricates an address — returns undefined when required fields are missing', () => {
  assert.equal(toStoreLocation({ locationId: '1', address: { city: 'Frisco' } }), undefined, 'missing street/state/zip');
  assert.equal(toStoreLocation({ locationId: '2' }), undefined, 'no address object at all');
  assert.equal(toStoreLocation({ address: { line1: '1 Main St', city: 'X', state: 'TX', zipcode: '75035' } }), undefined, 'no locationId');
  assert.equal(
    toStoreLocation({ locationId: '3', address: { line1: '1 Main St', city: 'X', state: 'TX', zipcode: '' } }),
    undefined,
    'empty zip still counts as missing',
  );
});
