// Run with: npm test
//
// Tests the optimizer's pure algorithm (subset enumeration, candidate
// selection/scoring) against fake SubsetPlan fixtures — no network. Mirrors
// warmupService.test.ts's split: the real end-to-end buildShoppingPlan
// (performSearch + planTrip against live stores) isn't covered here for
// the same reason runWarmup isn't there. Ported from CartIQ_web's
// shoppingPlanOptimizer.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_STORES, allNonEmptySubsets, selectCandidates, withBudgetAnalysis, excludeKnownClosedStores,
  type SubsetPlan, type ItemCandidates,
} from './shoppingPlanOptimizer.ts';
import type { ApiProduct, NutritionScore, PlanStoreAssignment, PlanWeights, StoreLocation, TripPlan } from '../types/index.ts';

// No shared StoreName export in this backend's types/index.ts (same
// convention as the source file under test) — derived locally instead.
type StoreName = ApiProduct['store'];

test('allNonEmptySubsets of 4 stores produces exactly 15 non-empty, unique subsets', () => {
  const stores: StoreName[] = ["Trader Joe's", 'Sprouts', 'Kroger', 'Aldi'];
  const subsets = allNonEmptySubsets(stores);
  assert.equal(subsets.length, 15);
  assert.ok(subsets.every(s => s.length > 0));
  const signatures = subsets.map(s => [...s].sort().join(','));
  assert.equal(new Set(signatures).size, 15);
  // Every individual store appears alone exactly once.
  for (const store of stores) {
    assert.equal(subsets.filter(s => s.length === 1 && s[0] === store).length, 1);
  }
  // The full 4-store combination is present exactly once.
  assert.equal(subsets.filter(s => s.length === 4).length, 1);
});

test('ALL_STORES includes Harris Teeter (regression: it was silently excluded from planning)', () => {
  assert.equal(ALL_STORES.length, 5);
  assert.ok(ALL_STORES.includes('Harris Teeter'));
  // Albertsons stays correctly excluded — no product data source exists
  // for it (see albertsonsLiveScraper.ts), so including it here would
  // only ever produce empty/unusable subsets.
  assert.ok(!ALL_STORES.includes('Albertsons'));
});

test('allNonEmptySubsets of 5 stores (the real ALL_STORES) produces exactly 31 non-empty, unique subsets', () => {
  const subsets = allNonEmptySubsets(ALL_STORES);
  assert.equal(subsets.length, 31);
  assert.ok(subsets.every(s => s.length > 0));
  const signatures = subsets.map(s => [...s].sort().join(','));
  assert.equal(new Set(signatures).size, 31);
  // Every individual store, including Harris Teeter, appears alone exactly once.
  for (const store of ALL_STORES) {
    assert.equal(subsets.filter(s => s.length === 1 && s[0] === store).length, 1);
  }
  // The full 5-store combination is present exactly once.
  assert.equal(subsets.filter(s => s.length === 5).length, 1);
});

test('selectCandidates treats a Harris-Teeter-only-covered item correctly: a plan that covers it wins over one that does not', () => {
  // An item that only exists at Harris Teeter: any subset plan omitting
  // Harris Teeter simply can't resolve it, so its itemsFound is lower.
  // This is the unit-testable proxy for "the item is considered in plan
  // generation and doesn't incorrectly appear as unresolved" — the real
  // end-to-end search+routing isn't covered here for the same reason
  // buildShoppingPlan itself isn't (see file header).
  const withoutHarrisTeeter = fakeSubsetPlan({
    storeAssignments: [fakeAssignment('Kroger', 2, 10)],
    totalCost: 10, totalDriveMinutes: 5, totalDriveMiles: 2,
  }); // itemsFound = 2, missing the Harris-Teeter-only item entirely
  const withHarrisTeeter = fakeSubsetPlan({
    storeAssignments: [fakeAssignment('Kroger', 2, 10), fakeAssignment('Harris Teeter', 1, 4)],
    totalCost: 14, totalDriveMinutes: 15, totalDriveMiles: 6,
  }); // itemsFound = 3, the only plan covering all 3 items

  const [balanced, cheapest] = selectCandidates([withoutHarrisTeeter, withHarrisTeeter], EQUAL_WEIGHTS);

  // Coverage wins first (selectCandidates filters to maxCoverage before
  // any cost/time/stops sort) — both candidates must come from the
  // Harris-Teeter-inclusive plan, never the one that drops the item.
  assert.equal(balanced.itemsFound, 3);
  assert.equal(cheapest.itemsFound, 3);
  assert.ok(balanced.storeAssignments.some(a => a.store === 'Harris Teeter'));
  assert.ok(cheapest.storeAssignments.some(a => a.store === 'Harris Teeter'));
});

