// Run with: npm test
//
// Tests extractNutrition — the one place this app reads
// nutriments/nutriscore_grade out of an Open Food Facts product record
// (see ../routes/productImage.ts) — against hand-built fixtures shaped
// like real OFF responses. No network (same convention as
// shoppingPlanOptimizer.test.ts). Lives here rather than next to its
// source in routes/ because `npm test`'s glob only scans src/services/
// and src/services/locators/ today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractNutrition, type OpenFoodFactsProduct } from '../routes/productImage.ts';

test('extractNutrition pulls the full shape out of a complete OFF record and marks it complete', () => {
  const product: OpenFoodFactsProduct = {
    product_name: 'Organic Whole Milk',
    brands: 'Organic Valley',
    nutriments: {
      'energy-kcal_100g': 61,
      proteins_100g: 3.2,
      fat_100g: 3.6,
      carbohydrates_100g: 4.8,
      fiber_100g: 0,
      sugars_100g: 4.8,
      sodium_100g: 0.04, // grams — extractNutrition converts to mg
    },
    nutriscore_grade: 'B',
  };

  const nutrition = extractNutrition(product);
  assert.ok(nutrition, 'expected a populated NutritionAttributes object');
  assert.equal(nutrition!.caloriesPer100g, 61);
  assert.equal(nutrition!.proteinGPer100g, 3.2);
  assert.equal(nutrition!.fatGPer100g, 3.6);
  assert.equal(nutrition!.carbsGPer100g, 4.8);
  // A real, genuine zero (fiber-free) must survive — not be treated the
  // same as "no data for this field."
  assert.equal(nutrition!.fiberGPer100g, 0);
  assert.equal(nutrition!.sugarGPer100g, 4.8);
  assert.equal(nutrition!.sodiumMgPer100g, 40);
  assert.equal(nutrition!.nutriScore, 'b'); // lowercased
  assert.equal(nutrition!.source, 'open_food_facts');
  // All seven numeric fields present → complete, not partial.
  assert.equal(nutrition!.completeness, 'complete');
});

test('a record missing even one numeric field is marked partial, never rounded up to complete', () => {
  const nutrition = extractNutrition({
    nutriments: {
      'energy-kcal_100g': 61,
      proteins_100g: 3.2,
      fat_100g: 3.6,
      carbohydrates_100g: 4.8,
      // fiber_100g, sugars_100g, sodium_100g all missing
    },
  });
  assert.ok(nutrition);
  assert.equal(nutrition!.completeness, 'partial');
  assert.equal(nutrition!.fiberGPer100g, undefined);
  assert.equal(nutrition!.sugarGPer100g, undefined);
  assert.equal(nutrition!.sodiumMgPer100g, undefined);
});

test('extractNutrition returns undefined for a record with no nutriments and no score', () => {
  const product: OpenFoodFactsProduct = { product_name: 'Mystery Item', brands: 'Some Brand' };
  assert.equal(extractNutrition(product), undefined);
});

test('extractNutrition returns undefined for an empty nutriments object with no other signal', () => {
  assert.equal(extractNutrition({ nutriments: {} }), undefined);
});

test('extractNutrition ignores an unrecognized nutriscore_grade value rather than passing it through', () => {
  assert.equal(extractNutrition({ nutriscore_grade: 'not-a-grade' }), undefined);
});

test('a nutriScore-only record (no macros at all) still returns an object, marked partial', () => {
  const nutrition = extractNutrition({ nutriscore_grade: 'a' });
  assert.ok(nutrition);
  assert.equal(nutrition!.nutriScore, 'a');
  assert.equal(nutrition!.completeness, 'partial');
  assert.equal(nutrition!.caloriesPer100g, undefined);
});
