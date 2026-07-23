import { categorizeProduct } from '../groceryCategoryService';

describe('categorizeProduct', () => {
  test('classifies common items into their expected aisle', () => {
    expect(categorizeProduct({ name: 'Organic Whole Milk' })).toBe('Dairy & Eggs');
    expect(categorizeProduct({ name: 'Boneless Skinless Chicken Breast' })).toBe('Meat & Seafood');
    expect(categorizeProduct({ name: 'Honeycrisp Apples' })).toBe('Produce');
    expect(categorizeProduct({ name: 'Sourdough Bread' })).toBe('Bakery');
    expect(categorizeProduct({ name: 'Sparkling Water' })).toBe('Beverages');
    expect(categorizeProduct({ name: 'Kettle Cooked Sea Salt Chips' })).toBe('Snacks');
    expect(categorizeProduct({ name: 'Paper Towels' })).toBe('Household');
    expect(categorizeProduct({ name: 'Penne Pasta' })).toBe('Pantry');
  });

  test('prefers the more specific "Frozen" category over a matching food keyword', () => {
    // Would otherwise match "Meat & Seafood" on "chicken" — Frozen keywords
    // are checked first specifically to catch this case.
    expect(categorizeProduct({ name: 'Frozen Chicken Breast' })).toBe('Frozen');
  });

  test('falls back to "Other" for a name matching no keyword', () => {
    expect(categorizeProduct({ name: 'Zzyzx Mystery Item' })).toBe('Other');
  });

  test('is case-insensitive', () => {
    expect(categorizeProduct({ name: 'WHOLE MILK' })).toBe('Dairy & Eggs');
  });

  test('trusts a valid explicit category field over name-keyword matching', () => {
    expect(categorizeProduct({ name: 'Mystery Snack Thing', category: 'snacks' })).toBe('Snacks');
  });

  test('falls back to name matching when the category field is not a recognized aisle', () => {
    expect(categorizeProduct({ name: 'Whole Milk', category: 'Some Store-Specific Bucket' })).toBe('Dairy & Eggs');
  });
});
