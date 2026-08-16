// Tests the pure, network-free piece of the Publix locator: parsing the
// "City, ST 12345" shape Instacart's GetRetailerLocationAddress query
// returns as `address.lineTwoString`. Same convention as
// tomThumbLocator.test.ts/wholeFoodsLocator.test.ts — no network access,
// no fetch mocking; the network-calling orchestration function itself
// (findNearestStoreUncached) isn't exercised here.
//
// The inputs below are real values captured live from Instacart's
// delivery.publix.com/graphql during this integration's own
// investigation (Publix #714 - Baypoint, Miami FL and the Jacksonville
// default location) — not fabricated examples.
//
// Run with: npm test (from backend/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCityStateZip } from './publixLocator.ts';

test('parseCityStateZip parses a real "City, ST 12345" address line', () => {
  assert.deepEqual(parseCityStateZip('Miami, FL 33137'), { city: 'Miami', state: 'FL', zip: '33137' });
  assert.deepEqual(parseCityStateZip('Jacksonville, FL 32202'), { city: 'Jacksonville', state: 'FL', zip: '32202' });
});

test('parseCityStateZip handles a multi-word city name', () => {
  assert.deepEqual(parseCityStateZip('Winter Garden, FL 34787'), { city: 'Winter Garden', state: 'FL', zip: '34787' });
});

test('parseCityStateZip returns an empty object (never fabricates) for missing or malformed input', () => {
  assert.deepEqual(parseCityStateZip(undefined), {});
  assert.deepEqual(parseCityStateZip(''), {});
  assert.deepEqual(parseCityStateZip('not a real address line'), {});
  assert.deepEqual(parseCityStateZip('Miami FL 33137'), {}, 'missing the comma after city is treated as unparseable, not guessed');
});
