/**
 * Deterministic nutrition scoring — Healthiest mode v1's only new "AI-
 * adjacent" logic, and it isn't AI at all: a fixed, documented arithmetic
 * formula over whatever `NutritionAttributes` a product already carries
 * (see routes/productImage.ts's `extractNutrition`), no external calls,
 * no network, no estimates for missing data. See this module's own
 * `computeNutritionScore` for the one rule that matters most: a product
 * with no nutrition data contributes NOTHING to the average — it is
 * never treated as scoring 0, which would silently make "we don't know"
 * indistinguishable from "this is unhealthy."
 *
 * Deliberately backend-only (no mobile mirror) — nothing on the client
 * consumes this yet (see types/index.ts's `PlanCandidate.nutritionScore`
 * comment).
 */
import type { ApiProduct, NutritionAttributes, NutritionScore } from '../types/index.ts';

// Reasonable, documented, deterministic reference points — not derived
// from any external nutrition-science API, a defensible v1
// approximation. "Ceiling" means "at or beyond this amount, the
// component scores its maximum (or minimum, for the two where lower is
// better)" — these are intentionally generous (foods well past ordinary
// grocery items) so a very-high-protein or very-low-sodium product
// doesn't need to be extreme to score well, while still giving the
// formula a bounded, saturating shape rather than an unbounded one.
const PROTEIN_CEILING_G_PER_100G = 20; // a high-protein food (e.g. chicken breast, Greek yogurt)
const FIBER_CEILING_G_PER_100G = 10; // a high-fiber food
const SUGAR_CEILING_G_PER_100G = 20; // a very sugary food — worse beyond this, per 100g
const SODIUM_CEILING_MG_PER_100G = 800; // a very high-sodium food — worse beyond this, per 100g

const NUTRISCORE_VALUES: Record<NonNullable<NutritionAttributes['nutriScore']>, number> = {
  a: 1, b: 0.8, c: 0.6, d: 0.4, e: 0.2,
};

/** One product's health sub-score, 0-1, or `null` when it has no
 * nutrition data this formula can use at all. Only the components a
 * product actually has data for are averaged — never a 0 filled in for
 * a missing one (see this module's header comment). */
function scoreProductNutrition(nutrition: NutritionAttributes): number | null {
  const components: number[] = [];

  if (nutrition.proteinGPer100g != null) {
    components.push(Math.min(nutrition.proteinGPer100g / PROTEIN_CEILING_G_PER_100G, 1));
  }
  if (nutrition.fiberGPer100g != null) {
    components.push(Math.min(nutrition.fiberGPer100g / FIBER_CEILING_G_PER_100G, 1));
  }
  if (nutrition.sugarGPer100g != null) {
    components.push(1 - Math.min(nutrition.sugarGPer100g / SUGAR_CEILING_G_PER_100G, 1));
  }
  if (nutrition.sodiumMgPer100g != null) {
    components.push(1 - Math.min(nutrition.sodiumMgPer100g / SODIUM_CEILING_MG_PER_100G, 1));
  }
  if (nutrition.nutriScore != null) {
    components.push(NUTRISCORE_VALUES[nutrition.nutriScore]);
  }

  if (components.length === 0) return null;
  return components.reduce((sum, c) => sum + c, 0) / components.length;
}

/**
 * Aggregates a nutrition score across a set of already-selected products
 * (e.g. one subset plan's chosen items — see
 * shoppingPlanOptimizer.ts's `withNutritionScore`). Confidence rule,
 * deliberately simple rather than a tunable ratio (see the sprint brief's
 * own "do not invent other preferences"):
 *
 *  - No product in the set has any usable nutrition signal → `score` is
 *    omitted entirely, `confidence: 'low'`. A caller (Healthiest mode's
 *    ranking) must treat this as "unavailable," never as "score 0."
 *  - Every product has usable data AND every one of those is
 *    `completeness: 'complete'` → `confidence: 'high'`.
 *  - Anything in between (some products missing, or present data that's
 *    only `'partial'`) → `confidence: 'partial'`. The overwhelming
 *    real-world case, since most grocery products won't have nutrition
 *    data at all yet (see routes/productImage.ts's Open Food Facts
 *    match rate).
 */
export function computeNutritionScore(products: ApiProduct[]): NutritionScore {
  const productsEvaluated = products.length;
  const scored: { score: number; complete: boolean }[] = [];
  let productsMissingNutrition = 0;

  for (const product of products) {
    const componentScore = product.nutrition ? scoreProductNutrition(product.nutrition) : null;
    if (componentScore == null) {
      productsMissingNutrition += 1;
      continue;
    }
    scored.push({ score: componentScore, complete: product.nutrition!.completeness === 'complete' });
  }

  if (scored.length === 0) {
    return { confidence: 'low', productsEvaluated, productsMissingNutrition };
  }

  const score = scored.reduce((sum, s) => sum + s.score, 0) / scored.length;
  const allComplete = productsMissingNutrition === 0 && scored.every(s => s.complete);

  return {
    score,
    confidence: allComplete ? 'high' : 'partial',
    productsEvaluated,
    productsMissingNutrition,
  };
}
