import type { ApiProduct, PlanCandidate, PlanLineItem } from '../models/types';

/**
 * Shopping Plan Product Visualization (Phase 5.4 Part 1) — pure helpers
 * over data the backend's optimizer already resolved (see
 * backend/src/services/shoppingPlanOptimizer.ts's `evaluateSubset`).
 * Nothing here calls a network, a store, or invents a product: every
 * function is a plain projection over the REAL `ApiProduct` objects
 * already sitting in `PlanCandidate.storeAssignments[].items[].product`.
 */

/** A single real, resolved line item's product — `null` is filtered out,
 * never substituted with a placeholder object. A `PlanLineItem` with no
 * product simply contributes nothing; this never throws and never
 * fabricates a product to fill the gap ("missing product data fails
 * gracefully" — see this file's own tests). */
function resolvedProduct(line: PlanLineItem): ApiProduct | null {
  return line.product ?? null;
}

/** Every real, resolved product across one candidate's own store
 * assignments — used to feed ProductDetail's "other products in this
 * plan" list (see PlannerScreen.tsx/AssistantScreen.tsx) without ever
 * inventing a "related products" set. Order matches the candidate's own
 * store visit order; duplicates are impossible since each real line item
 * appears in exactly one store assignment. */
export function collectPlanCandidateProducts(candidate: PlanCandidate): ApiProduct[] {
  return candidate.storeAssignments.flatMap((assignment) =>
    assignment.items.map(resolvedProduct).filter((p): p is ApiProduct => p !== null),
  );
}

/** Every real `PlanLineItem` across one candidate's own store
 * assignments, flattened into a single list in the candidate's own
 * store-visit order (Phase 7 P0-2 — the "all products in your plan"
 * preview, see PlanResultsView.tsx/ShoppingSessionPlanCard.tsx). This is
 * the exact same real data `collectPlanCandidateProducts` above reads,
 * just kept as `PlanLineItem[]` (not unwrapped to `ApiProduct[]`) so it
 * can feed `PlanItemProductGrid` directly — no new grouping logic, no
 * new product-rendering system, and no duplicate of what
 * `PlanStoreSection` already does per store; this is the same items,
 * ungrouped. */
export function flattenPlanCandidateItems(candidate: PlanCandidate): PlanLineItem[] {
  return candidate.storeAssignments.flatMap((assignment) => assignment.items);
}

/** How many of a candidate's own line items have a real, resolved
 * product vs. how many don't (defensive only — every item inside a real
 * `storeAssignments` entry is resolved by construction; a genuinely
 * unresolved item lives in `ShoppingPlanResponse.unresolvedItems`
 * instead). Never fabricates a count. */
export function countResolvedPlanProducts(candidate: PlanCandidate): { resolved: number; missing: number } {
  let resolved = 0;
  let missing = 0;
  for (const assignment of candidate.storeAssignments) {
    for (const line of assignment.items) {
      if (resolvedProduct(line)) resolved += 1;
      else missing += 1;
    }
  }
  return { resolved, missing };
}