function fakeTripPlan(): TripPlan {
  return {
    origin: { latitude: 0, longitude: 0 },
    totalDurationMinutes: 0,
    totalDistanceMiles: 0,
    routeGeometry: { type: 'LineString', coordinates: [] },
    stops: [],
  };
}

function fakeAssignment(store: StoreName, itemCount: number, subtotal: number): PlanStoreAssignment {
  return {
    store,
    location: { name: store, address: '1 Main St', city: 'Springfield', state: 'TX', zip: '78701', source: 'test-fixture' },
    items: Array.from({ length: itemCount }, (_, i) => ({
      listItemId: `${store}-${i}`,
      rawText: `item ${i}`,
      product: null,
      notFound: false,
    })),
    subtotal,
  };
}

function fakeSubsetPlan(overrides: Partial<SubsetPlan> & { storeAssignments: PlanStoreAssignment[] }): SubsetPlan {
  return {
    totalCost: 0,
    estimatedGasCost: 0,
    totalDriveMinutes: 0,
    totalDriveMiles: 0,
    storeCount: overrides.storeAssignments.length,
    itemsFound: overrides.storeAssignments.reduce((s, a) => s + a.items.length, 0),
    itemsTotal: 3,
    tripPlan: fakeTripPlan(),
    ...overrides,
  };
}

const EQUAL_WEIGHTS: PlanWeights = { cost: 0.25, time: 0.25, distance: 0.25, fewerStops: 0.25 };
const COST_ONLY_WEIGHTS: PlanWeights = { cost: 1, time: 0, distance: 0, fewerStops: 0 };

test('selectCandidates ignores a cheaper plan that covers fewer items than the best coverage available', () => {
  const x = fakeSubsetPlan({ storeAssignments: [fakeAssignment('Kroger', 2, 10)], totalCost: 10, totalDriveMinutes: 5, totalDriveMiles: 2 });
  const y = fakeSubsetPlan({
    storeAssignments: [fakeAssignment('Kroger', 2, 9), fakeAssignment('Aldi', 1, 6)],
    totalCost: 15, totalDriveMinutes: 20, totalDriveMiles: 10,
  });
  const z = fakeSubsetPlan({
    storeAssignments: [fakeAssignment('Kroger', 1, 4), fakeAssignment('Aldi', 1, 4), fakeAssignment('Sprouts', 1, 4)],
    totalCost: 12, totalDriveMinutes: 30, totalDriveMiles: 15,
  });

  const [, cheapest, fastest, fewestStops] = selectCandidates([x, y, z], EQUAL_WEIGHTS);

  assert.equal(cheapest.totalCost, 12); // Z, not X
  assert.equal(cheapest.itemsFound, 3);
  assert.equal(fastest.totalDriveMinutes, 20); // Y
  assert.equal(fewestStops.storeCount, 2); // Y (2 stores) beats Z (3 stores)
});

test('selectCandidates: cost-only weights make "balanced" match "cheapest" among max-coverage plans', () => {
  const y = fakeSubsetPlan({
    storeAssignments: [fakeAssignment('Kroger', 2, 9), fakeAssignment('Aldi', 1, 6)],
    totalCost: 15, totalDriveMinutes: 20, totalDriveMiles: 10,
  });
  const z = fakeSubsetPlan({
    storeAssignments: [fakeAssignment('Kroger', 1, 4), fakeAssignment('Aldi', 1, 4), fakeAssignment('Sprouts', 1, 4)],
    totalCost: 12, totalDriveMinutes: 30, totalDriveMiles: 15,
  });

  const [balanced] = selectCandidates([y, z], COST_ONLY_WEIGHTS);
  assert.equal(balanced.totalCost, 12);
});

