import type { ApiProduct, StoreGroup, StoreName, TripPlan } from '../models/types';
import { locationKey } from '../utils/groupCartByStore';
import { getLatestPrice } from './priceHistoryService';
import { getPantryReminders } from './purchaseHistoryService';
import { getBudgetStatus } from './budgetService';
import { parseSize, type EnrichedListing, type ProductGroup } from './comparisonService';
import { isOrganicProduct } from '../utils/filterProducts';

/**
 * The "Smart Shopping Advisor" — the single ranking engine every
 * intelligent card in the app draws from. Screens never decide what's
 * worth telling the shopper; they hand this module their current context
 * (cart, route, recent search results, budget) and render whatever single
 * top-priority `AdvisorInsight` comes back — or nothing, if none of the
 * candidates cleared their own bar for being worth saying. That "return
 * null and show nothing" path is load-bearing, not a fallback: it's what
 * keeps a first-time shopper's screens looking like today's app (see
 * Progressive Disclosure in the product brief), and what stops five
 * marginal insights from ever competing for the same slot.
 *
 * Every candidate function below only fires on a real, computed signal —
 * never a fabricated number dressed up as personalization. Where the
 * signal doesn't exist yet (no purchase history, no cross-store price
 * data), the candidate simply isn't generated.
 */
export type AdvisorInsightKind =
  | 'worth-the-stop'
  | 'skip-the-stop'
  | 'pantry'
  | 'deal'
  | 'budget'
  | 'well-optimized'
  | 'comparison-tip';

export type AdvisorAction = 'see-product' | 'add-to-cart';

export interface AdvisorInsight {
  kind: AdvisorInsightKind;
  title: string;
  detail?: string;
  /** Higher wins. Only meaningful as a relative ordering within one call
   * to `pickTop` — not a persisted or cross-screen score. */
  priority: number;
  /** A direct reference to the exact product this insight is about, when
   * one exists — never a name string to re-search for. Only ever set for
   * insight kinds that genuinely point at one product ('deal' today);
   * kinds about a store or the cart as a whole (worth-the-stop, budget)
   * have no single product to reference. */
  product?: ApiProduct;
  /** Which action(s) make sense for this insight — a deal just worth
   * looking at gets 'see-product'; a kind meant as an obvious purchase
   * suggestion would also get 'add-to-cart'. Only meaningful alongside
   * `product`. */
  actions?: AdvisorAction[];
}

function pickTop(candidates: AdvisorInsight[]): AdvisorInsight | null {
  if (candidates.length === 0) return null;
  return candidates.slice().sort((a, b) => b.priority - a.priority)[0];
}

// ── Home screen ──────────────────────────────────────────────────────────

const DEAL_DISCOUNT_THRESHOLD_PERCENT = 25;

/** The single best real discount among products this session has actually
 * seen (there is no background full-catalog scan — see the deliverables
 * note on this feature's real scope). Silent when nothing clears the bar,
 * per "if no exceptional deal exists, hide the card entirely." */
function findBestDeal(recentProducts: ApiProduct[]): ApiProduct | null {
  const deals = recentProducts.filter((p) => (p.discountPercent ?? 0) >= DEAL_DISCOUNT_THRESHOLD_PERCENT);
  if (deals.length === 0) return null;
  return deals.reduce((best, p) => ((p.discountPercent ?? 0) > (best.discountPercent ?? 0) ? p : best), deals[0]);
}

export async function getHomeInsight(params: {
  ownerEmail: string;
  recentSearchProducts: ApiProduct[];
}): Promise<AdvisorInsight | null> {
  const candidates: AdvisorInsight[] = [];

  const reminders = await getPantryReminders(params.ownerEmail);
  const topReminder = reminders[0];
  if (topReminder) {
    candidates.push({
      kind: 'pantry',
      title: `It's been about ${topReminder.daysSince} days since you bought ${topReminder.displayName}`,
      detail: `You usually repurchase it every ~${topReminder.typicalIntervalDays} days.`,
      priority: 60 + Math.min(20, topReminder.daysSince - topReminder.typicalIntervalDays),
    });
  }

  const deal = findBestDeal(params.recentSearchProducts);
  if (deal) {
    candidates.push({
      kind: 'deal',
      title: `${deal.name} is ${deal.discountPercent}% off right now`,
      detail: `${deal.store} · $${deal.price.toFixed(2)}${deal.originalPrice != null ? ` (usually $${deal.originalPrice.toFixed(2)})` : ''}`,
      priority: 50 + Math.min(20, (deal.discountPercent ?? 0) / 2),
      // A standout price is worth looking at, not necessarily buying
      // sight-unseen — "See Product" per the brief's own categorization
      // ("simply highlighting a great deal → See Product").
      product: deal,
      actions: ['see-product'],
    });
  }

  return pickTop(candidates);
}

