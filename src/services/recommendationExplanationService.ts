import type { ApiProduct, PlanCandidate } from '../models/types';

/**
 * Recommendation Explanation Engine (Phase 5.3 Part 1) — turns real,
 * already-computed `PlanCandidate` data into STRUCTURED reasons, never
 * free-form AI text (see this file's own header requirement: "Do NOT
 * generate free-form AI text"). This is deliberately separate from
 * assistantExplanationService.ts's sentence-building (`explainCandidate`/
 * `explainShoppingOptions`) — that file produces spoken/displayed
 * PROSE; this one produces a typed, evidence-carrying structure a UI
 * (see components/assistant/WhyThisPlanCard.tsx) can render as a
 * checklist, with every line traceable to a real field.
 *
 * Every `ExplanationReason` this file ever returns carries `evidence`
 * pointing at a real field that was actually read to produce `message`
 * — there is no code path here that invents a reason with no backing
 * data. A candidate with no real savings, no nutrition data, no
 * preference match, and nothing convenience-worthy correctly produces an
 * EMPTY `RecommendationExplanation` (see `explainRecommendation`'s own
 * "fabricated explanations rejected" test) — an empty result is the
 * honest answer, never a filled-in placeholder.
 */

export type ExplanationReasonType = 'budget' | 'nutrition' | 'preference' | 'store' | 'history';

export interface ExplanationReason {
  type: ExplanationReasonType;
  message: string;
  evidence: {
    sourceField: string;
    value: unknown;
  };
}

export interface RecommendationExplanation {
  savingsReasons?: ExplanationReason[];
  healthReasons?: ExplanationReason[];
  preferenceReasons?: ExplanationReason[];
  convenienceReasons?: ExplanationReason[];
  /** Phase 5.5 Part 4 — a real comparison against THIS shopper's own
   * prior purchase history (see `explainProductSelection`'s
   * `explainProductHistory`); plan-level explanations never populate
   * this bucket, since `explainRecommendation` has no per-item purchase
   * history to compare against. */
  historyReasons?: ExplanationReason[];
}

export interface PreferencesUsed {
  stores?: string[];
  optimizationPreference?: string;
}

function explainSavings(candidate: PlanCandidate): ExplanationReason[] {
  const reasons: ExplanationReason[] = [];

  // Only a REAL, positive saving is ever stated as a saving — a
  // candidate whose estimatedSavings is 0 (or the field is somehow
  // negative) never gets an invented "you saved" claim.
  if (candidate.estimatedSavings > 0) {
    reasons.push({
      type: 'budget',
      message: `Saved $${candidate.estimatedSavings.toFixed(2)} compared with the most expensive option.`,
      evidence: { sourceField: 'estimatedSavings', value: candidate.estimatedSavings },
    });
  }

  if (candidate.budgetAnalysis && candidate.budgetAnalysis.target != null) {
    const { status, target, actual } = candidate.budgetAnalysis;
    if (status === 'under' || status === 'at_target') {
      reasons.push({
        type: 'budget',
        message: `Fits within your $${target.toFixed(2)} budget — estimated total is $${actual.toFixed(2)}.`,
        evidence: { sourceField: 'budgetAnalysis', value: candidate.budgetAnalysis },
      });
    }
    // status 'over' is deliberately NOT turned into a "reason this plan
    // is good" — that would be dishonest; a caller wanting to surface
    // over-budget plans should read `budgetAnalysis` directly, not this
    // file's own reason list.
  }

  return reasons;
}

function explainHealth(candidate: PlanCandidate): ExplanationReason[] {
  const score = candidate.nutritionScore?.score;
  if (score == null) return [];

  // nutritionScoringService.ts's own scale is 0-1 — expressed here as
  // "out of 100" purely as a unit conversion for readability, never a
  // rescaled/fabricated number (see that file's own header comment for
  // the 0-1 scale, and this file's own "only explain fields that exist"
  // rule — `score` itself is read and converted, never estimated).
  const scoreOutOf100 = Math.round(score * 100);
  return [{
    type: 'nutrition',
    message: `Has a nutrition score of ${scoreOutOf100} out of 100.`,
    evidence: { sourceField: 'nutritionScore', value: candidate.nutritionScore },
  }];
}

