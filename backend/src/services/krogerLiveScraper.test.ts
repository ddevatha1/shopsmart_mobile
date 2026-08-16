// Tests the pure, network-free piece of the Kroger live scraper:
// mapKrogerProduct's real-data-first, synthetic-fallback rating and
// stock-level mapping (see this file's header comment on the "Bonus
// finding" — genuine Kroger ratingsAndReviews/inventory fields that used
// to sit unused in favor of a fabricated rating and a hardcoded
// `inStock: true`). No network access needed.
//
// Run with: npm test (from backend/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapKrogerProduct, type KrogerProduct } from './krogerLiveScraper.ts';
import type { KrogerBanner } from './krogerLiveScraper.ts';

const BANNER: KrogerBanner = { storeName: 'Kroger', chain: 'KROGER', idSlug: 'kroger', readinessKey: 'kroger' };

function baseProduct(overrides: Partial<KrogerProduct> = {}): KrogerProduct {
  return {
    productId: '0001111041700',
    brand: 'Kroger',
    description: 'Whole Milk',
    items: [{ size: '1 gal', price: { regular: 3.49, promo: 0 } }],
    ...overrides,
  };
}

test('uses the real ratingsAndReviews fields when the API actually returns them', () => {
  const product = mapKrogerProduct(
    baseProduct({ ratingsAndReviews: { averageOverallRating: 4.6, totalReviewCount: 812 } }),
    undefined,
    BANNER,
  );
  assert.ok(product);
  assert.equal(product!.rating, 4.6);
  assert.equal(product!.reviewCount, 812);
});

test('falls back to the deterministic synthetic rating when ratingsAndReviews is absent', () => {
  const product = mapKrogerProduct(baseProduct(), undefined, BANNER);
  assert.ok(product);
  // Same deterministic hash-of-productId formula this file always used —
  // asserting it still runs, not asserting a specific magic number.
  assert.ok(product!.rating >= 3.8 && product!.rating <= 5.0);
  assert.ok(product!.reviewCount! >= 20);
});

test('falls back to synthetic rating when only one of the two real fields is present', () => {
  const product = mapKrogerProduct(
    baseProduct({ ratingsAndReviews: { averageOverallRating: 4.6 } }),
    undefined,
    BANNER,
  );
  assert.ok(product);
  // A half-populated real field is not trusted as "real data" — falls
  // back to the same synthetic formula rather than inventing a review count.
  assert.ok(product!.reviewCount! >= 20);
});

test('inStock reflects a real out-of-stock stockLevel', () => {
  const product = mapKrogerProduct(
    baseProduct({ items: [{ size: '1 gal', price: { regular: 3.49, promo: 0 }, inventory: { stockLevel: 'TEMPORARILY_OUT_OF_STOCK' } }] }),
    undefined,
    BANNER,
  );
  assert.ok(product);
  assert.equal(product!.inStock, false);
});

test('inStock is true for a real, present, non-out-of-stock stockLevel', () => {
  const product = mapKrogerProduct(
    baseProduct({ items: [{ size: '1 gal', price: { regular: 3.49, promo: 0 }, inventory: { stockLevel: 'HIGH' } }] }),
    undefined,
    BANNER,
  );
  assert.ok(product);
  assert.equal(product!.inStock, true);
});

test('inStock defaults to true when no stock-level data exists at all, same as before', () => {
  const product = mapKrogerProduct(baseProduct(), undefined, BANNER);
  assert.ok(product);
  assert.equal(product!.inStock, true);
});
