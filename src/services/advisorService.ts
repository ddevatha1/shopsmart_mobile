import type { ApiProduct, CartItem, StoreGroup, StoreName, TripPlan } from '../models/types';
import { locationKey } from '../utils/groupCartByStore';
import { getLatestPrice } from './priceHistoryService';
import { getPantryReminders } from './purchaseHistoryService';
import { getBudgetStatus } from './budgetService';
import { parseSize, type EnrichedListing, type ProductGroup } from './comparisonService';
import { isOrganicProduct } from '../utils/filterProducts';
import { getActiveDismissals } from './dismissalStore';
import { estimateAllInventory, type InventoryConfidence } from './inventoryEstimationService';
import { detectOccasions } from './occasionService';
import { findSubstitution } from './substitutionService';
import { getUpcomingExpirations } from './expirationMemoryService';

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
 *
 * Phase 2.5 additions ('low_stock', 'occasion') follow the exact same
 * rule, just from two new domain services rather than inline logic —
 * see inventoryEstimationService.ts and occasionService.ts. `'pantry'` is
 * intentionally left untouched: it only fires with a real ≥2-purchase
 * interval, while `'low_stock'` additionally covers the single-purchase
 * (quantity/category-default) case — the two are complementary signals
 * about the same kind of thing, not a replacement of one by the other.
 *
 * **vs. `assistantSuggestionService.ts` (reviewed again, Phase 6 Part 3;
 * first reviewed Phase 5.5 — same conclusion both times: keep separate).**
 * The two genuinely overlap in DATA (both read purchase-pattern signals
 * derived from `inventoryEstimationService`/`purchaseHistoryService`),
 * but answer different questions for different surfaces:
 *   - This file: "what's the single most worth-interrupting thing to
 *     say on THIS screen, right now" — Home/Cart/Compare each get at
 *     most one insight, picked from candidates spanning deals, budget
 *     status, drive-time tradeoffs, occasions, and pantry/low-stock
 *     signals. Always a passive, ambient surface a shopper didn't ask
 *     for — hence the dismissal-cooldown mechanism (dismissalStore.ts)
 *     so a passive nudge doesn't reappear the moment it's dismissed.
 *   - `assistantSuggestionService.ts`: "here is the FULL, ranked list of
 *     real restock/frequent-purchase/budget suggestions" — scoped to
 *     purchase-pattern data only (no deals, no drive-time, no
 *     occasions), always a direct response to an explicit ask (see
 *     assistantDispatcher.ts's `dispatchStartShoppingSession` restock
 *     branch) rather than something ambiently injected onto a screen.
 * If a future feature needs "one best purchase-pattern insight," extend
 * THIS file's candidate list rather than reaching into the other
 * service — and if a future feature needs "the assistant's full ranked
 * suggestion list," extend that file, not this one. Do not merge them
 * without also collapsing "one pick per screen" and "full list on
 * request" into a single UX decision first — that's a product change,
 * not a refactor.
 */
export type AdvisorInsightKind =
  | 'worth-the-stop'
  | 'skip-the-stop'
  | 'pantry'
  | 'low_stock'
  | 'occasion'
  | 'deal'
  | 'budget'
  | 'well-optimized'
  | 'comparison-tip'
  | 'substitution'
  | 'expiring-soon';

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
   * insight kinds that genuinely point at one product ('deal',
   * 'substitution'); kinds about a store or the cart as a whole
   * (worth-the-stop, budget) have no single product to reference. For
   * 'substitution' specifically, this is the REPLACEMENT product, never
   * the now-unavailable one already in the cart. */
  product?: ApiProduct;
  /** Which action(s) make sense for this insight — a deal just worth
   * looking at gets 'see-product'; a kind meant as an obvious purchase
   * suggestion would also get 'add-to-cart'. Only meaningful alongside
   * `product`. */
  actions?: AdvisorAction[];
  /** A finer-grained identity than `kind` alone for dismissal purposes —
   * e.g. a pantry reminder's `normalizedName`, so dismissing "time to
   * rebuy milk" doesn't also silence every other product's pantry
   * reminder. Falls back to `product?.id`, then to `kind` itself when
   * neither applies (see `dismissalKey`) — most insight kinds don't need
   * to set this explicitly. */
  subjectKey?: string;
}

