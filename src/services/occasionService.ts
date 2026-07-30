import type { CartItem } from '../models/types';

/**
 * Deterministic occasion detection — reuses the exact closed-class,
 * hand-curated dictionary pattern cartSuggestionService.ts already uses
 * (PAIRINGS), just requiring co-occurrence across multiple trigger groups
 * instead of a single one. cartSuggestionService answers "you have pasta,
 * you might also want sauce"; this answers "you have BOTH pasta AND
 * sauce, that looks like an Italian meal" — a strictly higher bar, since
 * every required group must have a real match, never a partial one. No
 * LLM, no generated text, no learned model.
 */

export interface OccasionRule {
  tag: string;
  /** Already includes its own article ("an Italian meal") so callers
   * never need English-grammar logic to build a sentence from it. */
  label: string;
  /** Every inner group must have at least one match in the cart for this
   * occasion to be considered detected — this is what makes detection a
   * co-occurrence check, not a single-trigger one. A cart matching only
   * some groups is NOT a match at all (see `detectOccasions`). */
  requiredGroups: string[][];
}

export const OCCASION_TAGS: OccasionRule[] = [
  {
    tag: 'italian-meal',
    label: 'an Italian meal',
    requiredGroups: [
      ['pasta', 'spaghetti', 'penne', 'rotini', 'macaroni', 'fettuccine'],
      ['pasta sauce', 'marinara', 'tomato sauce', 'alfredo sauce'],
    ],
  },
  {
    tag: 'birthday',
    label: 'a birthday celebration',
    requiredGroups: [
      ['cake mix', 'birthday cake', 'cake'],
      ['candles', 'birthday candles'],
    ],
  },
  {
    tag: 'cookout',
    label: 'a cookout',
    requiredGroups: [
      ['burger bun', 'hamburger bun'],
      ['hamburger patty', 'ground beef patty', 'burger patty'],
    ],
  },
];

/** Suggested companions per occasion tag — deliberately excludes anything
 * already required to detect the occasion (no point "suggesting" candles
 * for a birthday the cart already needed candles to detect). Same
 * `MAX_OCCASION_COMPANIONS` cap and "never suggest what's already in the
 * cart" rule as cartSuggestionService.ts's PAIRINGS. */
export const OCCASION_COMPANIONS: Record<string, string[]> = {
  'italian-meal': ['parmesan', 'garlic bread'],
  birthday: ['balloons', 'birthday card'],
  cookout: ['charcoal', 'ketchup'],
};

const MAX_OCCASION_COMPANIONS = 2;

export interface OccasionMatch {
  tag: string;
  label: string;
  companions: string[];
}

/**
 * Returns every occasion whose required groups are ALL satisfied by the
 * cart — never a partial match (missing even one required group means no
 * match for that occasion at all, per `requiredGroups`' own contract).
 * This IS the "only when confidence is high" bar: co-occurrence detection
 * here is fully deterministic keyword matching, so there is no fuzzy
 * middle ground to assign a lower confidence to — a rule either matches
 * completely or it doesn't fire.
 */
export function detectOccasions(items: CartItem[]): OccasionMatch[] {
  if (items.length === 0) return [];
  const cartNames = items.map((i) => i.product.name.toLowerCase());
  const alreadyHave = (term: string) => cartNames.some((n) => n.includes(term));

  const matches: OccasionMatch[] = [];
  for (const rule of OCCASION_TAGS) {
    const allGroupsMatched = rule.requiredGroups.every((group) => group.some((term) => alreadyHave(term)));
    if (!allGroupsMatched) continue;

    const companionPool = OCCASION_COMPANIONS[rule.tag] ?? [];
    const companions: string[] = [];
    for (const companion of companionPool) {
      if (!alreadyHave(companion) && !companions.includes(companion)) companions.push(companion);
      if (companions.length >= MAX_OCCASION_COMPANIONS) break;
    }
    matches.push({ tag: rule.tag, label: rule.label, companions });
  }
  return matches;
}
