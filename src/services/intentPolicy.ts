import type { AssistantSessionContext, ClarificationRequest, Intent, IntentType } from '../models/intent';

/**
 * The Assistant Safety Layer (Phase 3.1) — the boundary that lets a
 * future LLM classifier replace today's deterministic keyword router
 * (see backend/src/services/intentRouterService.ts) without ever letting
 * an uncertain classification cause a real action. Nothing here is
 * specific to the rule-based router: `evaluateIntent` only looks at the
 * `Intent` shape itself (type + confidence), so a future classifier's
 * lower, more varied confidence scores are gated by the exact same
 * policy a deterministic 0.8-or-0 router already satisfies today.
 *
 * Two independent gates, both enforced by assistantDispatcher.ts before
 * any service call:
 *  1. `evaluateIntent` — is this intent confident enough, for its kind
 *     of action, to act on at all?
 *  2. `validateSessionContext` — even if confident, does the app
 *     actually have enough real context (a cart, an active search) to
 *     safely carry the action out?
 * Failing either produces the same user-facing outcome: nothing
 * executes, and a `ClarificationRequest` is offered instead.
 */

export interface IntentDecision {
  allowed: boolean;
  reason?: string;
}

// Below this, an intent is too uncertain to act on at all, regardless of
// type — this is the universal floor, not a per-type setting.
const MINIMUM_CONFIDENCE = 0.6;
// State-mutating intents (they change the cart/account, not just read
// something) need real conviction, not just "more likely than not."
const MUTATION_CONFIDENCE = 0.8;

// Read-only, low-stakes intents — safe to act on at the universal floor.
// 'compare_options' and 'meal_plan' were added here in Phase 3.2, once
// their real dispatcher behavior was actually reviewed (see
// assistantDispatcher.ts): compare_options only ever reads search
// results through comparisonService.ts's existing pure functions, and
// meal_plan's only real behavior is an honest "not available" response
// — neither touches the cart or account, so neither needs the higher
// mutation threshold. This is exactly the deliberate, reviewed promotion
// Phase 3.1's own comment here asked for — not a silent default.
// 'start_shopping_session' was added in Phase 5.1, reviewed the same way
// compare_options/meal_plan were in Phase 3.2: its real dispatcher
// behavior (dispatchStartShoppingSession) never touches the cart or
// account state — it only ever asks real conversational questions,
// persists a local-storage-only session record, and calls the SAME
// read-only `optimizeCart` function `optimize_cart` already uses. No
// mutation path exists, so the universal 0.6 floor is the right bar, not
// the higher mutation threshold.
// 'update_preferences' (Phase 5.2) is reviewed the same way: its real
// dispatcher behavior (dispatchUpdatePreferences) only ever writes to the
// LOCAL, on-device ShopperPreferences record (shopperPreferenceService.ts)
// — never the cart, never the account's own persisted `weeklyBudget`/
// `searchHistory`. It's genuinely a different category from
// MUTATING_INTENTS (cart/account state that costs money or changes what
// ships) — reviewed and placed here deliberately, not defaulted.
const SAFE_INTENTS: ReadonlySet<IntentType> = new Set([
  'search', 'open_planner', 'nutrition_question', 'compare_options', 'meal_plan', 'start_shopping_session',
  'update_preferences',
]);
// Intents that modify cart/account state — require MUTATION_CONFIDENCE,
// not just MINIMUM_CONFIDENCE.
const MUTATING_INTENTS: ReadonlySet<IntentType> = new Set([
  'add_to_cart', 'remove_from_cart', 'optimize_cart', 'set_budget_target',
]);
// Deliberately NOT listed in either set above: 'unknown' — it always
// carries confidence 0 (see backend's intentRouterService.ts), so it's
// blocked by the universal floor regardless of set membership. Per this
// file's own "never silently allow a new capability" convention (see
// models/intent.ts), any FUTURE IntentType added to the closed
// vocabulary without deliberately updating one of these two sets stays
// conservatively BLOCKED by default — see the final fallback in
// `evaluateIntent`.

