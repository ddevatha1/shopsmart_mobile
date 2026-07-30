/**
 * Deterministic budget comparison — Budget Guardian Foundation's only new
 * logic, and it isn't optimization: a fixed arithmetic comparison of an
 * already-computed plan's total cost against a shopper-chosen target
 * amount. No AI, no recommendations, no automatic substitution — this
 * module only answers "how does this plan compare to what I said I wanted
 * to spend," never "here's how to get under budget."
 */
import type { BudgetAnalysis } from '../types/index.ts';

/** A budget target only makes sense as a positive, finite dollar amount —
 * zero, negative, NaN, and Infinity are all "no usable target," never
 * clamped to some fabricated substitute value. Callers must check this
 * before calling `computeBudgetAnalysis`, which assumes a valid target. */
export function isValidBudgetTarget(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * `difference = target - actual`: positive means under budget (money left
 * over), negative means over budget, zero means exact — `status` is
 * derived from that same sign so a caller never needs to re-derive it.
 * `target` must already be valid (see `isValidBudgetTarget`) — this
 * function does no validation of its own, matching the rest of this
 * codebase's convention of validating once at the boundary.
 */
export function computeBudgetAnalysis(actual: number, target: number): BudgetAnalysis {
  const difference = target - actual;
  const status: BudgetAnalysis['status'] = difference > 0 ? 'under' : difference < 0 ? 'over' : 'at_target';
  return { target, actual, difference, status };
}
