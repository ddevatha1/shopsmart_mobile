import { everyLineMatchesOriginal, looksLikeSameProductType } from '../planValidation';
import type { ApiProduct, CartItem, PlanCandidate, StoreLocation } from '../../models/types';

const LOCATION: StoreLocation = { name: 'Test Store', address: '1 Main St', city: 'Springfield', state: 'TX', zip: '78701' };

function product(id: string, name: string, store: ApiProduct['store'] = 'Kroger'): ApiProduct {
  return { id, name, brand: 'Brand', price: 3, rating: 4, size: '1 ea', store };
}

function cartItem(id: string, name: string): CartItem {
  return { product: product(id, name), quantity: 1 };
}

function candidateWithLine(listItemId: string, resolvedProduct: ApiProduct | null): PlanCandidate {
  return {
    id: 'balanced',
    label: 'Balanced',
    storeAssignments: [
      {
        store: resolvedProduct?.store ?? 'Kroger',
        location: LOCATION,
        items: [{ listItemId, rawText: listItemId, product: resolvedProduct, notFound: resolvedProduct == null }],
        subtotal: resolvedProduct?.price ?? 0,
      },
    ],
    totalCost: resolvedProduct?.price ?? 0,
    estimatedGasCost: 0,
    estimatedSavings: 0,
    totalDriveMinutes: 0,
    totalDriveMiles: 0,
    storeCount: 1,
    itemsFound: 1,
    itemsTotal: 1,
    tripPlan: { origin: { latitude: 0, longitude: 0 }, totalDurationMinutes: 0, totalDistanceMiles: 0, routeGeometry: { type: 'LineString', coordinates: [] }, stops: [] },
  };
}

describe('looksLikeSameProductType', () => {
  // The real bug this guards against: Cart Auto-Optimize's re-search
  // resolved "Kroger Lactose Free 2% Reduced Fat Milk Half Gallon" onto an
  // unrelated tea product whose name happened to contain "Half and Half" —
  // a real dairy term — which even fooled the grocery category classifier
  // alone (both text-matched to "Dairy & Eggs").
  test('rejects products that are not actually the same kind of item, even when categories coincidentally match', () => {
    const milk = product('milk-1', 'Kroger Lactose Free 2% Reduced Fat Milk Half Gallon');
    const tea = product('tea-1', 'Benner Tea Co Benner Prebiotic Tea, Half and Half', 'Aldi');
    expect(looksLikeSameProductType(milk, tea)).toBe(false);
  });

  test('accepts a legitimate cross-store substitution of the same product type', () => {
    const a = product('milk-2', 'Sprouts Organic 2% Reduced Fat Milk');
    const b = product('milk-3', 'Sprouts Organic Unsweetened Almond Milk', 'Sprouts');
    expect(looksLikeSameProductType(a, b)).toBe(true);
  });
});

describe('everyLineMatchesOriginal', () => {
  test('rejects a plan containing a mismatched substitution', () => {
    const original = [cartItem('milk-1', 'Kroger Lactose Free 2% Reduced Fat Milk Half Gallon')];
    const candidate = candidateWithLine('milk-1', product('tea-1', 'Benner Tea Co Benner Prebiotic Tea, Half and Half', 'Aldi'));
    expect(everyLineMatchesOriginal(candidate, original)).toBe(false);
  });

  test('accepts a plan where every line is a legitimate substitution', () => {
    const original = [cartItem('milk-2', 'Sprouts Organic 2% Reduced Fat Milk')];
    const candidate = candidateWithLine('milk-2', product('milk-3', 'Sprouts Organic Unsweetened Almond Milk', 'Sprouts'));
    expect(everyLineMatchesOriginal(candidate, original)).toBe(true);
  });

  test('accepts a line whose product is unchanged from the original (same id)', () => {
    const original = [cartItem('same-1', 'Kroger 2% Reduced Fat Milk Half Gallon')];
    const candidate = candidateWithLine('same-1', product('same-1', 'Kroger 2% Reduced Fat Milk Half Gallon'));
    expect(everyLineMatchesOriginal(candidate, original)).toBe(true);
  });

  test('treats an unresolved (not-found) line as passing — nothing to validate', () => {
    const original = [cartItem('missing-1', 'Some Item')];
    const candidate = candidateWithLine('missing-1', null);
    expect(everyLineMatchesOriginal(candidate, original)).toBe(true);
  });
});