// ── Cart screen ──────────────────────────────────────────────────────────

const WORTH_IT_SAVINGS_THRESHOLD = 5;
const SKIP_IT_SAVINGS_CEILING = 3;
const SKIP_IT_MIN_EXTRA_MINUTES = 8;

/**
 * "Worth the Extra Stop?" — compares the real marginal driving time for
 * the cart's smallest-subtotal store (from an already-planned `trip`,
 * never computed fresh here — see CartScreen's lazy, cached trip fetch)
 * against real observed prices for that store's items at the shopper's
 * *other* cart stores (this device's own price-history log — see
 * priceHistoryService). Requires actually knowing at least one item's
 * price elsewhere; with zero cross-store data it stays silent rather than
 * asserting a savings figure it doesn't have.
 */
async function evaluateExtraStop(groups: StoreGroup[], trip: TripPlan | null): Promise<AdvisorInsight | null> {
  if (!trip || groups.length < 2) return null;

  const withSubtotal = groups.map((group) => ({
    group,
    subtotal: group.items.reduce((sum, i) => sum + i.product.price * i.quantity, 0),
  }));
  const marginal = withSubtotal.reduce((min, s) => (s.subtotal < min.subtotal ? s : min), withSubtotal[0]);
  const stop = trip.stops.find((s) => locationKey(s.location) === locationKey(marginal.group.location));
  if (!stop) return null;

  const otherStores = [...new Set(
    groups.filter((g) => g !== marginal.group).map((g) => g.items[0]?.product.store).filter((s): s is StoreName => !!s),
  )];
  if (otherStores.length === 0) return null;

  let knownSavings = 0;
  let comparedCount = 0;
  for (const item of marginal.group.items) {
    let cheapestElsewhere: number | null = null;
    for (const store of otherStores) {
      const price = await getLatestPrice(item.product.name, store);
      if (price != null && (cheapestElsewhere == null || price < cheapestElsewhere)) cheapestElsewhere = price;
    }
    if (cheapestElsewhere != null) {
      comparedCount++;
      const delta = (cheapestElsewhere - item.product.price) * item.quantity;
      if (delta > 0) knownSavings += delta;
    }
  }
  if (comparedCount === 0) return null;

  const extraMinutes = Math.round(stop.legDurationMinutes);
  if (knownSavings >= WORTH_IT_SAVINGS_THRESHOLD) {
    return {
      kind: 'worth-the-stop',
      title: `Visit ${marginal.group.location.name}`,
      detail: `+${extraMinutes} min · Save $${knownSavings.toFixed(0)}`,
      priority: 70 + Math.min(20, knownSavings),
    };
  }
  if (knownSavings <= SKIP_IT_SAVINGS_CEILING && extraMinutes >= SKIP_IT_MIN_EXTRA_MINUTES) {
    return {
      kind: 'skip-the-stop',
      title: 'Consider skipping the extra stop',
      detail: `Only $${knownSavings.toFixed(0)} savings for ${extraMinutes} extra min`,
      priority: 65,
    };
  }
  return null;
}

export async function getCartInsight(params: {
  groups: StoreGroup[];
  trip: TripPlan | null;
  cartTotal: number;
  weeklyBudget?: number;
}): Promise<AdvisorInsight | null> {
  const candidates: AdvisorInsight[] = [];

  const stopInsight = await evaluateExtraStop(params.groups, params.trip);
  if (stopInsight) candidates.push(stopInsight);

  const budget = getBudgetStatus(params.weeklyBudget, params.cartTotal);
  if (budget && budget.level !== 'ok') {
    candidates.push({
      kind: 'budget',
      title: budget.level === 'over'
        ? `You're $${(budget.spent - budget.budget).toFixed(2)} over your $${budget.budget.toFixed(0)} budget`
        : `You're at ${budget.percentUsed}% of your $${budget.budget.toFixed(0)} budget`,
      priority: budget.level === 'over' ? 90 : 55,
    });
  }

  if (candidates.length === 0 && params.groups.length > 0) {
    candidates.push({ kind: 'well-optimized', title: 'This cart is already well optimized.', priority: 10 });
  }

  return pickTop(candidates);
}

