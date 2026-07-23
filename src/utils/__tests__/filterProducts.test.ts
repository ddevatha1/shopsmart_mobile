import { isOrganicProduct } from '../filterProducts';
import type { ApiProduct } from '../../models/types';

function makeProduct(overrides: Partial<ApiProduct> = {}): ApiProduct {
  return {
    id: 'p1',
    name: 'Whole Milk',
    brand: 'Test Brand',
    price: 3.99,
    rating: 4.5,
    size: '1 gal',
    store: 'Aldi',
    ...overrides,
  };
}

describe('isOrganicProduct', () => {
  test('is true when certifications list includes "Organic" (case-insensitive)', () => {
    expect(isOrganicProduct(makeProduct({ certifications: ['Organic'] }))).toBe(true);
    expect(isOrganicProduct(makeProduct({ certifications: ['ORGANIC'] }))).toBe(true);
  });

  test('is true when the name contains "organic" as a whole word', () => {
    expect(isOrganicProduct(makeProduct({ name: 'Organic Avocado' }))).toBe(true);
    expect(isOrganicProduct(makeProduct({ name: 'Simply Nature Organic Whole Milk' }))).toBe(true);
  });

  test('is false when neither certifications nor name mention organic', () => {
    expect(isOrganicProduct(makeProduct({ name: 'Whole Milk', certifications: ['Non-GMO'] }))).toBe(false);
  });

  test('is false for a name that merely contains "organic" as a substring of another word', () => {
    // \borganic\b requires a word boundary — "organical" (not a real word,
    // but a good adversarial case) should not false-positive.
    expect(isOrganicProduct(makeProduct({ name: 'Organical Blend Snack Mix' }))).toBe(false);
  });

  test('handles a product with no certifications field at all', () => {
    expect(isOrganicProduct(makeProduct({ certifications: undefined, name: 'Regular Bread' }))).toBe(false);
  });
});
