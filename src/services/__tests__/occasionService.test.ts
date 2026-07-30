import { detectOccasions } from '../occasionService';
import type { ApiProduct, CartItem } from '../../models/types';

function item(name: string): CartItem {
  const product: ApiProduct = { id: name, name, brand: 'Brand', price: 3, rating: 4, size: '1 ea', store: 'Kroger' };
  return { product, quantity: 1 };
}

describe('detectOccasions', () => {
  test('an empty cart produces no occasions', () => {
    expect(detectOccasions([])).toEqual([]);
  });

  test('a matching pair (pasta + sauce) produces the Italian-meal occasion, with companions', () => {
    const matches = detectOccasions([item('Penne Pasta'), item('Marinara Pasta Sauce')]);
    expect(matches).toHaveLength(1);
    expect(matches[0].tag).toBe('italian-meal');
    expect(matches[0].label).toBe('an Italian meal');
    expect(matches[0].companions.length).toBeGreaterThan(0);
    expect(matches[0].companions).not.toContain('pasta'); // never suggests what's already effectively in cart
  });

  test('cake mix + candles produces the birthday occasion', () => {
    const matches = detectOccasions([item('Chocolate Cake Mix'), item('Birthday Candles')]);
    expect(matches.map((m) => m.tag)).toContain('birthday');
  });

  test('burger buns + patties produces the cookout occasion', () => {
    const matches = detectOccasions([item('Hamburger Buns'), item('Beef Burger Patty')]);
    expect(matches.map((m) => m.tag)).toContain('cookout');
  });

  test('an unrelated cart produces no occasions at all', () => {
    const matches = detectOccasions([item('Whole Milk'), item('Bread'), item('Bananas')]);
    expect(matches).toEqual([]);
  });

  test('a partial match (only one of two required groups) never over-triggers', () => {
    const onlyPasta = detectOccasions([item('Spaghetti')]);
    expect(onlyPasta).toEqual([]);

    const onlyBuns = detectOccasions([item('Hamburger Buns')]);
    expect(onlyBuns).toEqual([]);

    const onlyCandles = detectOccasions([item('Birthday Candles')]);
    expect(onlyCandles).toEqual([]);
  });

  test('companion suggestions never include an item already in the cart', () => {
    const matches = detectOccasions([item('Spaghetti'), item('Marinara Sauce'), item('Parmesan Cheese')]);
    expect(matches[0].companions).not.toContain('parmesan');
  });
});
