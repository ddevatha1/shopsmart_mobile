/**
 * Smart Shopping Planner — the optimization engine. Ported from
 * CartIQ_web's src/services/shoppingPlanOptimizer.ts — see that file for
 * the full design rationale. Reuses this backend's own performSearch,
 * groceryTaxonomy, and tripPlanner exactly the way the web version reuses
 * its own copies of the same pieces.
 *
 * With 5 stores (Trader Joe's/Sprouts/Kroger/Aldi/Harris Teeter —
 * Albertsons is correctly excluded, see ALL_STORES below), every possible
 * combination of stores to visit is exactly the 31 non-empty subsets of a
 * 5-element set — small enough to brute-force *exactly* rather than reach
 * for a heuristic/approximate solver.
 *
 * No fabricated data: "freshness"/"store reliability"/"store hours" are
 * NOT scored anywhere in here — no real data source for any of them
 * exists in this app. The one exception, added deliberately and
 * documented precisely where it happens (see `withNutritionScore`/
 * `selectHealthiest`): the `'healthiest'` candidate scores real,
 * already-extracted `NutritionAttributes` data (see
 * routes/productImage.ts) — never an estimate for a product with no
 * data, and never surfaced at all when no product in the plan has any.
 *
 * Budget Guardian (v1, foundation only — see `withBudgetAnalysis`): an
 * optional shopper-chosen `budgetTarget` is compared against each already-
 * selected candidate's real `totalCost`, purely as arithmetic decoration
 * after the fact. It does not steer `evaluateSubset`/`selectCandidates`
 * toward cheaper choices — that would be actual budget optimization, a
 * separate, later change this sprint deliberately does not make.
 *
 * Store Reliability Foundation (v1 — see `excludeKnownClosedStores`): a
 * product whose store is CONFIRMED closed right now (see
 * storeReliabilityService.ts's `isKnownClosed`) is removed from
 * consideration before subset evaluation even starts — a correctness
 * filter, not a ranking weight. A store with unknown or open hours is
 * completely unaffected; `evaluateSubset`/`selectCandidates` themselves
 * are untouched by this, same separation as the two decorations above.
 */
import type {
  ApiProduct,
  BudgetAnalysis,
  NutritionScore,
  PlanCandidate,
  PlanCandidateId,
  PlanLineItem,
  PlannerListItem,
  PlanStoreAssignment,
  PlanWeights,
  ShoppingPlanResponse,
  StoreLocation,
  TripPlan,
} from '../types/index.ts';
import { performSearch } from './searchService.ts';
import { GROCERY_TAXONOMY, classifyProductSubtype } from '../data/groceryTaxonomy.ts';
import { planTrip } from './tripPlanner.ts';
import { computeNutritionScore } from './nutritionScoringService.ts';
import { computeBudgetAnalysis, isValidBudgetTarget } from './budgetAnalysisService.ts';
import { isKnownClosed } from './storeReliabilityService.ts';
import { perfLog } from '../utils/perfLog.ts';

// No shared StoreName export in this backend's types/index.ts (same
// convention as searchService.ts) — derived locally instead.
type StoreName = ApiProduct['store'];

// Harris Teeter was missing here even though searchService.ts's own
// ALL_STORES includes it (it's a real Kroger-API banner with genuine
// product data) — items only carried there were silently excluded from
// every brute-forced subset and could land in unresolvedItems even
// though search finds them. Albertsons is correctly absent: it has no
// product data source at all (see albertsonsLiveScraper.ts), so a subset
// containing it would never resolve any item anyway. Exported so tests
// can assert against it directly.
export const ALL_STORES: StoreName[] = ["Trader Joe's", 'Sprouts', 'Kroger', 'Aldi', 'Harris Teeter'];

// ~25 mpg average vehicle, ~$3.50/gal — a documented, clearly-labeled
// approximation, not a real per-trip fuel measurement.
const GAS_COST_PER_MILE = 3.5 / 25;

const DEFAULT_WEIGHTS: PlanWeights = { cost: 0.35, time: 0.25, distance: 0.15, fewerStops: 0.25 };

// ─── Step 1: resolve each list item to its candidate products ─────────────

export interface ItemCandidates {
  item: PlannerListItem;
  candidates: ApiProduct[];
  alternativeSuggestion?: ApiProduct;
}

