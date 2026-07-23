/**
 * Smart Shopping Planner — the optimization engine. Ported from
 * shopsmart_web's src/services/shoppingPlanOptimizer.ts — see that file for
 * the full design rationale. Reuses this backend's own performSearch,
 * groceryTaxonomy, and tripPlanner exactly the way the web version reuses
 * its own copies of the same pieces.
 *
 * With at most 4 stores (Kroger/Aldi/Sprouts/Trader Joe's), every possible
 * combination of stores to visit is exactly the 15 non-empty subsets of a
 * 4-element set — small enough to brute-force *exactly* rather than reach
 * for a heuristic/approximate solver.
 *
 * No fabricated data: "freshness"/"store reliability"/"store hours" are
 * NOT scored anywhere in here — no real data source for any of them
 * exists in this app.
 */
import type {
  ApiProduct,
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
import { perfLog } from '../utils/perfLog.ts';

// No shared StoreName export in this backend's types/index.ts (same
// convention as searchService.ts) — derived locally instead.
type StoreName = ApiProduct['store'];

const ALL_STORES: StoreName[] = ["Trader Joe's", 'Sprouts', 'Kroger', 'Aldi'];

// ~25 mpg average vehicle, ~$3.50/gal — a documented, clearly-labeled
// approximation, not a real per-trip fuel measurement.
const GAS_COST_PER_MILE = 3.5 / 25;

const DEFAULT_WEIGHTS: PlanWeights = { cost: 0.35, time: 0.25, distance: 0.15, fewerStops: 0.25 };

// ─── Step 1: resolve each list item to its candidate products ─────────────

interface ItemCandidates {
  item: PlannerListItem;
  candidates: ApiProduct[];
  alternativeSuggestion?: ApiProduct;
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

// ─── Step 3: score subsets into the 4 output candidates ────────────────────

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

function toPlanCandidate(id: PlanCandidateId, label: string, plan: SubsetPlan, singleStoreBaseline: number | null): PlanCandidate {
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
  };
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

  return [
    toPlanCandidate('balanced', 'Balanced', balanced, singleStoreBaseline),
    toPlanCandidate('cheapest', 'Cheapest', cheapest, singleStoreBaseline),
    toPlanCandidate('fastest', 'Fastest', fastest, singleStoreBaseline),
    toPlanCandidate('fewest-stops', 'Fewest Stops', fewestStops, singleStoreBaseline),
  ];
}

// ─── Public entry point ─────────────────────────────────────────────────────

export async function buildShoppingPlan(
  items: PlannerListItem[],
  zipcode: string,
  weights: PlanWeights = DEFAULT_WEIGHTS,
): Promise<ShoppingPlanResponse> {
  perfLog('planner:optimization-start', { itemCount: items.length, zipcode, weights });

  const itemCandidates = await Promise.all(items.map(item => resolveItemCandidates(item, zipcode)));

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

  const candidates = selectCandidates(subsetPlans, weights);

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