function explainPreferences(candidate: PlanCandidate, preferencesUsed: PreferencesUsed | undefined): ExplanationReason[] {
  if (!preferencesUsed) return [];
  const reasons: ExplanationReason[] = [];

  const usedStores = new Set(candidate.storeAssignments.map((a) => a.store));
  const matchedStores = preferencesUsed.stores?.filter((s) => usedStores.has(s as PlanCandidate['storeAssignments'][number]['store'])) ?? [];
  for (const store of matchedStores) {
    reasons.push({
      type: 'preference',
      message: `Selected ${store} because it matches your preferred stores.`,
      evidence: { sourceField: 'preferredStores', value: preferencesUsed.stores },
    });
  }

  // A match is REAL only when the candidate's own id literally equals
  // the shopper's stated optimizationPreference (both use the same
  // closed vocabulary — see models/types.ts's OptimizationPreference vs.
  // backend's PlanCandidateId) — never a restated preference with no
  // check against what the optimizer actually produced (see this
  // sprint's own "Not: 'Aldi was ranked higher' unless the optimizer
  // actually ranked it higher" rule).
  if (preferencesUsed.optimizationPreference && preferencesUsed.optimizationPreference === candidate.id) {
    reasons.push({
      type: 'preference',
      message: `Matches your preference for ${candidate.label.toLowerCase()} options.`,
      evidence: { sourceField: 'optimizationPreference', value: preferencesUsed.optimizationPreference },
    });
  }

  return reasons;
}

function explainConvenience(candidate: PlanCandidate): ExplanationReason[] {
  // Only genuinely convenience-distinguishing candidates get a reason
  // here — a plain 'balanced'/'cheapest' 3-store plan with nothing
  // special about its trip isn't awarded a manufactured convenience
  // story just to fill the bucket.
  if (candidate.id !== 'fastest' && candidate.id !== 'fewest-stops' && candidate.storeCount !== 1) return [];

  const minutes = Math.round(candidate.totalDriveMinutes);
  return [{
    type: 'store',
    message: `Only requires ${candidate.storeCount} store${candidate.storeCount === 1 ? '' : 's'} and about ${minutes} minute${minutes === 1 ? '' : 's'} of driving.`,
    evidence: { sourceField: 'storeCount', value: candidate.storeCount },
  }];
}

/**
 * The one entry point — builds a `RecommendationExplanation` for a
 * single, already-chosen `candidate` (typically `plan.recommendedId`'s
 * candidate — see assistantDispatcher.ts's `dispatchStartShoppingSession`).
 * Never re-ranks or recomputes anything; every bucket is independently
 * evidence-gated and simply omitted (not an empty array) when nothing
 * real supports it.
 */
export function explainRecommendation(
  candidate: PlanCandidate,
  preferencesUsed?: PreferencesUsed,
): RecommendationExplanation {
  const savingsReasons = explainSavings(candidate);
  const healthReasons = explainHealth(candidate);
  const preferenceReasons = explainPreferences(candidate, preferencesUsed);
  const convenienceReasons = explainConvenience(candidate);

  return {
    ...(savingsReasons.length > 0 ? { savingsReasons } : {}),
    ...(healthReasons.length > 0 ? { healthReasons } : {}),
    ...(preferenceReasons.length > 0 ? { preferenceReasons } : {}),
    ...(convenienceReasons.length > 0 ? { convenienceReasons } : {}),
  };
}

/** Flattens every reason across all four buckets, in a stable display
 * order — the one thing WhyThisPlanCard.tsx needs to render a flat
 * checklist. */
export function flattenExplanationReasons(explanation: RecommendationExplanation): ExplanationReason[] {
  return [
    ...(explanation.savingsReasons ?? []),
    ...(explanation.healthReasons ?? []),
    ...(explanation.preferenceReasons ?? []),
    ...(explanation.convenienceReasons ?? []),
    ...(explanation.historyReasons ?? []),
  ];
}

// ── Product Detail Intelligence (Phase 5.5 Part 4) ─────────────────────────
// A single-item-grain sibling to `explainRecommendation` above, reusing
// the exact same `RecommendationExplanation`/`ExplanationReason` shape
// and the exact same discipline: every reason carries `evidence` pointing
// at a real field this function actually read, and a bucket is omitted
// (never an empty array) when nothing real supports it. See
// docs/phase5_5_competitive_experience_review.md §6 for which signals
// are honestly supported today — every reason below matches one of that
// table's "Yes" rows; nothing here infers anything not already backed by
// a stored preference, a real purchase record, or a real nutrition field.

export interface ProductSelectionContext {
  /** Real, already-stored preferences (see shopperPreferenceService.ts)
   * — never inferred. */
  preferredStores?: string[];
  dietaryPreferences?: string[];
  /** This shopper's own most recent REAL purchase of this exact product
   * (see purchaseHistoryService.ts's `getMostRecentPurchase`), or
   * `undefined` if they've never bought it. */
  previousPurchase?: { price: number };
  /** Other real products from the same result set this product was shown
   * alongside (e.g. ProductDetailScreen's own `allProducts` route param)
   * — used only for a real per-100g protein comparison, never a second
   * search or a fabricated "similar products" list. */
  comparableProducts?: ApiProduct[];
}

