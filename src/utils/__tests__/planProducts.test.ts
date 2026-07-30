import { collectPlanCandidateProducts, countResolvedPlanProducts, flattenPlanCandidateItems } from '../planProducts';
import type { ApiProduct, PlanCandidate, PlanStoreAssignment } from '../../models/types';

function makeProduct(id: string, name: string): ApiProduct {
  return { id, name, brand: 'Brand', price: 3, rating: 4, size: '1 ea', store: 'Kroger' };
}

function makeAssignment(store: PlanStoreAssignment['store'], items: PlanStoreAssignment['items']): PlanStoreAssignment {
  return { store, location: { name: store, address: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' }, items, subtotal: 10 };
}

function makeCandidate(storeAssignments: PlanStoreAssignment[]): PlanCandidate {
  return {
    id: 'balanced', label: 'Balanced', storeAssignments, totalCost: 30, estimatedGasCost: 2, estimatedSavings: 0,
    totalDriveMinutes: 10, totalDriveMiles: 4, storeCount: storeAssignments.length, itemsFound: 2, itemsTotal: 2,
    tripPlan: { origin: { latitude: 0, longitude: 0 }, totalDurationMinutes: 10, totalDistanceMiles: 4, routeGeometry: { type: 'LineString', coordinates: [] }, stops: [] },
  };
}

describe('collectPlanCandidateProducts — Phase 5.4 Part 1', () => {
  test('returns every real, resolved product across all store assignments', () => {
    const milk = makeProduct('milk', 'Whole Milk');
    const eggs = makeProduct('eggs', 'Large Eggs');
    const candidate = makeCandidate([
      makeAssignment('Kroger', [{ listItemId: 'i1', rawText: 'milk', product: milk, notFound: false }]),
      makeAssignment('Aldi', [{ listItemId: 'i2', rawText: 'eggs', product: eggs, notFound: false }]),
    ]);

    expect(collectPlanCandidateProducts(candidate)).toEqual([milk, eggs]);
  });

  test('a missing product (null) is silently excluded, never fabricated — fails gracefully', () => {
    const milk = makeProduct('milk', 'Whole Milk');
    const candidate = makeCandidate([
      makeAssignment('Kroger', [
        { listItemId: 'i1', rawText: 'milk', product: milk, notFound: false },
        { listItemId: 'i2', rawText: 'unobtainium', product: null, notFound: true },
      ]),
    ]);

    const products = collectPlanCandidateProducts(candidate);
    expect(products).toEqual([milk]);
    expect(products.every((p) => p != null)) .toBe(true);
  });

  test('an empty plan (no store assignments) returns an empty list, never invented products', () => {
    expect(collectPlanCandidateProducts(makeCandidate([]))).toEqual([]);
  });

  test('is a pure function with no side effects — calling it twice never mutates the input or any external state', () => {
    const candidate = makeCandidate([makeAssignment('Kroger', [{ listItemId: 'i1', rawText: 'milk', product: makeProduct('milk', 'Whole Milk'), notFound: false }])]);
    const before = JSON.stringify(candidate);
    collectPlanCandidateProducts(candidate);
    collectPlanCandidateProducts(candidate);
    expect(JSON.stringify(candidate)).toBe(before);
  });
});

describe('flattenPlanCandidateItems — Phase 7 P0-2', () => {
  test('returns every real line item across all store assignments, in store-visit order', () => {
    const milkLine = { listItemId: 'i1', rawText: 'milk', product: makeProduct('milk', 'Whole Milk'), notFound: false };
    const eggsLine = { listItemId: 'i2', rawText: 'eggs', product: makeProduct('eggs', 'Large Eggs'), notFound: false };
    const candidate = makeCandidate([
      makeAssignment('Kroger', [milkLine]),
      makeAssignment('Aldi', [eggsLine]),
    ]);

    expect(flattenPlanCandidateItems(candidate)).toEqual([milkLine, eggsLine]);
  });

  test('keeps unresolved line items in place (product: null) — never drops or fabricates one', () => {
    const milkLine = { listItemId: 'i1', rawText: 'milk', product: makeProduct('milk', 'Whole Milk'), notFound: false };
    const missingLine = { listItemId: 'i2', rawText: 'unobtainium', product: null, notFound: true };
    const candidate = makeCandidate([makeAssignment('Kroger', [milkLine, missingLine])]);

    expect(flattenPlanCandidateItems(candidate)).toEqual([milkLine, missingLine]);
  });

  test('an empty plan (no store assignments) returns an empty list', () => {
    expect(flattenPlanCandidateItems(makeCandidate([]))).toEqual([]);
  });

  test('never mutates the input candidate', () => {
    const candidate = makeCandidate([makeAssignment('Kroger', [{ listItemId: 'i1', rawText: 'milk', product: makeProduct('milk', 'Whole Milk'), notFound: false }])]);
    const before = JSON.stringify(candidate);
    flattenPlanCandidateItems(candidate);
    expect(JSON.stringify(candidate)).toBe(before);
  });
});

describe('countResolvedPlanProducts', () => {
  test('counts real resolved vs. missing line items honestly', () => {
    const candidate = makeCandidate([
      makeAssignment('Kroger', [
        { listItemId: 'i1', rawText: 'milk', product: makeProduct('milk', 'Whole Milk'), notFound: false },
        { listItemId: 'i2', rawText: 'unobtainium', product: null, notFound: true },
      ]),
    ]);

    expect(countResolvedPlanProducts(candidate)).toEqual({ resolved: 1, missing: 1 });
  });

  test('a fully-resolved plan reports zero missing', () => {
    const candidate = makeCandidate([makeAssignment('Kroger', [{ listItemId: 'i1', rawText: 'milk', product: makeProduct('milk', 'Whole Milk'), notFound: false }])]);
    expect(countResolvedPlanProducts(candidate)).toEqual({ resolved: 1, missing: 0 });
  });
});
