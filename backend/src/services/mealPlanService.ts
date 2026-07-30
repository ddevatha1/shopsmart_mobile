import type { MealPlanGenerationRequest, MealPlanGenerationResult, MealPlanMeal, MealType } from '../types/index.ts';

/**
 * Meal Planner v1 (Phase 5.0) — deterministic, curated-template meal
 * generation. NO AI generation of any kind: every meal returned is one
 * of this file's own hand-authored templates, verbatim, never an
 * invented recipe or ingredient. NO prices: this only ever produces
 * ingredient NAMES — real pricing is exactly what /api/search and the
 * planner already do, and is never duplicated or guessed here. NO cart
 * mutation: this is a pure, synchronous function with no side effects at
 * all — the mobile dispatcher (see assistantDispatcher.ts's
 * `dispatchMealPlan`) decides what, if anything, happens with this
 * output, and it never calls a cart-mutation function on its own.
 *
 * Selection is a fixed, documented, deterministic cycle through the
 * curated pool for the requested meal type — the SAME request always
 * produces the SAME meals (see `selectMeals`). This is a v1 foundation,
 * explicitly designed to become AI-powered later without changing this
 * function's contract: a future generator can replace `selectMeals`
 * alone, as long as it keeps returning real, reviewable
 * `MealPlanMeal[]` — see docs/assistant_phase5_roadmap.md §5.
 */

const MAX_MEAL_COUNT = 14;

interface MealTemplate {
  id: string;
  name: string;
  mealType: MealType;
  ingredients: string[];
}

const BREAKFAST_TEMPLATES: MealTemplate[] = [
  { id: 'breakfast-oatmeal', name: 'Oatmeal with Banana', mealType: 'breakfast', ingredients: ['oats', 'banana', 'honey'] },
  { id: 'breakfast-eggs', name: 'Eggs and Toast', mealType: 'breakfast', ingredients: ['eggs', 'bread', 'butter'] },
  { id: 'breakfast-yogurt', name: 'Yogurt Parfait', mealType: 'breakfast', ingredients: ['yogurt', 'granola', 'berries'] },
];

const DINNER_TEMPLATES: MealTemplate[] = [
  { id: 'dinner-tacos', name: 'Chicken Tacos', mealType: 'dinner', ingredients: ['chicken breast', 'tortillas', 'salsa', 'cheese', 'lettuce'] },
  { id: 'dinner-pasta', name: 'Pasta with Marinara', mealType: 'dinner', ingredients: ['pasta', 'marinara sauce', 'parmesan cheese'] },
  { id: 'dinner-stirfry', name: 'Chicken Stir Fry', mealType: 'dinner', ingredients: ['rice', 'mixed vegetables', 'soy sauce', 'chicken breast'] },
];

function templatesFor(mealType: MealType): MealTemplate[] {
  return mealType === 'breakfast' ? BREAKFAST_TEMPLATES : DINNER_TEMPLATES;
}

/** Cycles through the curated pool in a fixed order, repeating from the
 * start once exhausted — never randomized, so the same request always
 * returns the same meals (see mealPlanService.test.ts's determinism
 * test). */
function selectMeals(mealType: MealType, mealCount: number): MealPlanMeal[] {
  const pool = templatesFor(mealType);
  const meals: MealPlanMeal[] = [];
  for (let i = 0; i < mealCount; i++) {
    const template = pool[i % pool.length];
    meals.push({ id: `${template.id}-${i + 1}`, name: template.name, mealType: template.mealType, ingredients: template.ingredients });
  }
  return meals;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Builds the deduplicated grocery list for a set of meals, then folds in
 * any real pantry low-stock signal — advisory only (see
 * docs/assistant_phase5_roadmap.md §6): an ingredient the meals already
 * need is never duplicated; a low-stock item NOT already needed is added
 * and named explicitly in `pantryAdditions`, so a caller can say "I
 * noticed you're low on X and included it" rather than silently changing
 * the list with no explanation.
 */
function buildGroceryList(meals: MealPlanMeal[], lowStockItems: string[]): { groceryItems: string[]; pantryAdditions: string[] } {
  const seen = new Set<string>();
  const groceryItems: string[] = [];

  for (const meal of meals) {
    for (const ingredient of meal.ingredients) {
      const key = normalize(ingredient);
      if (key && !seen.has(key)) {
        seen.add(key);
        groceryItems.push(ingredient);
      }
    }
  }

  const pantryAdditions: string[] = [];
  for (const item of lowStockItems) {
    const key = normalize(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    groceryItems.push(item);
    pantryAdditions.push(item);
  }

  return { groceryItems, pantryAdditions };
}

/** Clamped to [1, MAX_MEAL_COUNT] — never zero/negative meals, never an
 * unbounded count a shopper mistyped (or a hallucinated huge number, if
 * this is ever reached via a future LLM-assisted parameter). */
function clampMealCount(value: number): number {
  return Math.min(Math.max(Math.round(value), 1), MAX_MEAL_COUNT);
}

export function generateMealPlan(request: MealPlanGenerationRequest): MealPlanGenerationResult {
  const mealCount = clampMealCount(request.mealCount);
  const meals = selectMeals(request.mealType, mealCount);
  const { groceryItems, pantryAdditions } = buildGroceryList(meals, request.lowStockItems ?? []);
  return { meals, groceryItems, pantryAdditions };
}