test('estimatedSavings compares against the best-coverage single store, clamped to never go negative', () => {
  const cheapPartialSingleStore = fakeSubsetPlan({ storeAssignments: [fakeAssignment('Kroger', 2, 10)], totalCost: 10 });
  const fullCoverageSingleStore = fakeSubsetPlan({ storeAssignments: [fakeAssignment('Sprouts', 3, 20)], totalCost: 20 });
  const multiStorePlan = fakeSubsetPlan({
    storeAssignments: [fakeAssignment('Kroger', 1, 4), fakeAssignment('Aldi', 1, 4), fakeAssignment('Sprouts', 1, 4)],
    totalCost: 12,
  });

  const [, cheapest] = selectCandidates([cheapPartialSingleStore, fullCoverageSingleStore, multiStorePlan], EQUAL_WEIGHTS);
  assert.equal(cheapest.totalCost, 12);
  assert.equal(cheapest.estimatedSavings, 8); // 20 (full-coverage single store) - 12
});

// ─── Healthiest mode v1 ─────────────────────────────────────────────────────
// selectCandidates reads `totalNutritionScore` directly off each SubsetPlan
// fixture (set by withNutritionScore in real use, before selectCandidates
// ever runs — see shoppingPlanOptimizer.ts) — same "test the pure ranking
// function with hand-built fixtures, no network" approach as every test
// above, just extended with the one new field.

function highScore(overrides: Partial<NutritionScore> = {}): NutritionScore {
  return { score: 0.9, confidence: 'high', productsEvaluated: 2, productsMissingNutrition: 0, ...overrides };
}
function lowScore(overrides: Partial<NutritionScore> = {}): NutritionScore {
  return { score: 0.2, confidence: 'high', productsEvaluated: 2, productsMissingNutrition: 0, ...overrides };
}
function noScore(): NutritionScore {
  return { confidence: 'low', productsEvaluated: 2, productsMissingNutrition: 2 };
}

test('1. Healthiest mode exists when at least one covering plan has a real nutrition score', () => {
  const a = fakeSubsetPlan({ storeAssignments: [fakeAssignment('Kroger', 2, 10)], totalNutritionScore: highScore() });
  const candidates = selectCandidates([a], EQUAL_WEIGHTS);
  const healthiest = candidates.find(c => c.id === 'healthiest');
  assert.ok(healthiest, 'expected a healthiest candidate to be present');
  assert.equal(healthiest!.nutritionScore?.score, 0.9);
});

test('2. Cheapest mode behavior is unchanged by the presence of nutrition scores', () => {
  const cheaperButLessHealthy = fakeSubsetPlan({
    storeAssignments: [fakeAssignment('Kroger', 2, 10)],
    totalCost: 10, totalNutritionScore: lowScore(),
  });
  const pricierButHealthier = fakeSubsetPlan({
    storeAssignments: [fakeAssignment('Kroger', 2, 10)],
    totalCost: 15, totalNutritionScore: highScore(),
  });

  const [, cheapest] = selectCandidates([cheaperButLessHealthy, pricierButHealthier], EQUAL_WEIGHTS);
  // Cheapest must still pick by cost alone — nutrition never leaks into it.
  assert.equal(cheapest.totalCost, 10);
});

test('3. A higher nutrition-score plan ranks above a lower nutrition-score plan', () => {
  const healthier = fakeSubsetPlan({
    storeAssignments: [fakeAssignment('Kroger', 2, 10)],
    totalCost: 10, totalNutritionScore: highScore(),
  });
  const lessHealthy = fakeSubsetPlan({
    storeAssignments: [fakeAssignment('Aldi', 2, 10)],
    totalCost: 10, totalNutritionScore: lowScore(),
  });

  const candidates = selectCandidates([healthier, lessHealthy], EQUAL_WEIGHTS);
  const healthiest = candidates.find(c => c.id === 'healthiest');
  assert.ok(healthiest);
  assert.ok(healthiest!.storeAssignments.some(a => a.store === 'Kroger'));
});

test('4. Missing nutrition on every covering plan does not crash selectCandidates', () => {
  const a = fakeSubsetPlan({ storeAssignments: [fakeAssignment('Kroger', 2, 10)], totalNutritionScore: noScore() });
  const b = fakeSubsetPlan({ storeAssignments: [fakeAssignment('Aldi', 2, 10)], totalNutritionScore: noScore() });
  assert.doesNotThrow(() => selectCandidates([a, b], EQUAL_WEIGHTS));
  // A plan with no `totalNutritionScore` set at all (as if withNutritionScore
  // had never run) must also be handled, not just an explicit "no score" object.
  const c = fakeSubsetPlan({ storeAssignments: [fakeAssignment('Sprouts', 2, 10)] });
  assert.doesNotThrow(() => selectCandidates([c], EQUAL_WEIGHTS));
});