function explainProductPreferenceMatch(product: ApiProduct, context: ProductSelectionContext): ExplanationReason[] {
  const reasons: ExplanationReason[] = [];

  if (context.preferredStores?.includes(product.store)) {
    reasons.push({
      type: 'store',
      message: `Matches your preferred store (${product.store}).`,
      evidence: { sourceField: 'preferredStores', value: context.preferredStores },
    });
  }

  // Only a REAL certification already on this product (from live
  // scraping — see models/types.ts's own doc comment on
  // `ApiProduct.certifications`) counts as a dietary match — never
  // inferred from the product's name or category.
  for (const pref of context.dietaryPreferences ?? []) {
    const matched = product.certifications?.find((c) => c.toLowerCase().includes(pref.toLowerCase()));
    if (matched) {
      reasons.push({
        type: 'preference',
        message: `Matches your ${pref} preference (certified ${matched}).`,
        evidence: { sourceField: 'certifications', value: product.certifications },
      });
    }
  }

  return reasons;
}

function explainProductHistory(product: ApiProduct, context: ProductSelectionContext): ExplanationReason[] {
  const previous = context.previousPurchase;
  // Only a REAL, strictly lower current price than what this shopper
  // actually paid last time counts — equal or higher is simply not
  // mentioned, never spun as an improvement.
  if (previous && product.price < previous.price) {
    return [{
      type: 'history',
      message: `Lower price than your previous purchase ($${product.price.toFixed(2)} vs $${previous.price.toFixed(2)}).`,
      evidence: { sourceField: 'previousPurchase', value: previous },
    }];
  }
  return [];
}

function explainProductNutrition(product: ApiProduct, context: ProductSelectionContext): ExplanationReason[] {
  const protein = product.nutrition?.proteinGPer100g;
  if (protein == null) return [];

  const comparableProtein = (context.comparableProducts ?? [])
    .filter((p) => p.id !== product.id)
    .map((p) => p.nutrition?.proteinGPer100g)
    .filter((value): value is number => value != null);
  if (comparableProtein.length === 0) return [];

  const maxOthers = Math.max(...comparableProtein);
  // Strictly higher than every real comparable's own real protein figure
  // — never "probably higher," and never compared against a product with
  // no nutrition data at all.
  if (protein > maxOthers) {
    return [{
      type: 'nutrition',
      message: `Higher protein than similar options (${protein}g vs ${maxOthers}g per 100g).`,
      evidence: { sourceField: 'nutrition.proteinGPer100g', value: protein },
    }];
  }
  return [];
}

/**
 * "Why CartIQ chose this" (Phase 5.5 Part 4) — the single entry point
 * for per-product explanation, mirroring `explainRecommendation`'s own
 * contract at a narrower grain: independently evidence-gated buckets,
 * omitted (not empty) when nothing real backs them. A product with no
 * matching preference, no cheaper purchase history, and no standout
 * nutrition figure correctly returns an empty `RecommendationExplanation`
 * — the honest answer, never a filled-in placeholder.
 */
export function explainProductSelection(product: ApiProduct, context: ProductSelectionContext = {}): RecommendationExplanation {
  const preferenceReasons = explainProductPreferenceMatch(product, context);
  const historyReasons = explainProductHistory(product, context);
  const healthReasons = explainProductNutrition(product, context);

  return {
    ...(historyReasons.length > 0 ? { historyReasons } : {}),
    ...(healthReasons.length > 0 ? { healthReasons } : {}),
    ...(preferenceReasons.length > 0 ? { preferenceReasons } : {}),
  };
}

/**
 * Phase 6 Part 5 — the exact plain-string badges `ProductCard`'s
 * `whyChosenBadges` prop expects (see PlanItemProductGrid.tsx, this
 * function's only caller), pulled out as its own pure, testable unit
 * rather than left inline in a component closure. Nothing here is new
 * reasoning — it's `explainProductSelection` plus `flattenExplanationReasons`,
 * exactly as PlanItemProductGrid.tsx used to compute it inline. Returns
 * `undefined` (never an empty array) when no real evidence exists, so a
 * caller's `whyChosenBadges && whyChosenBadges.length > 0` check stays
 * simple and correct either way.
 */
export function getWhyChosenBadges(product: ApiProduct, context: ProductSelectionContext = {}): string[] | undefined {
  const messages = flattenExplanationReasons(explainProductSelection(product, context)).map((r) => r.message);
  return messages.length > 0 ? messages : undefined;
}
