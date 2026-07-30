// Run with: npm test
//
// Tests computeNutritionScore — pure, synchronous, deterministic, no
// network (same convention as shoppingPlanOptimizer.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNutritionScore } from './nutritionScoringService.ts';
import type { ApiProduct, NutritionAttributes } from '../types/index.ts';

function makeProduct(id: string, nutrition?: NutritionAttributes): ApiProduct {
  return { id, name: `Product ${id}`, brand: 'Brand', price: 3, rating: 4, size: '1 ea', store: 'Kroger', nutrition };
}

const HIGH_PROTEIN_LOW_SUGAR: NutritionAttributes = {
  proteinGPer100g: 20, fiberGPer100g: 5, sugarGPer100g: 1, sodiumMgPer100g: 50, nutriScore: 'a',
  source: 'open_food_facts', completeness: 'complete',
};

const LOW_PROTEIN_HIGH_SUGAR: NutritionAttributes = {
  proteinGPer100g: 1, fiberGPer100g: 0, sugarGPer100g: 20, sodiumMgPer100g: 500, nutriScore: 'e',
  source: 'open_food_facts', completeness: 'complete',
};

test('a product with no nutrition data does not crash and is tracked as missing, never scored as 0', () => {
  const result = computeNutritionScore([makeProduct('1')]);
  assert.equal(result.score, undefined);
  assert.equal(result.confidence, 'low');
  assert.equal(result.productsEvaluated, 1);
  assert.equal(result.productsMissingNutrition, 1);
});

test('no nutrition data anywhere → low confidence, no score at all (never a fabricated 0)', () => {
  const result = computeNutritionScore([makeProduct('1'), makeProduct('2'), makeProduct('3')]);
  assert.equal(result.score, undefined);
  assert.equal(result.confidence, 'low');
  assert.equal(result.productsMissingNutrition, 3);
});

test('full, complete nutrition data on every product → high confidence', () => {
  const result = computeNutritionScore([
    makeProduct('1', HIGH_PROTEIN_LOW_SUGAR),
    makeProduct('2', HIGH_PROTEIN_LOW_SUGAR),
  ]);
  assert.ok(result.score != null);
  assert.equal(result.confidence, 'high');
  assert.equal(result.productsMissingNutrition, 0);
});

test('some products missing nutrition → partial confidence, not disabled outright', () => {
  const result = computeNutritionScore([
    makeProduct('1', HIGH_PROTEIN_LOW_SUGAR),
    makeProduct('2'), // no nutrition
  ]);
  assert.ok(result.score != null); // still usable — one real product's data is real signal
  assert.equal(result.confidence, 'partial');
  assert.equal(result.productsEvaluated, 2);
  assert.equal(result.productsMissingNutrition, 1);
});

test('partial-completeness data on every product → partial confidence even with 0 missing', () => {
  const partial: NutritionAttributes = { proteinGPer100g: 10, source: 'open_food_facts', completeness: 'partial' };
  const result = computeNutritionScore([makeProduct('1', partial), makeProduct('2', partial)]);
  assert.equal(result.productsMissingNutrition, 0);
  assert.equal(result.confidence, 'partial'); // complete coverage, but not complete DATA
});

test('a higher-protein, lower-sugar/sodium product scores higher than the opposite profile', () => {
  const healthy = computeNutritionScore([makeProduct('1', HIGH_PROTEIN_LOW_SUGAR)]);
  const unhealthy = computeNutritionScore([makeProduct('2', LOW_PROTEIN_HIGH_SUGAR)]);
  assert.ok(healthy.score != null && unhealthy.score != null);
  assert.ok(healthy.score! > unhealthy.score!);
});

test('an empty product list is handled without throwing', () => {
  const result = computeNutritionScore([]);
  assert.equal(result.score, undefined);
  assert.equal(result.confidence, 'low');
  assert.equal(result.productsEvaluated, 0);
  assert.equal(result.productsMissingNutrition, 0);
});