/**
 * Removes, from each item's candidate list, any product whose store is
 * CONFIRMED closed right now — never one whose hours are merely unknown
 * (see storeReliabilityService.ts's `isKnownClosed` for that asymmetry).
 * A product with no `location` at all is left in place: it has no hours
 * to check, and `evaluateSubset`'s own existing filter already excludes
 * any product without a `location` regardless of this function.
 *
 * Runs BEFORE subset evaluation, not as part of it — `evaluateSubset` and
 * `selectCandidates` are completely unaware this filter exists, so no
 * ranking/scoring logic changes; a closed store's product simply isn't
 * an option any subset can pick, the same as if search had never
 * returned it for that store at all.
 */
export function excludeKnownClosedStores(itemCandidates: ItemCandidates[], currentDate: Date = new Date()): ItemCandidates[] {
  return itemCandidates.map(ic => ({
    ...ic,
    candidates: ic.candidates.filter(p => !p.location || !isKnownClosed(p.location, currentDate)),
  }));
}

async function resolveItemCandidates(item: PlannerListItem, zipcode: string): Promise<ItemCandidates> {
  const response = await performSearch(item.rawText, zipcode);
  const direct = response.products.filter(p => p.matchType !== 'related');
  const broad = direct.length > 0 ? direct : response.products;

  let candidates = broad;
  if (item.subtypeId) {
    const entry = item.taxonomyEntryId ? GROCERY_TAXONOMY.find(e => e.id === item.taxonomyEntryId) : undefined;
    if (entry) {
      const filtered = broad.filter(p => classifyProductSubtype(p, entry)?.id === item.subtypeId);
      if (filtered.length > 0) candidates = filtered;
    }
  }

  const alternativeSuggestion = candidates.length === 0 ? response.products[0] : undefined;

  perfLog('planner:item-search-complete', {
    itemId: item.id,
    query: item.rawText,
    subtypeId: item.subtypeId ?? null,
    candidateCount: candidates.length,
  });

  return { item, candidates, alternativeSuggestion };
}

// ─── Step 2: brute-force every store subset ────────────────────────────────

export function allNonEmptySubsets<T>(items: readonly T[]): T[][] {
  const subsets: T[][] = [];
  const n = items.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    const subset: T[] = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) subset.push(items[i]);
    }
    subsets.push(subset);
  }
  return subsets;
}

export interface SubsetPlan {
  storeAssignments: PlanStoreAssignment[];
  totalCost: number;
  estimatedGasCost: number;
  totalDriveMinutes: number;
  totalDriveMiles: number;
  storeCount: number;
  itemsFound: number;
  itemsTotal: number;
  tripPlan: TripPlan;
  /** Set by `withNutritionScore`, a step AFTER `evaluateSubset` runs, not
   * inside it — Healthiest v1 ranks the same cheapest-per-store
   * selection every other mode already uses, it does not change which
   * product `evaluateSubset` picks per item (see this file's header for
   * why that's a deliberately separate, larger future change). Despite
   * the field's singular name (matching the sprint's own naming), it
   * holds the full structured `NutritionScore` breakdown, not a bare
   * number — `selectCandidates`'s healthiest ranking needs `confidence`
   * as a tie-breaker, not just `score`. */
  totalNutritionScore?: NutritionScore;
}

/** Decorates an already-evaluated `SubsetPlan` with its aggregate
 * nutrition score, computed from the exact products `evaluateSubset`
 * already selected (`storeAssignments[].items[].product`) — no new
 * search, no new selection, no change to `evaluateSubset` itself. */
function withNutritionScore(plan: SubsetPlan): SubsetPlan {
  const products = plan.storeAssignments.flatMap(a =>
    a.items.map(i => i.product).filter((p): p is ApiProduct => p != null),
  );
  return { ...plan, totalNutritionScore: computeNutritionScore(products) };
}