test('5. No nutrition data anywhere disables Healthiest mode outright (omitted, not a fake score)', () => {
  const a = fakeSubsetPlan({ storeAssignments: [fakeAssignment('Kroger', 2, 10)], totalNutritionScore: noScore() });
  const b = fakeSubsetPlan({ storeAssignments: [fakeAssignment('Aldi', 2, 10)] }); // never decorated at all
  const candidates = selectCandidates([a, b], EQUAL_WEIGHTS);
  assert.equal(candidates.find(c => c.id === 'healthiest'), undefined);
  // The other four modes are entirely unaffected by Healthiest being unavailable.
  assert.equal(candidates.length, 4);
});

test('6. Cost remains the tie breaker when nutrition scores match exactly', () => {
  const cheaper = fakeSubsetPlan({
    storeAssignments: [fakeAssignment('Kroger', 2, 10)],
    totalCost: 10, totalNutritionScore: highScore(),
  });
  const pricier = fakeSubsetPlan({
    storeAssignments: [fakeAssignment('Aldi', 2, 10)],
    totalCost: 15, totalNutritionScore: highScore(), // identical score AND confidence
  });

  const candidates = selectCandidates([cheaper, pricier], EQUAL_WEIGHTS);
  const healthiest = candidates.find(c => c.id === 'healthiest');
  assert.ok(healthiest);
  assert.equal(healthiest!.totalCost, 10);
});

test('confidence is the first tie breaker, ahead of cost, when scores match exactly', () => {
  const cheaperButLessConfident = fakeSubsetPlan({
    storeAssignments: [fakeAssignment('Kroger', 2, 10)],
    totalCost: 10, totalNutritionScore: highScore({ confidence: 'partial' }),
  });
  const pricierButMoreConfident = fakeSubsetPlan({
    storeAssignments: [fakeAssignment('Aldi', 2, 10)],
    totalCost: 15, totalNutritionScore: highScore({ confidence: 'high' }),
  });

  const candidates = selectCandidates([cheaperButLessConfident, pricierButMoreConfident], EQUAL_WEIGHTS);
  const healthiest = candidates.find(c => c.id === 'healthiest');
  assert.ok(healthiest);
  assert.equal(healthiest!.totalCost, 15); // the more-confident plan wins despite costing more
});

test('estimatedSavings is 0, never negative, when the winning plan costs more than the single-store baseline', () => {
  const singleStore = fakeSubsetPlan({
    storeAssignments: [fakeAssignment('Kroger', 3, 10)], totalCost: 10, totalDriveMinutes: 30,
  });
  const fastMultiStore = fakeSubsetPlan({
    storeAssignments: [fakeAssignment('Kroger', 2, 8), fakeAssignment('Aldi', 1, 7)],
    totalCost: 15, totalDriveMinutes: 5,
  });

  const [, , fastest] = selectCandidates([singleStore, fastMultiStore], EQUAL_WEIGHTS);
  assert.equal(fastest.totalDriveMinutes, 5);
  assert.equal(fastest.totalCost, 15);
  assert.equal(fastest.estimatedSavings, 0);
});

// ─── Budget Guardian foundation ─────────────────────────────────────────────
// withBudgetAnalysis runs AFTER selectCandidates, as a pure decoration step
// (see shoppingPlanOptimizer.ts) — these tests build real PlanCandidate[]
// via selectCandidates first, exactly like every test above, then verify
// the decoration itself never changes any pre-existing candidate field
// (cost/stores/etc.), only ever adds `budgetAnalysis`. Existing tests above
// are untouched — this is purely additive, matching the sprint's own
// "existing optimizer tests remain unchanged" requirement.

test('1. No budget target leaves candidates exactly as selectCandidates produced them', () => {
  const plan = fakeSubsetPlan({ storeAssignments: [fakeAssignment('Kroger', 2, 10)], totalCost: 10 });
  const candidates = selectCandidates([plan], EQUAL_WEIGHTS);
  const decorated = withBudgetAnalysis(candidates, undefined);
  assert.deepEqual(decorated, candidates);
  assert.ok(decorated.every(c => c.budgetAnalysis === undefined));
});

test('2. Under budget: positive difference, status "under"', () => {
  const plan = fakeSubsetPlan({ storeAssignments: [fakeAssignment('Kroger', 2, 82)], totalCost: 82 });
  const [decorated] = withBudgetAnalysis(selectCandidates([plan], EQUAL_WEIGHTS), 100);
  assert.equal(decorated.budgetAnalysis?.target, 100);
  assert.equal(decorated.budgetAnalysis?.actual, 82);
  assert.equal(decorated.budgetAnalysis?.difference, 18);
  assert.equal(decorated.budgetAnalysis?.status, 'under');
});