// ── Compare screen ──────────────────────────────────────────────────────

const LARGER_PACKAGE_SAVINGS_THRESHOLD_PERCENT = 10;
const ORGANIC_PREMIUM_CEILING_PERCENT = 15;

/**
 * The Compare screen's single Advisor slot — a complement to the Best Value
 * banner, not a duplicate of it (see the brief's own examples: "The larger
 * package saves 18% per ounce," "You could save another $3 by buying
 * organic elsewhere"). Only ever one insight, same `pickTop` pattern as
 * every other Advisor surface; falls back to a plain "this is today's best
 * value" line when neither of the more specific signals apply.
 */
export async function getComparisonInsight(
  group: ProductGroup,
  listings: EnrichedListing[],
): Promise<AdvisorInsight | null> {
  const withUnitPrice = listings.filter((l) => l.unitPrice != null);
  if (withUnitPrice.length === 0) return null;

  const sorted = [...withUnitPrice].sort((a, b) => a.unitPrice!.value - b.unitPrice!.value);
  const best = sorted[0];
  const candidates: AdvisorInsight[] = [];

  // "The larger package saves N% per unit" — compare the biggest and
  // smallest real package sizes carried across every store in this group.
  const withParsedSize = withUnitPrice
    .map((l) => ({ listing: l, parsed: parseSize(l.product.size) }))
    .filter((x): x is { listing: EnrichedListing; parsed: NonNullable<ReturnType<typeof parseSize>> } => x.parsed != null);
  if (withParsedSize.length >= 2) {
    const largest = withParsedSize.reduce((a, b) => (b.parsed.amount > a.parsed.amount ? b : a));
    const smallest = withParsedSize.reduce((a, b) => (b.parsed.amount < a.parsed.amount ? b : a));
    if (largest.listing.product.id !== smallest.listing.product.id) {
      const largeUnit = largest.listing.unitPrice!.value;
      const smallUnit = smallest.listing.unitPrice!.value;
      const savingsPercent = smallUnit > 0 ? Math.round(((smallUnit - largeUnit) / smallUnit) * 100) : 0;
      if (savingsPercent >= LARGER_PACKAGE_SAVINGS_THRESHOLD_PERCENT) {
        candidates.push({
          kind: 'comparison-tip',
          title: `The larger package saves ${savingsPercent}% per unit`,
          detail: `${largest.listing.product.store}'s ${largest.listing.product.size} is a better deal per unit than the smaller size.`,
          priority: 50 + Math.min(20, savingsPercent),
          product: largest.listing.product,
          actions: ['see-product'],
        });
      }
    }
  }

  // "Go organic for just $X more per unit" — only when the cheapest overall
  // pick isn't already organic and a real organic option exists nearby in
  // price.
  if (!isOrganicProduct(best.product)) {
    const cheapestOrganic = sorted.find((l) => isOrganicProduct(l.product));
    if (cheapestOrganic) {
      const premiumPercent = ((cheapestOrganic.unitPrice!.value - best.unitPrice!.value) / best.unitPrice!.value) * 100;
      if (premiumPercent >= 0 && premiumPercent <= ORGANIC_PREMIUM_CEILING_PERCENT) {
        const extra = cheapestOrganic.unitPrice!.value - best.unitPrice!.value;
        candidates.push({
          kind: 'comparison-tip',
          title: extra > 0.01
            ? `Go organic for just $${extra.toFixed(2)} more per unit`
            : 'The organic option costs about the same',
          detail: `${cheapestOrganic.product.store} · ${cheapestOrganic.unitPrice!.label}`,
          priority: 45,
          product: cheapestOrganic.product,
          actions: ['see-product'],
        });
      }
    }
  }

  if (candidates.length === 0 && listings.length > 1) {
    candidates.push({
      kind: 'comparison-tip',
      title: 'This is today\'s best value',
      detail: `${best.product.store} · ${best.unitPrice!.label}`,
      priority: 30,
      product: best.product,
      actions: ['see-product'],
    });
  }

  return pickTop(candidates);
}