async function evaluateSubset(
  storeSubset: StoreName[],
  itemCandidates: ItemCandidates[],
  zipcode: string,
): Promise<SubsetPlan | null> {
  const storeSet = new Set(storeSubset);
  const byStore = new Map<StoreName, { location: StoreLocation; items: PlanLineItem[]; subtotal: number }>();

  for (const { item, candidates } of itemCandidates) {
    const inSubset = candidates.filter(p => storeSet.has(p.store) && p.location);
    const cheapest = inSubset.reduce<ApiProduct | null>(
      (best, p) => (best === null || p.price < best.price ? p : best),
      null,
    );

    if (!cheapest || !cheapest.location) continue;

    const entry = byStore.get(cheapest.store);
    const lineItem: PlanLineItem = { listItemId: item.id, rawText: item.rawText, product: cheapest, notFound: false };
    if (entry) {
      entry.items.push(lineItem);
      entry.subtotal += cheapest.price;
    } else {
      byStore.set(cheapest.store, { location: cheapest.location, items: [lineItem], subtotal: cheapest.price });
    }
  }

  if (byStore.size === 0) return null;

  const stopLocations = Array.from(byStore.values()).map(v => v.location);
  let trip: TripPlan;
  try {
    trip = await planTrip({ zipcode }, stopLocations);
  } catch (err) {
    perfLog('planner:subset-routing-failed', { stores: Array.from(byStore.keys()), error: String(err) });
    return null;
  }

  const storeAssignments: PlanStoreAssignment[] = [];
  for (const stop of trip.stops) {
    const stopKey = `${stop.location.storeId ?? ''}|${stop.location.address}`.toLowerCase();
    const match = Array.from(byStore.entries()).find(
      ([, v]) => `${v.location.storeId ?? ''}|${v.location.address}`.toLowerCase() === stopKey,
    );
    if (!match) continue;
    const [store, v] = match;
    storeAssignments.push({ store, location: v.location, items: v.items, subtotal: v.subtotal });
  }

  const resolvedItemsFound = storeAssignments.reduce((sum, s) => sum + s.items.length, 0);
  const totalCost = storeAssignments.reduce((sum, s) => sum + s.subtotal, 0);

  return {
    storeAssignments,
    totalCost,
    estimatedGasCost: trip.totalDistanceMiles * GAS_COST_PER_MILE,
    totalDriveMinutes: trip.totalDurationMinutes,
    totalDriveMiles: trip.totalDistanceMiles,
    storeCount: storeAssignments.length,
    itemsFound: resolvedItemsFound,
    itemsTotal: itemCandidates.length,
    tripPlan: trip,
  };
}

// ─── Step 3: score subsets into the output candidates (balanced/cheapest/
// fastest/fewest-stops always; healthiest only when nutrition data allows) ──

function normalize(value: number, min: number, max: number, lowerIsBetter: boolean): number {
  if (max === min) return 1;
  const t = (value - min) / (max - min);
  return lowerIsBetter ? 1 - t : t;
}

function scorePlan(plan: SubsetPlan, ranges: Record<'cost' | 'time' | 'distance' | 'stops', [number, number]>, weights: PlanWeights): number {
  return (
    weights.cost * normalize(plan.totalCost, ...ranges.cost, true) +
    weights.time * normalize(plan.totalDriveMinutes, ...ranges.time, true) +
    weights.distance * normalize(plan.totalDriveMiles, ...ranges.distance, true) +
    weights.fewerStops * normalize(plan.storeCount, ...ranges.stops, true)
  );
}

function toPlanCandidate(
  id: PlanCandidateId,
  label: string,
  plan: SubsetPlan,
  singleStoreBaseline: number | null,
  nutritionScore?: NutritionScore,
): PlanCandidate {
  const estimatedSavings = singleStoreBaseline != null ? Math.max(0, singleStoreBaseline - plan.totalCost) : 0;

  for (const assignment of plan.storeAssignments) {
    perfLog('planner:store-selected', {
      candidate: id,
      store: assignment.store,
      itemCount: assignment.items.length,
      reason: `cheapest available option for ${assignment.items.length} item(s) among the stores this plan visits`,
    });
    for (const line of assignment.items) {
      perfLog('planner:item-assigned', {
        candidate: id,
        itemId: line.listItemId,
        chosenStore: assignment.store,
        reason: 'cheapest-candidate-in-considered-stores',
      });
    }
  }
  perfLog('planner:candidate-selected', {
    candidate: id,
    stores: plan.storeAssignments.map(a => a.store),
    totalCost: plan.totalCost,
    storeCount: plan.storeCount,
  });

  return {
    id,
    label,
    storeAssignments: plan.storeAssignments,
    totalCost: plan.totalCost,
    estimatedGasCost: plan.estimatedGasCost,
    estimatedSavings,
    totalDriveMinutes: plan.totalDriveMinutes,
    totalDriveMiles: plan.totalDriveMiles,
    storeCount: plan.storeCount,
    itemsFound: plan.itemsFound,
    itemsTotal: plan.itemsTotal,
    tripPlan: plan.tripPlan,
    ...(nutritionScore && { nutritionScore }),
  };
}