test('3. Exact budget: zero difference, status "at_target"', () => {
  const plan = fakeSubsetPlan({ storeAssignments: [fakeAssignment('Kroger', 2, 100)], totalCost: 100 });
  const [decorated] = withBudgetAnalysis(selectCandidates([plan], EQUAL_WEIGHTS), 100);
  assert.equal(decorated.budgetAnalysis?.difference, 0);
  assert.equal(decorated.budgetAnalysis?.status, 'at_target');
});

test('4. Over budget: negative difference, status "over"', () => {
  const plan = fakeSubsetPlan({ storeAssignments: [fakeAssignment('Kroger', 2, 120)], totalCost: 120 });
  const [decorated] = withBudgetAnalysis(selectCandidates([plan], EQUAL_WEIGHTS), 100);
  assert.equal(decorated.budgetAnalysis?.difference, -20);
  assert.equal(decorated.budgetAnalysis?.status, 'over');
});

test('5. Negative, zero, and non-finite budget targets are handled safely — treated as no target, never a crash or a fabricated comparison', () => {
  const plan = fakeSubsetPlan({ storeAssignments: [fakeAssignment('Kroger', 2, 50)], totalCost: 50 });
  const candidates = selectCandidates([plan], EQUAL_WEIGHTS);
  for (const invalid of [-10, 0, NaN, Infinity, -Infinity]) {
    assert.doesNotThrow(() => withBudgetAnalysis(candidates, invalid));
    const decorated = withBudgetAnalysis(candidates, invalid);
    assert.ok(decorated.every(c => c.budgetAnalysis === undefined), `expected no budgetAnalysis for target ${invalid}`);
  }
});

test('6. The cheapest candidate\'s own selection is identical whether or not a budgetTarget is supplied', () => {
  const x = fakeSubsetPlan({ storeAssignments: [fakeAssignment('Kroger', 2, 10)], totalCost: 10 });
  const y = fakeSubsetPlan({ storeAssignments: [fakeAssignment('Aldi', 2, 8)], totalCost: 8 });
  const base = selectCandidates([x, y], EQUAL_WEIGHTS);

  const cheapestWithTarget = withBudgetAnalysis(base, 50).find(c => c.id === 'cheapest')!;
  const cheapestWithoutTarget = withBudgetAnalysis(base, undefined).find(c => c.id === 'cheapest')!;

  assert.equal(cheapestWithTarget.totalCost, cheapestWithoutTarget.totalCost);
  assert.equal(cheapestWithTarget.storeCount, cheapestWithoutTarget.storeCount);
  assert.deepEqual(cheapestWithTarget.storeAssignments, cheapestWithoutTarget.storeAssignments);
});

test('every candidate gets its own budgetAnalysis against the same target, not just one — each compares its own totalCost', () => {
  const cheap = fakeSubsetPlan({ storeAssignments: [fakeAssignment('Kroger', 2, 8)], totalCost: 8 });
  const pricier = fakeSubsetPlan({ storeAssignments: [fakeAssignment('Aldi', 2, 15)], totalCost: 15 });
  const decorated = withBudgetAnalysis(selectCandidates([cheap, pricier], EQUAL_WEIGHTS), 10);

  for (const candidate of decorated) {
    assert.ok(candidate.budgetAnalysis, `expected every candidate (including ${candidate.id}) to carry budgetAnalysis`);
    assert.equal(candidate.budgetAnalysis!.actual, candidate.totalCost);
    assert.equal(candidate.budgetAnalysis!.difference, 10 - candidate.totalCost);
  }
});

// ─── Store Reliability foundation ───────────────────────────────────────────
// excludeKnownClosedStores runs BEFORE evaluateSubset/selectCandidates, on
// plain ItemCandidates fixtures — same "test the pure pre-filter directly,
// no network" approach as every decoration/filter step above.

function fakeLocation(store: StoreName, hours?: StoreLocation['hours']): StoreLocation {
  return { name: store, address: '1 Main St', city: 'Springfield', state: 'TX', zip: '78701', source: 'test-fixture', hours };
}

function fakeProduct(id: string, store: StoreName, hours?: StoreLocation['hours']): ApiProduct {
  return { id, name: `Product ${id}`, brand: 'Brand', price: 3, rating: 4, size: '1 ea', store, location: fakeLocation(store, hours) };
}

