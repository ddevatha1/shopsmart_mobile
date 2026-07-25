// Pure, network-free tests for the generic product-detection heuristics —
// no real browser/network involved, just JSON fixtures shaped like real
// (and fake/adversarial) grocery-site API responses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findProductCandidates } from './ProductExtractor.ts';

test('finds product candidates in a realistic array of similarly-shaped siblings', () => {
  const response = {
    data: {
      results: [
        { name: 'Fuji Apples', price: 2.99, productId: 'abc123', imageUrl: 'https://example.com/a.jpg' },
        { name: 'Gala Apples', price: 3.49, productId: 'def456', imageUrl: 'https://example.com/b.jpg' },
      ],
    },
  };
  const candidates = findProductCandidates(response, 'https://example.com/api/search');
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].raw.name, 'Fuji Apples');
  assert.ok(candidates[0].confidence > 0);
  assert.equal(candidates[0].sourceUrl, 'https://example.com/api/search');
});

test('rejects a lone matching object with no siblings (the "current store" banner false-positive case)', () => {
  const response = {
    currentStore: { name: 'Downtown Location', price: 0 }, // not really a price, but shaped like one key-wise
    unrelatedBanner: { name: 'Weekly Deals', price: 4.99 }, // a single ad card, not a list
  };
  const candidates = findProductCandidates(response, 'https://example.com/api/page');
  assert.equal(candidates.length, 0, 'single objects outside an array of >=2 qualifying siblings should never count');
});

test('rejects implausible prices (zero, negative, absurdly high)', () => {
  const response = {
    items: [
      { name: 'Free Sample', price: 0 },
      { name: 'Refund Line Item', price: -5 },
      { name: 'Not Actually Groceries', price: 50000 },
      { name: 'Real Milk', price: 3.99 },
    ],
  };
  const candidates = findProductCandidates(response, 'https://example.com/api');
  assert.equal(candidates.length, 0, 'the one plausible-priced item has no qualifying sibling, so nothing should match');
});

test('handles nested price shapes like { amount: 4.99 } and { regular, promo }', () => {
  const response = {
    products: [
      { name: 'Whole Milk', price: { amount: 3.99 } },
      { name: '2% Milk', price: { regular: 4.29, promo: 3.5 } },
    ],
  };
  const candidates = findProductCandidates(response, 'https://example.com/api');
  assert.equal(candidates.length, 2);
  const milk = candidates.find(c => c.raw.name === 'Whole Milk');
  assert.equal(milk?.matches.find(m => m.field === 'price')?.value, 3.99);
});

test('coerces a string price like "$4.99"', () => {
  const response = {
    products: [
      { name: 'Bananas', price: '$0.59' },
      { name: 'Plantains', price: '$0.79' },
    ],
  };
  const candidates = findProductCandidates(response, 'https://example.com/api');
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].matches.find(m => m.field === 'price')?.value, 0.59);
});

test('rejects an overly long "name" field (marketing copy, not a product title)', () => {
  const longText = 'A'.repeat(250);
  const response = {
    cards: [
      { name: longText, price: 9.99 },
      { name: 'Also long enough to be marketing copy '.repeat(6), price: 9.99 },
    ],
  };
  const candidates = findProductCandidates(response, 'https://example.com/api');
  assert.equal(candidates.length, 0);
});

test('raises confidence as more bonus fields (id/upc/image/category/brand) are present', () => {
  const response = {
    items: [
      { name: 'Item A', price: 1.99 },
      { name: 'Item B', price: 2.99 },
    ],
  };
  const richResponse = {
    items: [
      { name: 'Item A', price: 1.99, sku: '1', brand: 'Acme', imageUrl: 'https://x/a.jpg', category: 'Produce', upc: '012345' },
      { name: 'Item B', price: 2.99, sku: '2', brand: 'Acme', imageUrl: 'https://x/b.jpg', category: 'Produce', upc: '012346' },
    ],
  };
  const sparse = findProductCandidates(response, 'https://example.com/api')[0];
  const rich = findProductCandidates(richResponse, 'https://example.com/api')[0];
  assert.ok(rich.confidence > sparse.confidence);
});

test('finds a product list nested several envelope objects deep', () => {
  const response = {
    data: { page: { sections: [{ type: 'grid', content: { items: [
      { name: 'Cheddar Cheese', price: 4.99 },
      { name: 'Swiss Cheese', price: 5.49 },
    ] } }] } },
  };
  const candidates = findProductCandidates(response, 'https://example.com/api');
  assert.equal(candidates.length, 2);
});

test('finds a deeply-nested price shape like real Aldi/Sprouts responses use (price.viewSection.priceValueString)', () => {
  // Confirmed live, this session, as this app's own actual Aldi/Sprouts
  // schema (see aldiLiveScraper.ts) — a real-world case a fixed sub-key
  // guess-list (`{ amount }`, `{ value }`, ...) would never have found.
  const response = {
    items: [
      { name: 'Whole Milk', price: { viewSection: { priceString: '$3.99', priceValueString: '3.99' } } },
      { name: '2% Milk', price: { viewSection: { priceString: '$3.49', priceValueString: '3.49' } } },
    ],
  };
  const candidates = findProductCandidates(response, 'https://example.com/graphql');
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].matches.find(m => m.field === 'price')?.value, 3.99);
});

test('does not false-positive on a string field that merely contains digits but isn\'t price-shaped', () => {
  const response = {
    items: [
      { name: 'Milk', price: { viewSection: { sku: 'SKU-00849213', priceValueString: '3.99' } } },
      { name: 'Cream', price: { viewSection: { sku: 'SKU-00849214', priceValueString: '4.49' } } },
    ],
  };
  const candidates = findProductCandidates(response, 'https://example.com/graphql');
  // Should resolve to the real price, not the SKU string.
  assert.equal(candidates[0].matches.find(m => m.field === 'price')?.value, 3.99);
});

test('parses a boolean promotions flag as a generic "On Sale" label', () => {
  const response = {
    items: [
      { name: 'Chips', price: 3.99, onSale: true },
      { name: 'Salsa', price: 2.99, onSale: false },
    ],
  };
  const candidates = findProductCandidates(response, 'https://example.com/api');
  const chips = candidates.find(c => c.raw.name === 'Chips');
  assert.deepEqual(chips?.matches.find(m => m.field === 'promotions')?.value, ['On Sale']);
});