function confidenceRank(confidence: NutritionScore['confidence']): number {
  return confidence === 'high' ? 2 : confidence === 'partial' ? 1 : 0;
}

/**
 * Ranks the SAME `covering` (max-coverage) plans every other mode
 * already ranks from, by aggregate nutrition score — never a separate,
 * lower-coverage candidate pool. Returns `null` when not one `covering`
 * plan has any usable nutrition signal at all, which is exactly what
 * makes Healthiest mode "unavailable" rather than an arbitrary pick with
 * a fabricated score (see selectCandidates, which omits the candidate
 * entirely in that case).
 *
 * Tie-breakers, in order, per the sprint brief ("do not invent other
 * preferences"): higher confidence, then lower cost, then fewer stores —
 * the same style of deterministic, fully-ordered comparator every other
 * mode here already uses.
 */
function selectHealthiest(covering: SubsetPlan[]): SubsetPlan | null {
  const withScore = covering.filter(p => p.totalNutritionScore?.score != null);
  if (withScore.length === 0) return null;

  return [...withScore].sort((a, b) => {
    const scoreDiff = b.totalNutritionScore!.score! - a.totalNutritionScore!.score!;
    if (scoreDiff !== 0) return scoreDiff;
    const confidenceDiff = confidenceRank(b.totalNutritionScore!.confidence) - confidenceRank(a.totalNutritionScore!.confidence);
    if (confidenceDiff !== 0) return confidenceDiff;
    if (a.totalCost !== b.totalCost) return a.totalCost - b.totalCost;
    return a.storeCount - b.storeCount;
  })[0];
}

export function selectCandidates(subsetPlans: SubsetPlan[], weights: PlanWeights): PlanCandidate[] {
  const maxCoverage = Math.max(...subsetPlans.map(p => p.itemsFound));
  const covering = subsetPlans.filter(p => p.itemsFound === maxCoverage);

  const singleStorePlans = subsetPlans.filter(p => p.storeCount === 1);
  const bestSingleStore = singleStorePlans.reduce<SubsetPlan | null>((best, p) => {
    if (!best) return p;
    if (p.itemsFound !== best.itemsFound) return p.itemsFound > best.itemsFound ? p : best;
    return p.totalCost < best.totalCost ? p : best;
  }, null);
  const singleStoreBaseline = bestSingleStore?.totalCost ?? null;

  const cheapest = [...covering].sort((a, b) => a.totalCost - b.totalCost || a.storeCount - b.storeCount)[0];
  const fastest = [...covering].sort((a, b) => a.totalDriveMinutes - b.totalDriveMinutes || a.totalCost - b.totalCost)[0];
  const fewestStops = [...covering].sort((a, b) => a.storeCount - b.storeCount || a.totalCost - b.totalCost)[0];

  const ranges: Record<'cost' | 'time' | 'distance' | 'stops', [number, number]> = {
    cost: [Math.min(...covering.map(p => p.totalCost)), Math.max(...covering.map(p => p.totalCost))],
    time: [Math.min(...covering.map(p => p.totalDriveMinutes)), Math.max(...covering.map(p => p.totalDriveMinutes))],
    distance: [Math.min(...covering.map(p => p.totalDriveMiles)), Math.max(...covering.map(p => p.totalDriveMiles))],
    stops: [Math.min(...covering.map(p => p.storeCount)), Math.max(...covering.map(p => p.storeCount))],
  };
  const balanced = [...covering].sort((a, b) => scorePlan(b, ranges, weights) - scorePlan(a, ranges, weights))[0];

  const candidates: PlanCandidate[] = [
    toPlanCandidate('balanced', 'Balanced', balanced, singleStoreBaseline),
    toPlanCandidate('cheapest', 'Cheapest', cheapest, singleStoreBaseline),
    toPlanCandidate('fastest', 'Fastest', fastest, singleStoreBaseline),
    toPlanCandidate('fewest-stops', 'Fewest Stops', fewestStops, singleStoreBaseline),
  ];

  // Omitted entirely (not pushed with a null/fake score) when no
  // covering plan has any nutrition signal — "unavailable," per the
  // sprint brief, means absent from the response, not present-but-empty.
  const healthiest = selectHealthiest(covering);
  if (healthiest) {
    candidates.push(toPlanCandidate('healthiest', 'Healthiest', healthiest, singleStoreBaseline, healthiest.totalNutritionScore));
  }

  return candidates;
}