export function evaluateIntent(intent: Intent): IntentDecision {
  if (intent.confidence < MINIMUM_CONFIDENCE) {
    return {
      allowed: false,
      reason: `Confidence ${intent.confidence.toFixed(2)} is below the minimum ${MINIMUM_CONFIDENCE} required to act on any intent.`,
    };
  }

  if (MUTATING_INTENTS.has(intent.type)) {
    if (intent.confidence < MUTATION_CONFIDENCE) {
      return {
        allowed: false,
        reason: `"${intent.type}" modifies your cart/account, so it needs confidence >= ${MUTATION_CONFIDENCE} (got ${intent.confidence.toFixed(2)}). Actions that modify user state need stronger confidence.`,
      };
    }
    return { allowed: true };
  }

  if (SAFE_INTENTS.has(intent.type)) {
    return { allowed: true };
  }

  return { allowed: false, reason: `"${intent.type}" has not been reviewed as safe or mutating yet — blocked by default.` };
}

const CLARIFICATION_MESSAGES: Partial<Record<IntentType, string>> = {
  search: 'Did you want to search for a product?',
  add_to_cart: 'Did you want to add something to your cart?',
  remove_from_cart: 'Did you want to remove something from your cart?',
  optimize_cart: 'Would you like me to optimize your cart?',
  open_planner: 'Did you want to open the Smart Shopping Planner?',
  set_budget_target: 'Did you want to set a budget target?',
  compare_options: 'Did you want to compare product options?',
  meal_plan: 'Did you want help planning meals?',
  nutrition_question: 'Did you want to ask a nutrition question?',
  start_shopping_session: 'Did you want help planning a shopping trip?',
  update_preferences: 'Did you want me to remember a shopping preference?',
};
const DEFAULT_CLARIFICATION_MESSAGE = "I'm not sure what you meant — could you rephrase that?";

/** Builds the data-only clarification response for a blocked intent —
 * see models/intent.ts's `ClarificationRequest`. No UI reads this yet. */
export function buildClarification(intent: Intent): ClarificationRequest {
  return {
    type: 'clarification',
    message: CLARIFICATION_MESSAGES[intent.type] ?? DEFAULT_CLARIFICATION_MESSAGE,
    originalIntent: intent,
  };
}

/**
 * Whether the app currently has enough real context to safely carry out
 * `intent`, independent of confidence. The brief's literal signature was
 * `validateSessionContext(context): boolean`, but its own rules
 * ("optimize_cart requires cart context," "add_to_cart requires search/
 * product context OR explicit product id") are inherently per-intent —
 * a context-only signature can't express them, so this takes the intent
 * too. Flagged explicitly as a deliberate deviation from the literal
 * snippet, not a silent change.
 *
 * "Explicit product id" for add_to_cart means a real, structured
 * `parameters.productId` — NOT the router's own crude free-text
 * `parameters.item` (e.g. "milk to cart" extracted from "add milk to
 * cart"). Treating raw extracted text as sufficient "context" would make
 * this check nearly meaningless, since the router already sets `item`
 * on every add_to_cart match it produces at all.
 */
export function validateSessionContext(intent: Intent, context: AssistantSessionContext): boolean {
  switch (intent.type) {
    case 'optimize_cart':
    case 'remove_from_cart':
      return (context.cartSize ?? 0) > 0;
    case 'add_to_cart': {
      const hasExplicitProductId = typeof intent.parameters.productId === 'string' && intent.parameters.productId.trim().length > 0;
      const hasSearchOrProductContext = typeof context.activeQuery === 'string' && context.activeQuery.trim().length > 0;
      return hasExplicitProductId || hasSearchOrProductContext;
    }
    default:
      // Do not reject search/nutrition_question (per the brief), and by
      // the same "don't invent a requirement nobody specified" logic,
      // every other intent type not named above is context-independent
      // here too — confidence/safety gating already happened in
      // evaluateIntent, which runs first (see assistantDispatcher.ts).
      return true;
  }
}
