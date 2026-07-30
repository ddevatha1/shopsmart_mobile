// Run with: npm test
//
// Tests enrichDirectMatchesWithNutrition's own orchestration (capping,
// timeout handling, merge-back-by-name) via dependency injection — a fake
// `fetchNutrition` function stands in for the real Open Food Facts-backed
// one, so these tests never touch the network and never need to know
// anything about Open Food Facts' response shape (see
// fetchNutritionFromOpenFoodFacts's own comment for why that boundary
// exists). No mocking library — just a plain function passed as an
// argument, same "inject a fake, no framework" convention as this file's
// neighboring tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enrichDirectMatchesWithNutrition,
  MAX_NUTRITION_ENRICHMENT,
  NUTRITION_ENRICHMENT_BUDGET_MS,
} from './searchService.ts';
import type { ApiProduct, NutritionAttributes } from '../types/index.ts';

function makeProduct(id: string, name: string, matchType: 'direct' | 'related' = 'direct'): ApiProduct {
  return { id, name, brand: 'Brand', price: 3, rating: 4, size: '1 ea', store: 'Kroger', matchType };
}

const FAKE_NUTRITION: NutritionAttributes = {
  caloriesPer100g: 61,
  proteinGPer100g: 3.2,
  source: 'open_food_facts',
  completeness: 'partial',
};

test('enrichDirectMatchesWithNutrition attaches nutrition when the fetcher resolves it', async () => {
  const products = [makeProduct('1', 'Whole Milk')];
  const result = await enrichDirectMatchesWithNutrition(
    products,
    async (name) => (name === 'Whole Milk' ? FAKE_NUTRITION : undefined),
  );
  assert.deepEqual(result[0].nutrition, FAKE_NUTRITION);
});

test('a product Open Food Facts has no match for keeps nutrition undefined, not an error', async () => {
  const products = [makeProduct('1', 'Some Obscure Regional Product')];
  const result = await enrichDirectMatchesWithNutrition(products, async () => undefined);
  assert.equal(result.length, 1);
  assert.equal(result[0].nutrition, undefined);
});

test('a fetcher that exceeds the enrichment budget still lets the search succeed, just without nutrition', async () => {
  const products = [makeProduct('1', 'Whole Milk'), makeProduct('2', 'Eggs')];
  const neverResolves = () => new Promise<NutritionAttributes | undefined>(() => {});

  const start = Date.now();
  const result = await enrichDirectMatchesWithNutrition(products, neverResolves);
  const elapsedMs = Date.now() - start;

  assert.equal(result.length, 2); // the product list itself is returned intact
  assert.ok(result.every((p) => p.nutrition === undefined));
  // Bounded by the real budget, not left hanging indefinitely.
  assert.ok(elapsedMs < NUTRITION_ENRICHMENT_BUDGET_MS + 500, `expected to bail out near the ${NUTRITION_ENRICHMENT_BUDGET_MS}ms budget, took ${elapsedMs}ms`);
});

test('more than MAX_NUTRITION_ENRICHMENT direct matches are capped, not all fetched', async () => {
  const products = Array.from(
    { length: MAX_NUTRITION_ENRICHMENT + 5 },
    (_, i) => makeProduct(String(i), `Product ${i}`),
  );
  let callCount = 0;
  await enrichDirectMatchesWithNutrition(products, async () => {
    callCount++;
    return FAKE_NUTRITION;
  });
  assert.equal(callCount, MAX_NUTRITION_ENRICHMENT);
});

test('related (non-direct) matches are never sent to the fetcher at all', async () => {
  const products = [
    makeProduct('1', 'Direct Match', 'direct'),
    makeProduct('2', 'Related Match', 'related'),
  ];
  const seenNames: string[] = [];
  await enrichDirectMatchesWithNutrition(products, async (name) => {
    seenNames.push(name);
    return FAKE_NUTRITION;
  });
  assert.deepEqual(seenNames, ['Direct Match']);
});
