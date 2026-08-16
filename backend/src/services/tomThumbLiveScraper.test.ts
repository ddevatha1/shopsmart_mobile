// Tom Thumb product search is an intentional, documented no-op — see this
// file's own header comment for the verified (not guessed) reason: the
// real product-search endpoint is protected in a way that blocks every
// automated client this app could run server-side, confirmed four
// independent ways. These tests assert that documented behavior stays
// true: never throws, never fabricates a product, always resolves empty —
// exactly like albertsonsLiveScraper.ts's own no-op (which has no test
// file of its own; this one exists mainly to pin down the "never throws
// even with garbage input" and "timeoutMs is ignored, not silently
// dropped-and-forgotten" behaviors explicitly).
//
// Run with: npm test (from backend/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchTomThumb, searchTomThumbWithTimeout, normalizeTomThumbProduct } from './tomThumbLiveScraper.ts';

test('searchTomThumb always resolves to an empty list, never throws', async () => {
  const result = await searchTomThumb('apples', '75035');
  assert.deepEqual(result, []);
});

test('searchTomThumb resolves empty regardless of query/zip/preciseCoords shape', async () => {
  await assert.doesNotReject(() => searchTomThumb('', ''));
  await assert.doesNotReject(() => searchTomThumb('milk', '00000', { latitude: 0, longitude: 0 }));
  assert.deepEqual(await searchTomThumb('milk', '00000', { latitude: 0, longitude: 0 }), []);
});

test('searchTomThumbWithTimeout resolves empty immediately, not after waiting out timeoutMs', async () => {
  const start = Date.now();
  const result = await searchTomThumbWithTimeout('apples', '75035', 15_000);
  assert.deepEqual(result, []);
  assert.ok(Date.now() - start < 1000, 'should resolve near-instantly, not block for anywhere close to the timeout budget');
});

test('normalizeTomThumbProduct is a documented no-op — always null, never throws', () => {
  assert.equal(normalizeTomThumbProduct(), null);
});