/** The composite key dismissalStore.ts keys a dismissal by — `kind` alone
 * for insights with no finer identity (budget, well-optimized), `kind` +
 * `subjectKey`/`product.id` for anything more specific (a pantry
 * reminder, a particular deal). Exported so a screen's "Dismiss" action
 * (see AdvisorCard's `onDismiss`) computes the exact same key this
 * module's own filtering checks against. */
export function dismissalKey(insight: AdvisorInsight): string {
  return `${insight.kind}:${insight.subjectKey ?? insight.product?.id ?? insight.kind}`;
}

function pickTop(candidates: AdvisorInsight[]): AdvisorInsight | null {
  if (candidates.length === 0) return null;
  return candidates.slice().sort((a, b) => b.priority - a.priority)[0];
}

/** `pickTop`, but first dropping any candidate currently within its
 * dismissal cooldown (see dismissalStore.ts) — the enforcement point for
 * "a dismissed suggestion should not immediately reappear." `ownerEmail`
 * is optional and omitted entirely skips filtering (signed-out shopper,
 * or a caller that hasn't been wired up to pass it yet) rather than
 * erroring — the exact same "degrade to today's behavior" rule this
 * app's other optional-context patterns already follow. */
async function pickTopWithDismissals(candidates: AdvisorInsight[], ownerEmail?: string): Promise<AdvisorInsight | null> {
  if (candidates.length === 0) return null;
  if (!ownerEmail) return pickTop(candidates);
  const dismissed = await getActiveDismissals(ownerEmail);
  const eligible = candidates.filter((c) => !dismissed.has(dismissalKey(c)));
  // All-dismissed → no insight this call, which is an accepted, correct
  // outcome (same "silence is valid" convention as an empty candidate
  // list), not a fallback to showing a dismissed one anyway.
  return pickTop(eligible);
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

// Never surface a 'low' confidence estimate as an insight — "probably
// running low" needs at least a medium-confidence signal (a real ≥2-
// purchase interval, or a single purchase matched against a conservative
// category default), not a bare guess from one purchase with no pattern.
const LOW_STOCK_CONFIDENCE_RANK: Record<InventoryConfidence, number> = { high: 2, medium: 1, low: 0 };
const LOW_STOCK_MIN_CONFIDENCE_RANK = 1;

/**
 * "You're probably running low on X based on your shopping pattern" —
 * deliberately never "You need X" (see this sprint's own brief): the
 * copy always frames this as a pattern-based inference, not a fact. Pulls
 * from `estimateAllInventory`, the same real purchase-history data
 * `getPantryReminders` already reads, just via the more general
 * inventory-estimation service (canonicalId-aware grouping, quantity- and
 * category-aware for single-purchase products) rather than replacing it.
 */
async function findLowStockCandidate(ownerEmail: string): Promise<AdvisorInsight | null> {
  const estimates = await estimateAllInventory(ownerEmail);
  const qualifying = estimates.filter(
    (e) => e.estimatedStatus === 'likely_low' && LOW_STOCK_CONFIDENCE_RANK[e.confidence] >= LOW_STOCK_MIN_CONFIDENCE_RANK,
  );
  if (qualifying.length === 0) return null;

  const top = qualifying.sort((a, b) => LOW_STOCK_CONFIDENCE_RANK[b.confidence] - LOW_STOCK_CONFIDENCE_RANK[a.confidence])[0];
  return {
    kind: 'low_stock',
    title: `You're probably running low on ${top.displayName} based on your shopping pattern.`,
    detail: top.reason,
    priority: 58,
    // canonicalId when available so dismissing this survives a later
    // purchase of a differently-named but identical product; falls back
    // to the same normalizedName-based identity `productId` already is.
    subjectKey: top.canonicalId ?? top.productId,
  };
}

/**
 * "Your milk expires soon. Want to use it in a recipe?" (Optional
 * Expiration Tracking, Feature 2) — sourced entirely from
 * expirationMemoryService.ts's real, on-device log of dates the AI
 * Product Quality Scanner (Feature 1) happened to read off packaging.
 * Never fires from a guess: no recorded date, or a date this device
 * couldn't parse, both correctly produce nothing (see that service's own
 * `getUpcomingExpirations`).
 */
async function findExpiringSoonCandidate(ownerEmail: string): Promise<AdvisorInsight | null> {
  const upcoming = await getUpcomingExpirations(ownerEmail);
  const top = upcoming[0];
  if (!top) return null;

  return {
    kind: 'expiring-soon',
    title: `Your ${top.displayName} expires soon. Want to use it in a recipe?`,
    detail: top.daysUntilExpiration === 0 ? 'Expires today' : `Expires in ${top.daysUntilExpiration} day${top.daysUntilExpiration === 1 ? '' : 's'}`,
    priority: 62,
    subjectKey: top.normalizedName,
  };
}

export async function getHomeInsight(params: {
  ownerEmail: string;
  recentSearchProducts: ApiProduct[];
}): Promise<AdvisorInsight | null> {
  const candidates: AdvisorInsight[] = [];

  const lowStockInsight = await findLowStockCandidate(params.ownerEmail);
  if (lowStockInsight) candidates.push(lowStockInsight);

  const expiringSoonInsight = await findExpiringSoonCandidate(params.ownerEmail);
  if (expiringSoonInsight) candidates.push(expiringSoonInsight);

  const reminders = await getPantryReminders(params.ownerEmail);
  const topReminder = reminders[0];
  if (topReminder) {
    candidates.push({
      kind: 'pantry',
      title: `It's been about ${topReminder.daysSince} days since you bought ${topReminder.displayName}`,
      detail: `You usually repurchase it every ~${topReminder.typicalIntervalDays} days.`,
      priority: 60 + Math.min(20, topReminder.daysSince - topReminder.typicalIntervalDays),
      // Per-product, not per-kind — dismissing the milk reminder must not
      // also silence an unrelated eggs reminder.
      subjectKey: topReminder.normalizedName,
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

  return pickTopWithDismissals(candidates, params.ownerEmail);
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
  // Keyed by the marginal store's own location, not the kind alone — a
  // shopper who dismisses "skip the stop at Store A" shouldn't have that
  // silence a later, unrelated "worth the stop at Store B."
  const subjectKey = locationKey(marginal.group.location);
  if (knownSavings >= WORTH_IT_SAVINGS_THRESHOLD) {
    return {
      kind: 'worth-the-stop',
      title: `Visit ${marginal.group.location.name}`,
      detail: `+${extraMinutes} min · Save $${knownSavings.toFixed(0)}`,
      priority: 70 + Math.min(20, knownSavings),
      subjectKey,
    };
  }
  if (knownSavings <= SKIP_IT_SAVINGS_CEILING && extraMinutes >= SKIP_IT_MIN_EXTRA_MINUTES) {
    return {
      kind: 'skip-the-stop',
      title: 'Consider skipping the extra stop',
      detail: `Only $${knownSavings.toFixed(0)} savings for ${extraMinutes} extra min`,
      priority: 65,
      subjectKey,
    };
  }
  return null;
}

/**
 * "Looks like you're planning a cookout" — only ever fires on a full,
 * deterministic co-occurrence match (see occasionService.ts's
 * `detectOccasions`); there is no partial-match/lower-confidence tier to
 * fall back to here. When several occasions match at once (rare), picks
 * the one with the most already-satisfied companion suggestions purely
 * as a stable, deterministic tie-break — not a meaningful ranking.
 */
function findOccasionCandidate(items: CartItem[]): AdvisorInsight | null {
  const matches = detectOccasions(items);
  if (matches.length === 0) return null;
  const top = matches[0];
  return {
    kind: 'occasion',
    title: `Looks like you're planning ${top.label}.`,
    detail: top.companions.length > 0 ? `You might also want ${top.companions.join(', ')}.` : undefined,
    priority: 40,
    subjectKey: top.tag,
  };
}

/**
 * "This cart item just went unavailable, try X instead" — the real
 * trigger CartScreen.tsx's own TODO comment (search "substitution-trigger")
 * has been waiting on: `substitutionCandidates` (the cart's own items plus
 * the shopper's last search results) was always real and ready, but no
 * insight kind ever set `.product`, so the navigation path it fed was
 * unreachable. This is that missing kind.
 *
 * The unavailability signal itself is real, never fabricated: a cart
 * item is a snapshot from whenever it was added, so this only fires when
 * `searchProducts` (the shopper's most recent search — the freshest data
 * this app has, no new network call) happens to contain a LATER copy of
 * that exact same product id reporting `inStock: false`. No fresh data
 * for a given cart item -> silence for that item, never a guess. And even
 * when a real "gone unavailable" signal exists, this still only fires
 * alongside a real substitution from `findSubstitution` (same search-
 * results pool) — an unavailable item with no good alternative says
 * nothing useful yet.
 */
function findUnavailableSubstitutionCandidate(items: CartItem[], searchProducts: ApiProduct[]): AdvisorInsight | null {
  for (const item of items) {
    const freshCopy = searchProducts.find((p) => p.id === item.product.id);
    if (!freshCopy || freshCopy.inStock !== false) continue;

    const substitution = findSubstitution(item.product, searchProducts);
    if (!substitution) continue;

    return {
      kind: 'substitution',
      title: `${item.product.name} is no longer available at ${item.product.store}`,
      detail: substitution.reason,
      priority: 80,
      product: substitution.product,
      actions: ['see-product', 'add-to-cart'],
      subjectKey: item.product.id,
    };
  }
  return null;
}

export async function getCartInsight(params: {
  groups: StoreGroup[];
  trip: TripPlan | null;
  cartTotal: number;
  weeklyBudget?: number;
  /** Optional and new — omit to keep today's behavior (no dismissal
   * filtering). See pickTopWithDismissals. */
  ownerEmail?: string;
  /** Optional and new — the shopper's most recent search results, the
   * only source this app has for "fresher than what's in the cart" data.
   * Omitting it keeps today's behavior (the 'substitution' candidate
   * below simply never fires, exactly as if this parameter didn't exist). */
  searchProducts?: ApiProduct[];
}): Promise<AdvisorInsight | null> {
  const candidates: AdvisorInsight[] = [];

  const stopInsight = await evaluateExtraStop(params.groups, params.trip);
  if (stopInsight) candidates.push(stopInsight);

  const occasionInsight = findOccasionCandidate(params.groups.flatMap((g) => g.items));
  if (occasionInsight) candidates.push(occasionInsight);

  const substitutionInsight = findUnavailableSubstitutionCandidate(
    params.groups.flatMap((g) => g.items),
    params.searchProducts ?? [],
  );
  if (substitutionInsight) candidates.push(substitutionInsight);

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

  return pickTopWithDismissals(candidates, params.ownerEmail);
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
  /** Optional — omit to keep today's behavior (no dismissal filtering).
   * See pickTopWithDismissals. Signed-out shoppers pass `undefined` here
   * (ComparisonView reads `useUserStore`'s `user?.email`), which is the
   * normal, expected case for this screen, not a wiring gap. */
  ownerEmail?: string,
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

  return pickTopWithDismissals(candidates, ownerEmail);
}
