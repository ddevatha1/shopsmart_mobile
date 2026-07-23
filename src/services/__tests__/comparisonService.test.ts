import { parseSize, getUnitPrice, getBestValueSummary, enrichProducts } from '../comparisonService';
import type { ApiProduct } from '../../models/types';

function makeProduct(overrides: Partial<ApiProduct> = {}): ApiProduct {
  return {
    id: `p-${Math.random()}`,
    name: 'Whole Milk',
    brand: 'Test Brand',
    price: 3.99,
    rating: 4.5,
    size: '1 gal',
    store: 'Aldi',
    ...overrides,
  };
}

describe('parseSize', () => {
  test('parses weight in pounds to ounces', () => {
    expect(parseSize('3 lb')).toEqual({ dimension: 'weight', amount: 48 });
  });

  test('parses volume in gallons to fl oz', () => {
    expect(parseSize('1 gal')).toEqual({ dimension: 'volume', amount: 128 });
  });

  test('parses count sizes ("12 ct")', () => {
    expect(parseSize('12 ct')).toEqual({ dimension: 'count', amount: 12 });
  });

  test('parses a leading fraction word ("Half Gallon")', () => {
    expect(parseSize('Half Gallon')).toEqual({ dimension: 'volume', amount: 64 });
  });

  test('parses "fl oz" as a two-word unit', () => {
    expect(parseSize('32 fl oz')).toEqual({ dimension: 'volume', amount: 32 });
  });

  test('parses a bare "each" with no number as a single count', () => {
    expect(parseSize('each')).toEqual({ dimension: 'count', amount: 1 });
  });

  test('returns null for unparseable or empty sizes rather than guessing', () => {
    expect(parseSize('')).toBeNull();
    expect(parseSize('assorted')).toBeNull();
  });
});

describe('getUnitPrice', () => {
  test('computes a per-lb price for a weight-dimension product at or above 1 lb', () => {
    const product = makeProduct({ price: 8, size: '2 lb' });
    const unit = getUnitPrice(product, 'Ground Beef');
    expect(unit).not.toBeNull();
    expect(unit!.dimension).toBe('weight');
    expect(unit!.label).toBe('$4.00 / lb');
  });

  test('computes a per-gallon price for volume at or above half a gallon', () => {
    const product = makeProduct({ price: 3.99, size: '1 gal' });
    const unit = getUnitPrice(product, 'Whole Milk');
    expect(unit!.label).toBe('$3.99 / gallon');
  });

  test('returns null when the size cannot be parsed, never fabricating a unit price', () => {
    const product = makeProduct({ size: 'assorted' });
    expect(getUnitPrice(product, 'Whole Milk')).toBeNull();
  });
});

describe('getBestValueSummary — implausible savings guard', () => {
  test('never shows a wildly inflated savings figure relative to the product price', () => {
    // Best: a large, economical package. "Worst comparable": a tiny,
    // disproportionately expensive package — naive equivalent-quantity math
    // would multiply the (large) unit-price gap by the (large) equivalent
    // quantity and produce a "Save $792" badge on an $8 item, exactly the
    // class of bug isPlausibleSavings exists to catch.
    const best = makeProduct({ id: 'best', name: 'Bulk Rice', price: 8, size: '5 lb', store: 'Aldi' });
    const worst = makeProduct({ id: 'worst', name: 'Bulk Rice', price: 10, size: '1 oz', store: 'Kroger' });
    const summary = getBestValueSummary(enrichProducts([best, worst], null));
    expect(summary).not.toBeNull();
    expect(summary!.best.product.id).toBe('best');
    expect(summary!.savings).toBeNull();
  });

  test('shows a real, modest savings figure when the math is actually plausible', () => {
    const best = makeProduct({ id: 'best', name: 'Bulk Rice', price: 8, size: '5 lb', store: 'Aldi' });
    const worst = makeProduct({ id: 'worst', name: 'Bulk Rice', price: 2, size: '8 oz', store: 'Kroger' });
    const summary = getBestValueSummary(enrichProducts([best, worst], null));
    expect(summary!.savings).not.toBeNull();
    expect(summary!.savings!).toBeGreaterThan(0);
    expect(summary!.savings!).toBeLessThan(best.price * 3);
  });

  test('returns null for an empty listing set', () => {
    expect(getBestValueSummary([])).toBeNull();
  });

  test('never computes savings against a differently-dimensioned unit price (weight vs. volume)', () => {
    const best = makeProduct({ id: 'best', name: 'Item', price: 5, size: '1 lb', store: 'Aldi' });
    const differentDimension = makeProduct({ id: 'other', name: 'Item', price: 50, size: '1 fl oz', store: 'Kroger' });
    const summary = getBestValueSummary(enrichProducts([best, differentDimension], null));
    // Only one listing shares the "weight" dimension with `best`, so there's
    // nothing valid to compare against — savings must stay null rather than
    // mixing a $/lb figure with a $/fl oz one.
    expect(summary!.savings).toBeNull();
  });
});
