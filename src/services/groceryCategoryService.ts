import type { ApiProduct } from '../models/types';

/**
 * Name-keyword grocery categorization — the same pattern `filterProducts.ts`
 * already uses for `isOrganicProduct` and `routes/search.ts` uses for
 * `isFoodProductName`: no store reliably populates a structured category
 * field (only Aldi sometimes does, via `product_category_name`), so a
 * curated keyword classifier is the real, honest signal available today,
 * not a gap papered over with fabricated data.
 *
 * Used to auto-group the cart checklist (see CartScreen) and to recognize
 * "commonly forgotten" companion items (see cartSuggestionService) — both
 * need "what aisle is this" without any new backend work.
 */
export const GROCERY_CATEGORIES = [
  'Produce',
  'Dairy & Eggs',
  'Meat & Seafood',
  'Bakery',
  'Frozen',
  'Pantry',
  'Beverages',
  'Snacks',
  'Household',
  'Other',
] as const;

export type GroceryCategory = (typeof GROCERY_CATEGORIES)[number];

// Ordered most-specific-first: checked in order, first match wins, so e.g.
// "frozen chicken breast" resolves to Frozen before Meat & Seafood gets a
// chance to claim "chicken."
const CATEGORY_KEYWORDS: [GroceryCategory, string[]][] = [
  ['Frozen', ['frozen', 'ice cream', 'popsicle', 'freezer']],
  ['Produce', [
    'apple', 'banana', 'avocado', 'lettuce', 'tomato', 'onion', 'potato', 'carrot',
    'broccoli', 'spinach', 'kale', 'pepper', 'cucumber', 'mushroom', 'berry', 'berries',
    'grape', 'orange', 'lemon', 'lime', 'melon', 'peach', 'pear', 'plum', 'mango',
    'garlic', 'ginger', 'celery', 'squash', 'zucchini', 'corn', 'cabbage', 'cilantro',
    'herbs', 'salad', 'fruit', 'vegetable', 'produce',
  ]],
  ['Dairy & Eggs', [
    'milk', 'cheese', 'yogurt', 'yoghurt', 'butter', 'cream', 'egg', 'eggs',
    'half and half', 'sour cream', 'cottage cheese', 'cream cheese',
  ]],
  ['Meat & Seafood', [
    'chicken', 'beef', 'pork', 'turkey', 'bacon', 'sausage', 'steak', 'ground beef',
    'salmon', 'shrimp', 'fish', 'tilapia', 'crab', 'lobster', 'ham', 'meat', 'seafood',
    'tenderloin', 'ribs', 'lamb',
  ]],
  ['Bakery', [
    'bread', 'bagel', 'muffin', 'croissant', 'roll', 'bun', 'baguette', 'tortilla',
    'pita', 'cake', 'cookie', 'pastry', 'donut', 'doughnut', 'pie', 'bakery',
  ]],
  ['Beverages', [
    'water', 'soda', 'juice', 'coffee', 'tea', 'beer', 'wine', 'kombucha', 'sparkling',
    'lemonade', 'drink', 'beverage', 'seltzer', 'cola',
  ]],
  ['Snacks', [
    'chips', 'crackers', 'pretzel', 'popcorn', 'nuts', 'trail mix', 'granola bar',
    'candy', 'chocolate', 'snack',
  ]],
  ['Household', [
    'paper towel', 'toilet paper', 'detergent', 'soap', 'cleaner', 'trash bag',
    'foil', 'napkin', 'dish soap', 'sponge', 'batteries',
  ]],
  ['Pantry', [
    'pasta', 'spaghetti', 'penne', 'rotini', 'macaroni', 'rice', 'bean', 'lentil',
    'flour', 'sugar', 'oil', 'vinegar', 'sauce', 'salsa', 'ketchup', 'mustard',
    'mayonnaise', 'cereal', 'oatmeal', 'soup', 'broth', 'stock', 'spice', 'seasoning',
    'peanut butter', 'jam', 'jelly', 'honey', 'syrup', 'canned', 'condiment',
  ]],
];

/** Best-effort grocery-aisle category from the product name — real
 * keyword matching, not a guess presented as certainty; falls back to
 * "Other" (never a fabricated specific category) when nothing matches. */
export function categorizeProduct(product: Pick<ApiProduct, 'name' | 'category'>): GroceryCategory {
  if (product.category) {
    const direct = GROCERY_CATEGORIES.find(
      (c) => c.toLowerCase() === product.category!.toLowerCase().trim(),
    );
    if (direct) return direct;
  }
  const name = product.name.toLowerCase();
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some((kw) => name.includes(kw))) return category;
  }
  return 'Other';
}
