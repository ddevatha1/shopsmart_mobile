// Tests for the Aldi adapter — uses two real captured fixtures:
//   1. aldi-items-response.json — a flat `data.items` capture from the
//      Playwright discovery script, used to test normalizeAldiProduct
//      against real item objects.
//   2. aldi-search-results-placements.json — a real (trimmed) response from
//      the actual SearchResultsPlacements GraphQL operation used in
//      production, used to test the placements → items extraction.
// No network access or live endpoint/cookie needed.
//
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeAldiProduct,
  extractItemsFromPlacements,
  searchAldi,
  type AldiItem,
  type AldiPlacement,
} from './aldiLiveScraper.ts';

function loadFixture<T>(name: string): T {
  const path = new URL(`./__fixtures__/${name}`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

const ITEMS_FIXTURE = loadFixture<{ data: { items: AldiItem[] } }>('aldi-items-response.json');
const REAL_ITEMS = ITEMS_FIXTURE.data.items;

const PLACEMENTS_FIXTURE = loadFixture<{
  data: { searchResultsPlacements: { placements: AldiPlacement[] } };
}>('aldi-search-results-placements.json');

test('the items fixture actually contains items (sanity check on the capture itself)', () => {
  assert.ok(REAL_ITEMS.length > 0, 'expected at least one item in the captured fixture');
});

test('maps every item in the real captured response without throwing', () => {
  for (const item of REAL_ITEMS) {
    const product = normalizeAldiProduct(item);
    assert.ok(product, `expected ${item.name} to map successfully`);
  }
});

test('maps the first real item with correct field values', () => {
  const item = REAL_ITEMS[0];
  const product = normalizeAldiProduct(item);

  assert.ok(product);
  assert.equal(product.store, 'Aldi');
  assert.equal(product.name, 'Specially Selected Cilantro Lime Salsa');
  assert.equal(product.price, 3.79);
  assert.equal(product.image_url, 'https://d2lnr5mha7bycj.cloudfront.net/product-image/file/large_e1d2d493-c1b0-456b-806e-800786719c77.jpg');
  assert.equal(product.inStock, true);
  assert.equal(product.category, 'Salsas');
  assert.equal(product.size, '16 oz');
  assert.equal(product.upc, undefined, 'UPC is not present in this response schema');
  assert.equal(product.id, 'aldi-18649695');
});

test('drops items with no positive price', () => {
  const item: AldiItem = {
    ...REAL_ITEMS[0],
    price: { viewSection: { priceValueString: '0' } },
  };
  assert.equal(normalizeAldiProduct(item), null);
});

test('drops items with an empty or missing name', () => {
  const noName: AldiItem = { ...REAL_ITEMS[0], name: '   ' };
  assert.equal(normalizeAldiProduct(noName), null);

  const undefinedName: AldiItem = { ...REAL_ITEMS[0], name: undefined };
  assert.equal(normalizeAldiProduct(undefinedName), null);
});

test('drops items where price is entirely absent', () => {
  const noPrice: AldiItem = { ...REAL_ITEMS[0], price: undefined };
  assert.equal(normalizeAldiProduct(noPrice), null);
});

test('handles a minimal item with every optional field missing', () => {
  const minimal: AldiItem = {
    name: 'Bare Minimum Product',
    price: { viewSection: { priceValueString: '2.50' } },
  };
  const product = normalizeAldiProduct(minimal);

  assert.ok(product);
  assert.equal(product.price, 2.5);
  assert.equal(product.image_url, undefined);
  assert.equal(product.inStock, undefined, 'missing availability should map to undefined, not false');
  assert.equal(product.category, undefined);
  assert.equal(product.size, '');
  assert.equal(product.brand, '');
});

test('falls back to `id` when `productId` is missing', () => {
  const item: AldiItem = { ...REAL_ITEMS[0], productId: undefined, id: 'items_14371-99999' };
  const product = normalizeAldiProduct(item);
  assert.ok(product);
  assert.equal(product.id, 'aldi-items_14371-99999');
});

test('availability.available=false maps to inStock=false', () => {
  const item: AldiItem = { ...REAL_ITEMS[0], availability: { available: false } };
  const product = normalizeAldiProduct(item);
  assert.ok(product);
  assert.equal(product.inStock, false);
});

// ── Real SearchResultsPlacements response — placements → items extraction ────

test('extracts items from the real SearchResultsPlacements placements structure', () => {
  const placements = PLACEMENTS_FIXTURE.data.searchResultsPlacements.placements;
  const items = extractItemsFromPlacements(placements);

  assert.ok(items.length > 0, 'expected at least one item across all placements');
  for (const item of items) {
    assert.ok(item.name, 'every extracted item should have a name');
  }
});

test('normalizes every item extracted from the real placements response', () => {
  const placements = PLACEMENTS_FIXTURE.data.searchResultsPlacements.placements;
  const items = extractItemsFromPlacements(placements);
  const products = items.map(item => normalizeAldiProduct(item)).filter(p => p !== null);

  assert.ok(products.length > 0);
  for (const p of products) {
    assert.equal(p.store, 'Aldi');
    assert.ok(p.price > 0);
    assert.ok(p.name.length > 0);
  }
});

test('extractItemsFromPlacements handles placements with no content/items safely', () => {
  const empty = extractItemsFromPlacements([{}, { content: {} }, { content: { items: [] } }]);
  assert.deepEqual(empty, []);
});

test('extractItemsFromPlacements handles undefined placements safely', () => {
  assert.deepEqual(extractItemsFromPlacements(undefined), []);
});

// ── searchAldi() configuration guards ────────────────────────────────────────
// Note: store selection is resolved live via AldiLocator (see
// locators/aldiLocator.ts), so it isn't covered by these fixture-only,
// network-free tests — only the synchronous input guard is.

test('searchAldi throws a clear error when no postal code is given', async () => {
  await assert.rejects(
    () => searchAldi('eggs'),
    /postal code/i,
  );
});
