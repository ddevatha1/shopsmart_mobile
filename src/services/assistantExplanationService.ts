import type { PlanCandidate } from '../models/types';

/**
 * Explainability Layer (Phase 5.1 Part 4) — converts real, already-
 * computed `PlanCandidate[]` (see backend/src/services/
 * shoppingPlanOptimizer.ts — this file never re-ranks or recomputes
 * anything) into plain-language sentences. Same discipline as
 * assistantResponseService.ts: every sentence is built from a fixed
 * template over fields the candidate already carries — never an LLM
 * call, never a fabricated reason.
 *
 * Rules enforced structurally, not just by convention:
 *  - Never invent a reason a candidate is good — only ever cites a field
 *    that's actually present and actually true for THIS candidate (e.g.
 *    `estimatedSavings > 0`, never a bare "$0.00 saved" phrased as if it
 *    were a real win).
 *  - Only explains fields that exist — `nutritionScore`/`budgetAnalysis`
 *    are optional on `PlanCandidate`; both are guarded and simply omitted
 *    from the sentence when absent, never estimated.
 *  - Never creates an unsupported savings claim — a candidate whose
 *    `estimatedSavings` is 0 (or the candidate isn't 'cheapest') falls
 *    back to stating its real total cost instead of claiming a saving
 *    that isn't there.
 */

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** One real, honest sentence about a single candidate — never a
 * fabricated reason, only ever real fields this exact candidate has. */
export function explainCandidate(candidate: PlanCandidate): string {
  const clauses: string[] = [];

  if (candidate.id === 'cheapest' && candidate.estimatedSavings > 0) {
    clauses.push(`saves $${candidate.estimatedSavings.toFixed(2)} across ${pluralize(candidate.storeCount, 'store')}`);
  } else if (candidate.id === 'fastest' || candidate.id === 'fewest-stops') {
    clauses.push(`about ${Math.round(candidate.totalDriveMinutes)} minute${Math.round(candidate.totalDriveMinutes) === 1 ? '' : 's'} of driving across ${pluralize(candidate.storeCount, 'store')}`);
  } else if (candidate.id === 'healthiest' && candidate.nutritionScore?.score != null) {
    clauses.push(`a nutrition score of ${candidate.nutritionScore.score}`);
  } else {
    clauses.push(`a total cost of $${candidate.totalCost.toFixed(2)} across ${pluralize(candidate.storeCount, 'store')}`);
  }

  if (candidate.budgetAnalysis) {
    const { status, difference } = candidate.budgetAnalysis;
    if (status === 'under') clauses.push(`$${Math.abs(difference).toFixed(2)} under your budget`);
    else if (status === 'over') clauses.push(`$${Math.abs(difference).toFixed(2)} over your budget`);
    else clauses.push('exactly at your budget');
  }

  return `${candidate.label}: ${clauses.join(', ')}.`;
}

/** The multi-option summary matching this sprint's own worked example
 * ("I found three ways to shop: ..."). Empty input is handled honestly —
 * never a fabricated "here are your options" over nothing real. */
export function explainShoppingOptions(candidates: PlanCandidate[]): string {
  if (candidates.length === 0) return "I couldn't find enough real data to compare any options.";
  const lines = candidates.map((c) => `- ${explainCandidate(c)}`);
  return `I found ${pluralize(candidates.length, 'way')} to shop:\n${lines.join('\n')}`;
}

/**
 * Preference explanation (Phase 5.2 Part 5) — the ONE new explanation
 * kind this phase adds. Returns a real sentence ONLY when the already-
 * chosen candidate's own real data actually supports it — never a
 * fabricated "matched your preference." Two independent checks, either
 * of which can produce a sentence (never both invented at once):
 *  - a real store from `preferencesUsed.stores` genuinely appears among
 *    this candidate's own `storeAssignments` — real evidence, not a
 *    restated preference;
 *  - `preferencesUsed.optimizationPreference` literally equals this
 *    candidate's own `id` (both use the same string values —
 *    'cheapest'/'healthiest'/'fastest'/'balanced' — by construction, see
 *    models/types.ts's `OptimizationPreference` and
 *    backend/src/services/shoppingPlanOptimizer.ts's `PlanCandidateId`).
 * `undefined` (nothing said) is the correct, expected result whenever
 * neither check finds real evidence — including when `candidate` or
 * `preferencesUsed` is absent.
 */
export function explainPreferenceMatch(
  candidate: PlanCandidate | undefined,
  preferencesUsed: { stores?: string[]; optimizationPreference?: string } | undefined,
): string | undefined {
  if (!candidate || !preferencesUsed) return undefined;

  const usedStores = new Set(candidate.storeAssignments.map((a) => a.store));
  const matchedStore = preferencesUsed.stores?.find((s) => usedStores.has(s as PlanCandidate['storeAssignments'][number]['store']));
  if (matchedStore) return `Your preferred ${matchedStore} option was included.`;

  if (preferencesUsed.optimizationPreference && preferencesUsed.optimizationPreference === candidate.id) {
    return `This matches your preference for the ${candidate.label.toLowerCase()} option.`;
  }

  return undefined;
}
