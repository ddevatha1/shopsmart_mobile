import type { CartItem } from '../models/types';

/**
 * "You may also need lettuce and tomatoes" — a small, hand-curated
 * companion-item dictionary (same kind of closed-class knowledge as the
 * backend's FILLER_WORDS/CUT_OR_FORM_WORDS lists), not a learned model.
 * Deliberately conservative: only fires on well-known pairings, caps at
 * two suggestions, and never suggests something already in the cart.
 */
const PAIRINGS: { triggers: string[]; suggest: string[] }[] = [
  { triggers: ['ground beef', 'burger bun', 'hamburger bun', 'hamburger patty'], suggest: ['lettuce', 'tomato', 'cheese'] },
  { triggers: ['pasta', 'spaghetti', 'penne', 'rotini', 'macaroni', 'fettuccine'], suggest: ['pasta sauce', 'parmesan'] },
  { triggers: ['taco', 'tortilla'], suggest: ['salsa', 'sour cream'] },
  { triggers: ['cereal'], suggest: ['milk'] },
  { triggers: ['coffee'], suggest: ['creamer'] },
  { triggers: ['tortilla chips'], suggest: ['salsa', 'guacamole'] },
  { triggers: ['sandwich bread', 'white bread', 'wheat bread'], suggest: ['peanut butter', 'deli meat'] },
  { triggers: ['eggs'], suggest: ['bacon'] },
  { triggers: ['chicken breast', 'chicken thigh'], suggest: ['rice', 'seasoning'] },
  { triggers: ['pancake mix'], suggest: ['maple syrup'] },
];

const MAX_SUGGESTIONS = 2;

export function getCartSuggestions(items: CartItem[]): string[] {
  if (items.length === 0) return [];
  const cartNames = items.map((i) => i.product.name.toLowerCase());
  const alreadyHave = (term: string) => cartNames.some((n) => n.includes(term));

  const suggestions: string[] = [];
  for (const { triggers, suggest } of PAIRINGS) {
    if (!triggers.some((t) => alreadyHave(t))) continue;
    for (const s of suggest) {
      if (!alreadyHave(s) && !suggestions.includes(s)) suggestions.push(s);
      if (suggestions.length >= MAX_SUGGESTIONS) return suggestions;
    }
  }
  return suggestions;
}
