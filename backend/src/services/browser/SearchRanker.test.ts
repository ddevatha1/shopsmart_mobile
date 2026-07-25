// Pure, network-free tests — reuses this app's existing fuzzy relevance
// scorer (searchService.ts's computeRelevance/classifyMatch), so these
// tests are really validating that reuse wiring, not a new algorithm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankProducts } from './SearchRanker.ts';
import type { BrowserProduct } from './types.ts';

function fakeProduct(name: string, category?: string): BrowserProduct {
  return {
    id: `id-${name}`,
    store: 'Example Grocer',
    name,
    brand: '',
    price: 2.99,
    rating: 4.2,
    isLiveData: true,
    size: '',
    category,
    sourceUrl: 'https://example.com/api',
  };
}

test('ranks true matches above tangential/unrelated products for the same query — the spec\'s own "apples" example', () => {
  const products = [
    fakeProduct('Apple Cinnamon Muffins'),
    fakeProduct('Apple Juice'),
    fakeProduct('Fuji Apples'),
    fakeProduct('Organic Gala Apples'),
  ];
  const ranked = rankProducts('apples', products);
  const names = ranked.map(r => r.product.name);

  assert.ok(names.indexOf('Fuji Apples') !== -1, 'a genuine match should survive ranking');
  assert.ok(names.indexOf('Organic Gala Apples') !== -1, 'a genuine match should survive ranking');
  assert.ok(
    names.indexOf('Fuji Apples') < names.indexOf('Apple Juice'),
    'a direct match should outrank a tangential one sharing only a root word',
  );
});

test('filters out products with essentially no relevance to the query', () => {
  const products = [fakeProduct('Fuji Apples'), fakeProduct('Frozen Pizza')];
  const ranked = rankProducts('apples', products);
  assert.equal(ranked.some(r => r.product.name === 'Frozen Pizza'), false);
});

test('relevanceScore is always a fraction between 0 and 1', () => {
  const products = [fakeProduct('Fuji Apples'), fakeProduct('Honeycrisp Apples')];
  const ranked = rankProducts('apples', products);
  for (const r of ranked) {
    assert.ok(r.relevanceScore >= 0 && r.relevanceScore <= 1);
  }
});

test('a product name with an extra qualifier word is upgraded to a direct hit by a confirmed category match', () => {
  // "Apple Variety Pack" alone reads as 'related' (the trailing qualifier
  // words read as a different head noun than a plain "apple") — the
  // category match is what pushes it to 'direct', the same category-based
  // override the rest of this app's search pipeline already relies on.
  const products = [fakeProduct('Apple Variety Pack', 'apples')];
  const ranked = rankProducts('apples', products);
  assert.equal(ranked[0]?.matchType, 'direct');
});
