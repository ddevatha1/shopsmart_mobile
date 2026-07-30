// Run with: npm test
//
// Tests computeCanonicalProduct/enrichProductsWithCanonicalId — pure,
// synchronous, deterministic functions, no network (same convention as
// shoppingPlanOptimizer.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCanonicalProduct, enrichProductsWithCanonicalId } from './canonicalProductService.ts';
import type { ApiProduct } from '../types/index.ts';

function makeProduct(id: string, name: string, size: string): ApiProduct {
  return { id, name, brand: 'Brand', price: 3, rating: 4, size, store: 'Kroger' };
}

test('1. Same product, different formatting → same canonicalId', () => {
  const a = computeCanonicalProduct({ name: 'Organic Whole Milk', size: '1 Gallon' });
  const b = computeCanonicalProduct({ name: 'Whole Milk', size: '1 gal' });
  assert.ok(a && b);
  assert.equal(a!.canonicalId, b!.canonicalId);
  // The organic variant is tracked, not silently lost, even though it
  // doesn't fork identity.
  assert.deepEqual(a!.variantFlags, ['organic']);
  assert.deepEqual(b!.variantFlags, []);
  // Both sizes resolve to the same real-world quantity.
  assert.equal(a!.baseUnitQuantity, 128);
  assert.equal(b!.baseUnitQuantity, 128);
});

test('2. Different product categories → different canonicalId', () => {
  const almondMilk = computeCanonicalProduct({ name: 'Almond Milk', size: '64 fl oz' });
  const wholeMilk = computeCanonicalProduct({ name: 'Whole Milk', size: '64 fl oz' });
  const chickenBreast = computeCanonicalProduct({ name: 'Chicken Breast', size: '1 lb' });
  const chickenThigh = computeCanonicalProduct({ name: 'Chicken Thigh', size: '1 lb' });

  assert.ok(almondMilk && wholeMilk && chickenBreast && chickenThigh);
  assert.notEqual(almondMilk!.canonicalId, wholeMilk!.canonicalId);
  assert.notEqual(chickenBreast!.canonicalId, chickenThigh!.canonicalId);
});

test('3. Organic/non-organic behavior is deterministic', () => {
  const runs = Array.from({ length: 5 }, () =>
    computeCanonicalProduct({ name: 'Organic Fuji Apples', size: '3 lb Bag' }));
  const first = runs[0];
  assert.ok(first);
  for (const r of runs) {
    assert.deepEqual(r, first); // identical input always produces an identical result
  }
  assert.deepEqual(first!.variantFlags, ['organic']);

  // The organic and non-organic versions of the SAME base product share
  // one canonicalId (organic is tracked as a variant flag, not a fork) —
  // this is the deterministic behavior itself, not an accidental merge:
  // it's consistent every time, for every organic/non-organic pair.
  const nonOrganic = computeCanonicalProduct({ name: 'Fuji Apples', size: '3 lb Bag' });
  assert.ok(nonOrganic);
  assert.equal(first!.canonicalId, nonOrganic!.canonicalId);
  assert.deepEqual(nonOrganic!.variantFlags, []);
});

test('4. Size differences do not accidentally merge incompatible products', () => {
  // Same head noun, different size → same canonicalId (size never forks
  // identity) — this is intentional, not the bug this test is guarding.
  const gallon = computeCanonicalProduct({ name: 'Whole Milk', size: '1 Gallon' });
  const quart = computeCanonicalProduct({ name: 'Whole Milk', size: '1 Quart' });
  assert.ok(gallon && quart);
  assert.equal(gallon!.canonicalId, quart!.canonicalId);
  assert.notEqual(gallon!.baseUnitQuantity, quart!.baseUnitQuantity);

  // The actual regression this test protects: two DIFFERENT products
  // that happen to share the exact same size string must never collide
  // just because the size-parsing step matched the same numeric/unit
  // token on both.
  const almondMilkGallon = computeCanonicalProduct({ name: 'Almond Milk', size: '1 Gallon' });
  const wholeMilkGallon = computeCanonicalProduct({ name: 'Whole Milk', size: '1 Gallon' });
  assert.ok(almondMilkGallon && wholeMilkGallon);
  assert.equal(almondMilkGallon!.baseUnitQuantity, wholeMilkGallon!.baseUnitQuantity); // same size...
  assert.notEqual(almondMilkGallon!.canonicalId, wholeMilkGallon!.canonicalId); // ...but never the same product
});

test('5. Missing canonical data does not break search', () => {
  // A name that reduces to nothing after stripping (pure filler/unit
  // words, no real product token) — the honest "no signal" case.
  assert.equal(computeCanonicalProduct({ name: 'Organic', size: '' }), null);
  assert.equal(computeCanonicalProduct({ name: '', size: '1 Gallon' }), null);

  // enrichProductsWithCanonicalId must never throw, drop, reorder, or
  // otherwise alter products it can't identify — only ever add
  // canonicalId where confident, leaving everything else untouched.
  const products: ApiProduct[] = [
    makeProduct('1', 'Whole Milk', '1 Gallon'),
    makeProduct('2', 'Organic', ''), // unresolvable
    makeProduct('3', 'Chicken Breast', '1 lb'),
  ];
  const enriched = enrichProductsWithCanonicalId(products);

  assert.equal(enriched.length, 3);
  assert.equal(enriched[0].id, '1');
  assert.equal(enriched[1].id, '2');
  assert.equal(enriched[2].id, '3');
  assert.ok(enriched[0].canonicalId != null);
  assert.equal(enriched[1].canonicalId, undefined);
  assert.ok(enriched[2].canonicalId != null);
  // Every other field on the unresolved product is untouched.
  assert.deepEqual(enriched[1], products[1]);
});

test('enrichProductsWithCanonicalId never mutates its input array', () => {
  const products = [makeProduct('1', 'Whole Milk', '1 Gallon')];
  const before = JSON.stringify(products);
  enrichProductsWithCanonicalId(products);
  assert.equal(JSON.stringify(products), before);
});
