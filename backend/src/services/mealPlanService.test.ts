// Run with: npm test
//
// Tests generateMealPlan — pure, synchronous, deterministic. No network,
// no AI, matching every other pure-logic service test in this backend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMealPlan } from './mealPlanService.ts';

test('generates exactly mealCount meals of the requested type', () => {
  const result = generateMealPlan({ mealCount: 5, mealType: 'dinner' });
  assert.equal(result.meals.length, 5);
  assert.ok(result.meals.every((m) => m.mealType === 'dinner'));
});

test('the same request always produces the same meals — deterministic, no randomness', () => {
  const first = generateMealPlan({ mealCount: 4, mealType: 'dinner' });
  const second = generateMealPlan({ mealCount: 4, mealType: 'dinner' });
  assert.deepEqual(first.meals.map((m) => m.name), second.meals.map((m) => m.name));
  assert.deepEqual(first.groceryItems, second.groceryItems);
});

test('every meal is a real, hand-authored template — never an invented recipe', () => {
  const result = generateMealPlan({ mealCount: 6, mealType: 'dinner' });
  const knownNames = new Set(['Chicken Tacos', 'Pasta with Marinara', 'Chicken Stir Fry']);
  for (const meal of result.meals) {
    assert.ok(knownNames.has(meal.name), `unexpected meal name: ${meal.name}`);
  }
});

test('breakfast requests only ever select breakfast templates', () => {
  const result = generateMealPlan({ mealCount: 3, mealType: 'breakfast' });
  assert.ok(result.meals.every((m) => m.mealType === 'breakfast'));
  const knownNames = new Set(['Oatmeal with Banana', 'Eggs and Toast', 'Yogurt Parfait']);
  for (const meal of result.meals) {
    assert.ok(knownNames.has(meal.name));
  }
});

test('mealCount is clamped to a sane range — never zero, negative, or absurdly large', () => {
  assert.equal(generateMealPlan({ mealCount: 0, mealType: 'dinner' }).meals.length, 1);
  assert.equal(generateMealPlan({ mealCount: -3, mealType: 'dinner' }).meals.length, 1);
  assert.equal(generateMealPlan({ mealCount: 999, mealType: 'dinner' }).meals.length, 14);
});

test('the grocery list is deduplicated across meals sharing an ingredient', () => {
  // Chicken Tacos and Chicken Stir Fry both use "chicken breast" — cycling
  // through both should list it once, not twice.
  const result = generateMealPlan({ mealCount: 3, mealType: 'dinner' });
  const chickenCount = result.groceryItems.filter((i) => i.toLowerCase() === 'chicken breast').length;
  assert.equal(chickenCount, 1);
});

test('no prices anywhere in the output — this service only ever names ingredients', () => {
  const result = generateMealPlan({ mealCount: 3, mealType: 'dinner' });
  const serialized = JSON.stringify(result);
  assert.ok(!/price|cost|\$/i.test(serialized));
});

test('pantry low-stock items not already needed are added and named in pantryAdditions', () => {
  const result = generateMealPlan({ mealCount: 1, mealType: 'dinner', lowStockItems: ['rice', 'chicken breast'] });
  // "chicken breast" is already in Chicken Tacos — never duplicated.
  assert.equal(result.groceryItems.filter((i) => i.toLowerCase() === 'chicken breast').length, 1);
  // "rice" isn't needed by Chicken Tacos — added, and named explicitly.
  assert.ok(result.groceryItems.some((i) => i.toLowerCase() === 'rice'));
  assert.deepEqual(result.pantryAdditions, ['rice']);
});

test('pantry additions are advisory only — omitted entirely when there is no low-stock signal', () => {
  const result = generateMealPlan({ mealCount: 2, mealType: 'dinner' });
  assert.deepEqual(result.pantryAdditions, []);
});