function fakeItemCandidates(id: string, candidates: ApiProduct[]): ItemCandidates {
  return { item: { id, rawText: id }, candidates };
}

// A Wednesday (2024-01-03) at 10:00 local time — matches
// storeReliabilityService.test.ts's own fixture date.
const WEDNESDAY_10AM = new Date(2024, 0, 3, 10, 0);

test('1. A product whose store has no hours at all is left exactly as it was', () => {
  const item = fakeItemCandidates('milk', [fakeProduct('a', 'Kroger', undefined)]);
  const [result] = excludeKnownClosedStores([item], WEDNESDAY_10AM);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].id, 'a');
});

test('2. A product whose store is confirmed closed right now is filtered out', () => {
  const item = fakeItemCandidates('milk', [fakeProduct('a', 'Kroger', { wednesday: { closed: true } })]);
  const [result] = excludeKnownClosedStores([item], WEDNESDAY_10AM);
  assert.equal(result.candidates.length, 0);
});

test('3. A product whose store is confirmed open right now remains', () => {
  const item = fakeItemCandidates('milk', [fakeProduct('a', 'Kroger', { wednesday: { open: '08:00', close: '22:00' } })]);
  const [result] = excludeKnownClosedStores([item], WEDNESDAY_10AM);
  assert.equal(result.candidates.length, 1);
});

test('4. Missing day data for today does not crash and leaves the product in place (unknown, not closed)', () => {
  const item = fakeItemCandidates('milk', [fakeProduct('a', 'Kroger', { monday: { open: '08:00', close: '22:00' } })]);
  assert.doesNotThrow(() => excludeKnownClosedStores([item], WEDNESDAY_10AM));
  const [result] = excludeKnownClosedStores([item], WEDNESDAY_10AM);
  assert.equal(result.candidates.length, 1);
});

test('5. Invalid hour formatting does not crash and leaves the product in place (unknown, not closed)', () => {
  const item = fakeItemCandidates('milk', [fakeProduct('a', 'Kroger', { wednesday: { open: '9am', close: '11pm' } })]);
  assert.doesNotThrow(() => excludeKnownClosedStores([item], WEDNESDAY_10AM));
  const [result] = excludeKnownClosedStores([item], WEDNESDAY_10AM);
  assert.equal(result.candidates.length, 1);
});

test('6. selectCandidates behavior is completely unchanged when no product anywhere has hours', () => {
  const a = fakeSubsetPlan({ storeAssignments: [fakeAssignment('Kroger', 2, 10)], totalCost: 10 });
  const b = fakeSubsetPlan({ storeAssignments: [fakeAssignment('Aldi', 2, 8)], totalCost: 8 });
  const withoutFilterStep = selectCandidates([a, b], EQUAL_WEIGHTS);

  // excludeKnownClosedStores only ever touches ItemCandidates (pre-search-
  // resolution), never SubsetPlan/PlanCandidate — so running it earlier in
  // the real pipeline cannot change what selectCandidates itself produces
  // from the same fixtures; this asserts that separation directly.
  const [, cheapest] = withoutFilterStep;
  assert.equal(cheapest.totalCost, 8);
  assert.equal(withoutFilterStep.length, 4);
});

test('a product with no location at all is left in place — nothing to check, and evaluateSubset already excludes location-less products on its own', () => {
  const noLocationProduct: ApiProduct = { id: 'a', name: 'Product a', brand: 'Brand', price: 3, rating: 4, size: '1 ea', store: 'Kroger' };
  const item = fakeItemCandidates('milk', [noLocationProduct]);
  const [result] = excludeKnownClosedStores([item], WEDNESDAY_10AM);
  assert.equal(result.candidates.length, 1);
});

test('excludeKnownClosedStores filters independently per item — one item\'s closed store does not affect another item\'s candidates', () => {
  const closedItem = fakeItemCandidates('milk', [fakeProduct('a', 'Kroger', { wednesday: { closed: true } })]);
  const openItem = fakeItemCandidates('eggs', [fakeProduct('b', 'Aldi', { wednesday: { open: '08:00', close: '22:00' } })]);
  const [resultClosed, resultOpen] = excludeKnownClosedStores([closedItem, openItem], WEDNESDAY_10AM);
  assert.equal(resultClosed.candidates.length, 0);
  assert.equal(resultOpen.candidates.length, 1);
});
