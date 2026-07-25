import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCandidate } from './ProductNormalizer.ts';
import { findProductCandidates } from './ProductExtractor.ts';
import type { ProductCandidate } from './types.ts';

function candidateFor(raw: Record<string, unknown>, sibling: Record<string, unknown>): ProductCandidate {
  const [candidate] = findProductCandidates({ items: [raw, sibling] }, 'https://example.com/api/search');
  return candidate;
}

test('normalizes a well-formed candidate into a BrowserProduct', () => {
  const candidate = candidateFor(
    { name: 'organic fuji apples', price: 3.49, productId: 'abc123', brandName: 'nature valley', imageUrl: 'https://example.com/apple.jpg', category: 'Produce' },
    { name: 'gala apples', price: 2.99, productId: 'def456' },
  );
  const product = normalizeCandidate(candidate, 'Example Grocer');
  assert.ok(product);
  assert.equal(product!.name, 'Organic Fuji Apples');
  assert.equal(product!.brand, 'Nature Valley');
  assert.equal(product!.price, 3.49);
  assert.equal(product!.category, 'Produce');
  assert.equal(product!.image_url, 'https://example.com/apple.jpg');
  assert.equal(product!.store, 'Example Grocer');
  assert.equal(product!.isLiveData, true);
  assert.ok(product!.id.startsWith('browser-example-grocer-'));
});

test('falls back to a stable hash-based id when no id-like field was present', () => {
  const candidate = candidateFor({ name: 'Bananas', price: 0.59 }, { name: 'Plantains', price: 0.79 });
  const product = normalizeCandidate(candidate, 'Example Grocer');
  assert.ok(product);
  assert.match(product!.id, /^browser-example-grocer-hash-\d+$/);
});

test('discards an image URL that is not a real http(s) link', () => {
  const candidate = candidateFor(
    { name: 'Bananas', price: 0.59, imageUrl: 'data:image/png;base64,abc' },
    { name: 'Plantains', price: 0.79 },
  );
  const product = normalizeCandidate(candidate, 'Example Grocer');
  assert.equal(product!.image_url, undefined);
});

test('coerces availability strings to booleans, and leaves unrecognized values undefined', () => {
  const inStockCandidate = candidateFor(
    { name: 'Milk', price: 3.99, availability: 'In Stock' },
    { name: 'Cream', price: 4.99, availability: 'Out of Stock' },
  );
  const product = normalizeCandidate(inStockCandidate, 'Example Grocer');
  assert.equal(product!.inStock, true);
});

test('returns null for a candidate somehow missing name or price (defensive, should not happen from the extractor)', () => {
  const bogusCandidate: ProductCandidate = { raw: {}, matches: [{ field: 'price', sourceKey: 'price', value: 3.99 }], confidence: 0.2, sourceUrl: 'x' };
  assert.equal(normalizeCandidate(bogusCandidate, 'Example Grocer'), null);
});

test('carries promotions through as a string array', () => {
  const candidate = candidateFor(
    { name: 'Chips', price: 3.99, onSale: true },
    { name: 'Pretzels', price: 2.99 },
  );
  const product = normalizeCandidate(candidate, 'Example Grocer');
  assert.deepEqual(product!.promotions, ['On Sale']);
});