/**
 * Decorates every candidate with a `BudgetAnalysis` against the same
 * shopper-chosen `budgetTarget` — unlike `withNutritionScore`, this runs
 * AFTER candidate selection (`selectCandidates`), not before, since it
 * needs each candidate's final `totalCost`, and it never influences which
 * candidates were chosen or how they were ranked. An invalid target
 * (missing, zero, negative, non-finite) leaves every candidate exactly as
 * `selectCandidates` produced it — never a comparison against a
 * nonsensical value.
 */
export function withBudgetAnalysis(candidates: PlanCandidate[], budgetTarget: number | undefined): PlanCandidate[] {
  if (!isValidBudgetTarget(budgetTarget)) return candidates;
  return candidates.map(candidate => ({
    ...candidate,
    budgetAnalysis: computeBudgetAnalysis(candidate.totalCost, budgetTarget) satisfies BudgetAnalysis,
  }));
}

// ─── Public entry point ─────────────────────────────────────────────────────

export async function buildShoppingPlan(
  items: PlannerListItem[],
  zipcode: string,
  weights: PlanWeights = DEFAULT_WEIGHTS,
  budgetTarget?: number,
): Promise<ShoppingPlanResponse> {
  perfLog('planner:optimization-start', { itemCount: items.length, zipcode, weights, budgetTarget: budgetTarget ?? null });

  const resolvedItemCandidates = await Promise.all(items.map(item => resolveItemCandidates(item, zipcode)));
  // A correctness filter, not part of resolution or evaluation itself —
  // see excludeKnownClosedStores's own comment and this file's header.
  const itemCandidates = excludeKnownClosedStores(resolvedItemCandidates);

  const subsets = allNonEmptySubsets(ALL_STORES);
  const subsetResults = await Promise.allSettled(
    subsets.map(subset => evaluateSubset(subset, itemCandidates, zipcode)),
  );

  const subsetPlans: SubsetPlan[] = [];
  subsetResults.forEach((result, i) => {
    if (result.status === 'fulfilled' && result.value) {
      subsetPlans.push(result.value);
      perfLog('planner:subset-evaluated', {
        stores: subsets[i],
        coverage: result.value.itemsFound,
        cost: result.value.totalCost,
        driveMinutes: Math.round(result.value.totalDriveMinutes),
      });
    }
  });

  if (subsetPlans.length === 0) {
    throw new Error('Could not build a shopping plan — no store had usable results for this list near this ZIP code.');
  }

  // A decoration pass, not a change to evaluateSubset's own selection —
  // see withNutritionScore's own comment.
  const subsetPlansWithNutrition = subsetPlans.map(withNutritionScore);

  const candidates = withBudgetAnalysis(selectCandidates(subsetPlansWithNutrition, weights), budgetTarget);

  const unresolvedItems: PlanLineItem[] = itemCandidates
    .filter(ic => ic.candidates.length === 0)
    .map(ic => ({
      listItemId: ic.item.id,
      rawText: ic.item.rawText,
      product: null,
      notFound: true,
      alternativeSuggestion: ic.alternativeSuggestion,
    }));

  perfLog('planner:optimization-complete', {
    itemCount: items.length,
    recommendedStores: candidates[0].storeAssignments.map(a => a.store),
    recommendedCost: candidates[0].totalCost,
    unresolvedCount: unresolvedItems.length,
  });

  return { candidates, recommendedId: 'balanced', unresolvedItems };
}
