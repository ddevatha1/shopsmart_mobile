import type {
  AssistantActionResult, AssistantSessionContext, CartConfirmationResult, CartMutationResult, ComparisonResult, Intent,
  MealPlanResult, NutritionResult, PlannerAction, PreferenceUpdateResult, ProductSelectionResult,
  RestockSuggestionsResult, ShoppingGoal, ShoppingHistoryResult, ShoppingSessionPlanResult,
} from '../models/intent';
import type {
  ApiProduct, CartItem, MealPlanGenerationRequest, MealPlanGenerationResult, MealType, PlannerListItem, SearchResponse,
  ShoppingPlanResponse,
} from '../models/types';
import { searchRepository } from '../repositories/searchRepository';
import { generateShoppingPlan } from './plannerService';
import { requestMealPlan } from './mealPlanService';
import { getLikelyLowStockDisplayNames } from './inventoryEstimationService';
import { enrichProducts, getBestValueSummary } from './comparisonService';
import { resolveProductRequest, resolveCartItemForRemoval } from './productResolutionService';
import {
  createPendingCartMutationConfirmation, createPendingProductSelection, getPendingCartMutationConfirmation,
  clearPendingCartMutationConfirmation,
} from './productSelectionStore';
import { createPendingConversation } from './assistantConversationStore';
import { createSession, getSessionHistory } from './assistantShoppingSessionStore';
import { explainShoppingOptions, explainPreferenceMatch } from './assistantExplanationService';
import { explainRecommendation } from './recommendationExplanationService';
import { compareSessionToHistory } from './shoppingHistoryInsightService';
import { parseListInput } from './plannerAmbiguityService';
import { getPreferences, applyPreferenceUpdate } from './shopperPreferenceService';
import { getShoppingSuggestions } from './assistantSuggestionService';
import { useUserStore } from '../store/userStore';
import { useCartStore } from '../store/cartStore';
import { buildClarification, evaluateIntent, validateSessionContext } from './intentPolicy';

/**
 * The Assistant Boundary's other half (see src/models/intent.ts):
 * `Intent → policy check → existing app service → verified result`,
 * never `Intent → invented result` and never `Intent → action` without
 * the policy check in between (see intentPolicy.ts). This is
 * deliberately the ONLY place a resolved `Intent` is allowed to trigger
 * app behavior — a future voice/text entry point calls `dispatchIntent`,
 * never the underlying services (or the policy) directly, so every
 * intent-driven action goes through this one, reviewable boundary.
 *
 * Phase 3.2 wired four more intents to real existing services —
 * 'open_planner' (a UI instruction, see `dispatchOpenPlanner`),
 * 'nutrition_question' and 'compare_options' (both thin adapters over
 * the SAME `deps.search` call 'search' already uses, plus
 * comparisonService.ts's existing pure functions for the latter — no
 * new comparison/nutrition engine).
 *
 * Phase 5.0 gave 'meal_plan' a real implementation too — see
 * `dispatchMealPlan` below. Still no AI: it's a thin adapter over
 * mealPlanService.ts's deterministic, curated-template generator, and it
 * never mutates the cart on its own, matching every other intent in this
 * file.
 *
 * Phase 4.3 — `add_to_cart`/`remove_from_cart` now have a REAL
 * implementation, but still never mutate the cart from free text alone.
 * A free-text product name (e.g. "milk" from "add milk to cart") is NOT
 * a verified product — multiple real search matches can exist for the
 * same name (different brands, sizes, stores), and nothing about the
 * text itself specifies which one to act on. So `dispatchAddToCart`/
 * `dispatchRemoveFromCart` never read `intent.parameters.productId` —
 * that field is never trusted, whether it came from the deterministic
 * router (which never sets it) or an LLM classifier (which must never be
 * allowed to originate one — see
 * docs/assistant_ai_integration_review.md §2). The ONLY source of truth
 * for "the shopper confirmed this exact real product" is
 * productSelectionStore.ts's confirmation slot, populated exclusively by
 * a real, separate confirmation turn (see assistantService.ts's
 * `parseConfirmationResponse`) — never this dispatcher inventing a
 * selection policy (cheapest? first? most relevant?) on its own. See
 * productResolutionService.ts for the real search/cart-contents lookup
 * this is built on.
 *
 * `set_budget_target` remains unimplemented: turning a free-text number
 * into a real, persisted budget change needs the same kind of
 * deliberate confirmation review before this boundary touches account
 * state — that review hasn't happened yet.
 */

export interface DispatcherDependencies {
  search: (query: string, zipcode: string) => Promise<SearchResponse>;
  /** `budgetTarget` (Phase 5.1) is optional and additive — `dispatchOptimizeCart`
   * (unchanged) never passes it; `dispatchStartShoppingSession` does, when
   * the active session has one. Passing it only adds `budgetAnalysis`
   * decoration to each already-ranked candidate (see
   * backend/src/services/shoppingPlanOptimizer.ts's `withBudgetAnalysis`)
   * — it never changes which candidates are computed or how they're
   * ranked. */
  optimizeCart: (items: PlannerListItem[], zipcode: string, budgetTarget?: number) => Promise<ShoppingPlanResponse>;
  getZipcode: () => string;
  getCartItems: () => CartItem[];
  addToCart: (product: ApiProduct) => Promise<void>;
  /** `quantity` omitted removes the whole cart line — same default as
   * always. See `dispatchRemoveFromCart`'s own comment for where a real
   * count comes from. */
  removeFromCart: (productId: string, quantity?: number) => Promise<void>;
  /** Phase 5.0 — the real, deterministic meal-plan generator (see
   * mealPlanService.ts / backend/src/services/mealPlanService.ts). Never
   * called with a guessed mealCount — see `dispatchMealPlan`. */
  generateMealPlan: (request: MealPlanGenerationRequest) => Promise<MealPlanGenerationResult>;
  /** Phase 5.0 — real, on-device pantry signal only (see
   * inventoryEstimationService.ts's `estimateAllInventory`) — never a
   * guess. Returns display names of items this shopper's own purchase
   * history suggests are likely low, most-likely-low first. Empty for a
   * signed-out shopper or one with no purchase history, never an error. */
  getLowStockItems: () => Promise<string[]>;
  /** Phase 5.1 — the signed-in shopper's real account email, used ONLY as
   * the local-storage key for `assistantShoppingSessionStore.ts` (see
   * `dispatchStartShoppingSession`) — never sent anywhere, never used to
   * infer anything about the shopper. Empty string for a signed-out
   * shopper, matching every other account-scoped feature's degradation. */
  getOwnerEmail: () => string;
}

// A follow-up "which items are you low on" question isn't part of this
// flow — capped so the advisory note stays short and specific rather than
// listing everything the estimator has an opinion about.
const MAX_PANTRY_ADVISORY_ITEMS = 3;

const defaultDependencies: DispatcherDependencies = {
  search: (query, zipcode) => searchRepository.search(query, zipcode),
  optimizeCart: (items, zipcode, budgetTarget) => generateShoppingPlan(items, zipcode, budgetTarget),
  getZipcode: () => useUserStore.getState().user?.zipcode ?? '',
  getCartItems: () => useCartStore.getState().items,
  addToCart: (product) => useCartStore.getState().addToCart(product),
  removeFromCart: (productId, quantity) => useCartStore.getState().remove(productId, quantity),
  generateMealPlan: (request) => requestMealPlan(request),
  getLowStockItems: async () => {
    const ownerEmail = useUserStore.getState().user?.email;
    if (!ownerEmail) return [];
    return getLikelyLowStockDisplayNames(ownerEmail, MAX_PANTRY_ADVISORY_ITEMS);
  },
  getOwnerEmail: () => useUserStore.getState().user?.email ?? '',
};

function notImplemented(intent: Intent): AssistantActionResult {
  return {
    success: false,
    intent,
    error: `"${intent.type}" is not implemented yet — Assistant Boundary Foundation only (see src/models/intent.ts).`,
  };
}

function getQueryParameter(intent: Intent): string | undefined {
  return typeof intent.parameters.query === 'string' ? intent.parameters.query : undefined;
}

async function dispatchSearch(intent: Intent, deps: DispatcherDependencies): Promise<AssistantActionResult> {
  const query = getQueryParameter(intent);
  if (!query) return { success: false, intent, error: 'No search query could be resolved from this request.' };

  const zipcode = deps.getZipcode();
  if (!zipcode) return { success: false, intent, error: 'No ZIP code set for this account yet.' };

  const data = await deps.search(query, zipcode);
  return { success: true, intent, data };
}

async function dispatchOptimizeCart(intent: Intent, deps: DispatcherDependencies): Promise<AssistantActionResult> {
  const cartItems = deps.getCartItems();
  if (cartItems.length === 0) return { success: false, intent, error: 'Your cart is empty — nothing to optimize.' };

  const zipcode = deps.getZipcode();
  if (!zipcode) return { success: false, intent, error: 'No ZIP code set for this account yet.' };

  // Same conversion AutoOptimizeSheet.tsx's handleAutoOptimize already
  // does for the exact same "optimize what's currently in the cart" case
  // — reused here rather than a second, parallel definition.
  const plannerItems: PlannerListItem[] = cartItems.map((i) => ({ id: i.product.id, rawText: i.product.name }));
  const data = await deps.optimizeCart(plannerItems, zipcode);
  return { success: true, intent, data };
}

/** No navigation code here, deliberately (see this sprint's own "the
 * assistant should not directly manipulate screens" rule) — this only
 * ever returns an INSTRUCTION. Whatever future caller has a real
 * `navigation` object (a voice/chat entry point) is responsible for
 * acting on `action: 'open_planner'`. */
function dispatchOpenPlanner(intent: Intent): AssistantActionResult {
  const data: PlannerAction = { action: 'open_planner' };
  return { success: true, intent, data };
}

/** Reuses `deps.search` — the exact same call the 'search' intent
 * already makes — then reads whichever matched product already has
 * `.nutrition` set by the backend's own enrichment (see
 * backend/src/services/searchService.ts's enrichDirectMatchesWithNutrition).
 * No new lookup path, no estimate: a product with no `.nutrition` data
 * simply isn't a valid answer, and this returns `success: false` rather
 * than guessing. Prefers a real ('direct') match's nutrition data over a
 * merely related one, matching how 'search' itself already ranks
 * relevance. */
async function dispatchNutritionQuestion(intent: Intent, deps: DispatcherDependencies): Promise<AssistantActionResult> {
  const query = getQueryParameter(intent);
  if (!query) return { success: false, intent, error: 'No product could be resolved from this nutrition question.' };

  const zipcode = deps.getZipcode();
  if (!zipcode) return { success: false, intent, error: 'No ZIP code set for this account yet.' };

  const searchResponse = await deps.search(query, zipcode);
  const withNutrition = searchResponse.products.filter((p): p is ApiProduct & { nutrition: NonNullable<ApiProduct['nutrition']> } => p.nutrition != null);
  const match = withNutrition.find((p) => p.matchType !== 'related') ?? withNutrition[0];

  if (!match) {
    return { success: false, intent, error: `No verified nutrition data found for "${query}".` };
  }

  const data: NutritionResult = { action: 'nutrition_result', productName: match.name, nutrition: match.nutrition };
  return { success: true, intent, data };
}

/** A thin adapter, not a new comparison engine: reuses `deps.search` for
 * real product data, then comparisonService.ts's own existing pure
 * functions — `enrichProducts` (unit-price/distance enrichment) and
 * `getBestValueSummary` (best-value ranking + real savings math) — to
 * produce the exact same "Best Value" verdict the Compare screen itself
 * shows. `userCoords` is passed as `null` (no location context reaches
 * the dispatcher today) — `enrichProducts` already degrades gracefully
 * for that, same as every other optional-context case in this app. */
async function dispatchCompareOptions(intent: Intent, deps: DispatcherDependencies): Promise<AssistantActionResult> {
  const query = getQueryParameter(intent);
  if (!query) return { success: false, intent, error: 'No product could be resolved to compare.' };

  const zipcode = deps.getZipcode();
  if (!zipcode) return { success: false, intent, error: 'No ZIP code set for this account yet.' };

  const searchResponse = await deps.search(query, zipcode);
  if (searchResponse.products.length === 0) {
    return { success: false, intent, error: `No products found for "${query}" to compare.` };
  }

  const listings = enrichProducts(searchResponse.products, null);
  const summary = getBestValueSummary(listings);
  if (!summary) {
    return { success: false, intent, error: `Not enough data to compare "${query}" across stores.` };
  }

  const data: ComparisonResult = { action: 'comparison_result', query, best: summary.best, savings: summary.savings };
  return { success: true, intent, data };
}

function getMealCountParameter(intent: Intent): number | undefined {
  const raw = intent.parameters.mealCount;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

function getMealTypeParameter(intent: Intent): MealType {
  // Defaults to 'dinner' when unspecified — a reviewed, documented default
  // for an OPTIONAL field, not a silent inference of a fact nobody stated.
  // This is distinct from `mealCount`, which is REQUIRED and always asked
  // for explicitly when missing (see below) — see this sprint's own "never
  // infer missing facts silently" rule, which applies to the conversation
  // merge step (assistantService.ts's `extractParameterValue`), not to a
  // domain-appropriate default for an optional parameter.
  return intent.parameters.mealType === 'breakfast' ? 'breakfast' : 'dinner';
}

/**
 * Meal Planner v1 (Phase 5.0 — Conversational Grocery Planner). Real,
 * deterministic, curated-template generation (see mealPlanService.ts) —
 * NOT a placeholder, but still bound by every rule this boundary already
 * enforces: no AI, no invented prices, and — critically — NO cart
 * mutation of any kind. This only ever returns a suggested meal list and
 * grocery items as DATA; a shopper reviews it and explicitly opts in
 * (e.g. "Open in Planner") before anything downstream happens — see
 * AssistantScreen.tsx, this data's only real consumer today.
 *
 * `mealCount` is the one REQUIRED parameter. When it's missing, this
 * creates a real `PendingConversation` (see assistantConversationStore.ts)
 * and asks for it — a genuine follow-up question, not a generic
 * clarification: the shopper's answer gets deterministically MERGED into
 * this same intent's parameters (see assistantService.ts's
 * conversation-merge step), never re-classified from scratch and never
 * defaulted to a guessed count.
 *
 * Pantry integration (Phase 5.0 Part 4) is advisory only: real low-stock
 * signal (see `deps.getLowStockItems`, backed by
 * inventoryEstimationService.ts's existing, unmodified estimator) is
 * passed to the generator, which folds any genuinely-missing item into
 * the grocery list and names it explicitly in `pantryAdditions` — never a
 * silent addition, and never a cart mutation.
 */
async function dispatchMealPlan(intent: Intent, deps: DispatcherDependencies): Promise<AssistantActionResult> {
  const mealCount = getMealCountParameter(intent);

  if (mealCount == null) {
    const question = 'How many meals should I plan for?';
    createPendingConversation({
      pendingIntent: intent,
      pendingQuestion: question,
      collectedParameters: intent.parameters,
      missingField: 'mealCount',
    });
    return {
      success: false,
      intent,
      clarification: { type: 'clarification', message: question, originalIntent: intent },
      pendingType: 'conversation_required',
      missingField: 'mealCount',
    };
  }

  const mealType = getMealTypeParameter(intent);
  const lowStockItems = await deps.getLowStockItems();
  const plan = await deps.generateMealPlan({ mealCount, mealType, lowStockItems });

  const data: MealPlanResult = {
    action: 'meal_plan_result',
    meals: plan.meals,
    groceryItems: plan.groceryItems,
    pantryAdditions: plan.pantryAdditions,
  };
  return { success: true, intent, data };
}

// ─── start_shopping_session (Phase 5.1) ────────────────────────────────────
// Deterministic mappings ONLY — never an LLM, never a guess. Matches
// exactly the fixed set of choices the assistant itself offers in its own
// questions (see the pendingQuestion text below), so a shopper answering
// in the actual words the question suggested always resolves correctly.

const GOAL_KEYWORDS: { goal: ShoppingGoal; keywords: string[] }[] = [
  { goal: 'save_money', keywords: ['save money', 'cheaper', 'cheapest', 'budget'] },
  { goal: 'meal_plan', keywords: ['meal', 'dinner', 'recipe'] },
  { goal: 'restock', keywords: ['restock', 'running low', 'low on', 'pantry'] },
  { goal: 'compare_prices', keywords: ['compare', 'price'] },
  // "fastest trip" / "healthiest options" (this sprint's own worked
  // example) don't correspond to their own ShoppingGoal — they're an
  // OPTIMIZATION preference, not a goal (see PlanCandidateId) — captured
  // as `constraints`-adjacent free text via `optimizeFor` instead, both
  // resolving to the neutral 'general_shopping' goal.
  { goal: 'general_shopping', keywords: ['fastest', 'quick', 'healthiest', 'health', 'general', 'something else'] },
];

/** Maps a shopper's own free-text answer to one of the fixed, closed
 * `ShoppingGoal` values — returns `undefined` (never a guessed default)
 * when the answer doesn't recognizably match any of them, so the
 * dispatcher asks again rather than assuming. */
export function parseShoppingGoal(text: string): ShoppingGoal | undefined {
  const lower = text.toLowerCase();
  for (const { goal, keywords } of GOAL_KEYWORDS) {
    if (keywords.some((k) => lower.includes(k))) return goal;
  }
  return undefined;
}

function getSessionField<T>(intent: Intent, field: string): T | undefined {
  return intent.parameters[field] as T | undefined;
}

const VALID_GOALS: ReadonlySet<string> = new Set<ShoppingGoal>(['save_money', 'meal_plan', 'restock', 'compare_prices', 'general_shopping']);

/** `intent.parameters.goal`, by the time this dispatcher sees it, has
 * ALREADY been converted from free text to one of the closed
 * `ShoppingGoal` values — see assistantService.ts's `extractParameterValue`,
 * which calls `parseShoppingGoal` during the conversation-merge step, the
 * ONLY place free text is ever interpreted. This is just a final,
 * defensive type-narrowing check — never a second parsing pass. */
function isShoppingGoal(value: unknown): value is ShoppingGoal {
  return typeof value === 'string' && VALID_GOALS.has(value);
}

/**
 * Conversational Shopping Intelligence Foundation (Phase 5.1). A guided,
 * multi-turn flow — reusing EXACTLY the same conversation-merge machinery
 * Phase 5.0 built for `meal_plan` (see assistantConversationStore.ts and
 * assistantService.ts's conversation-merge step): each call checks which
 * required field is still missing from `intent.parameters` and, if one
 * is, creates a real `PendingConversation` asking for it — never guessing
 * `goal`/whether the shopper has a list/the list itself (see this
 * sprint's own "never infer — ask instead" rule). Because a merged
 * follow-up re-enters through `dispatchIntent` with the SAME intent type
 * and accumulated parameters, this function naturally resumes at
 * whichever field is still missing, without any additional state machine.
 *
 * Only once `goal`+`items` are both present does this: (1) persist a
 * real, COMPLETE `AssistantShoppingSession` (see
 * assistantShoppingSessionStore.ts — never a partial/speculative one),
 * (2) call `deps.optimizeCart` — the EXACT SAME function/optimizer
 * `optimize_cart` already uses, never a second optimization engine — and
 * (3) explain the real result via assistantExplanationService.ts. It
 * never mutates the cart, never calls `deps.addToCart`, and the shopper
 * still has to explicitly open the result in the Planner (see
 * AssistantScreen.tsx) before anything is ever added anywhere.
 */
async function dispatchStartShoppingSession(intent: Intent, deps: DispatcherDependencies): Promise<AssistantActionResult> {
  const ownerEmail = deps.getOwnerEmail();

  // Phase 5.3 Part 5 — "Show my previous shopping sessions" / "How did my
  // shopping improve?" (see intentRouterService.ts's `showHistory`
  // extraction). Checked before anything else needs a goal at all: this
  // is a pure, read-only history lookup, never a session-starting flow.
  if (getSessionField<boolean>(intent, 'showHistory')) {
    const sessions = await getSessionHistory(ownerEmail);
    const data: ShoppingHistoryResult = { action: 'shopping_history_result', sessions };
    return { success: true, intent, data };
  }

  // Phase 5.2 Part 4 — a REMEMBERED preference is still a real, explicit
  // statement (from an earlier turn/session), never a new inference; it
  // only ever fills in when THIS turn stated nothing itself. Fetched
  // once here and reused throughout this function. See
  // shopperPreferenceService.ts.
  const preferences = await getPreferences(ownerEmail);

  const goalAnswer = getSessionField<string>(intent, 'goal');
  let validGoal = isShoppingGoal(goalAnswer) ? goalAnswer : undefined;

  // Phase 5.3 Part 2 — a real, previously-stored optimizationPreference
  // can supply a default GOAL too, skipping the question entirely rather
  // than re-asking something this shopper already told this app once.
  // Only ever a DEFAULT: an explicit statement THIS turn (checked above)
  // always wins, and this never touches the optimizer's own ranking —
  // it only decides which QUESTION gets asked.
  if (!validGoal && preferences.optimizationPreference) {
    validGoal = preferences.optimizationPreference === 'cheapest' ? 'save_money' : 'general_shopping';
  }

  if (!validGoal) {
    const question = 'What are you trying to optimize? (save money, fastest trip, healthiest options, or something else)';
    createPendingConversation({ pendingIntent: intent, pendingQuestion: question, collectedParameters: intent.parameters, missingField: 'goal' });
    return {
      success: false, intent,
      clarification: { type: 'clarification', message: question, originalIntent: intent },
      pendingType: 'conversation_required', missingField: 'goal',
    };
  }

  const hasList = getSessionField<boolean>(intent, 'hasList');

  // Phase 5.2 Part 3 — "What should I buy?" / a 'restock' goal answer,
  // reached before the list question, gets a real, data-backed answer
  // instead of being asked for a list at all. Suggestions only: this
  // returns success:true with DATA and stops — it never creates a
  // session, never calls the optimizer, and never adds anything anywhere
  // on its own (see assistantSuggestionService.ts's own header comment
  // and AssistantScreen.tsx's "Add to list" action, the only thing that
  // can act on this data, and only into the Planner's text box).
  if (validGoal === 'restock' && hasList == null) {
    const suggestions = await getShoppingSuggestions(deps.getOwnerEmail(), { search: deps.search, getZipcode: deps.getZipcode });
    if (suggestions.length > 0) {
      const data: RestockSuggestionsResult = { action: 'restock_suggestions', suggestions };
      return { success: true, intent, data };
    }
    // No real signal to suggest from (e.g. no purchase history yet) —
    // fall through honestly to the normal list question below rather
    // than claiming to have suggestions.
  }

  if (hasList == null) {
    const question = 'Do you already have a grocery list?';
    createPendingConversation({
      pendingIntent: intent, pendingQuestion: question,
      collectedParameters: { ...intent.parameters, goal: validGoal }, missingField: 'hasList',
    });
    return {
      success: false, intent,
      clarification: { type: 'clarification', message: question, originalIntent: intent },
      pendingType: 'conversation_required', missingField: 'hasList',
    };
  }

  const itemsText = getSessionField<string>(intent, 'items');
  if (!itemsText) {
    const question = hasList
      ? 'Go ahead and enter your items — one per line, or separated by commas.'
      : "No problem — tell me what you'd like to shop for, one item per line or separated by commas.";
    createPendingConversation({
      pendingIntent: intent, pendingQuestion: question,
      collectedParameters: { ...intent.parameters, goal: validGoal, hasList }, missingField: 'items',
    });
    return {
      success: false, intent,
      clarification: { type: 'clarification', message: question, originalIntent: intent },
      pendingType: 'conversation_required', missingField: 'items',
    };
  }

  const zipcode = deps.getZipcode();
  if (!zipcode) return { success: false, intent, error: 'No ZIP code set for this account yet.' };

  const rawItems = parseListInput(itemsText);
  if (rawItems.length === 0) return { success: false, intent, error: 'No items could be read from that list.' };
  const items: PlannerListItem[] = rawItems.map((rawText, i) => ({ id: `session-item-${i}`, rawText }));

  // A real, explicit budgetTarget only — see intentRouterService.ts's
  // start_shopping_session extraction. Never guessed here.
  const budgetTargetRaw = intent.parameters.budgetTarget;
  const statedBudgetTarget = typeof budgetTargetRaw === 'number' && Number.isFinite(budgetTargetRaw) && budgetTargetRaw > 0 ? budgetTargetRaw : undefined;

  const effectiveBudgetTarget = statedBudgetTarget ?? preferences.defaultBudgetTarget;
  const preferencesUsed = preferences.preferredStores?.length || preferences.optimizationPreference
    ? { stores: preferences.preferredStores, optimizationPreference: preferences.optimizationPreference }
    : undefined;

  // The optimizer call itself is UNCHANGED from Phase 5.1 in shape and
  // ranking behavior — `effectiveBudgetTarget` only ever decorates each
  // already-ranked candidate with budgetAnalysis (see
  // shoppingPlanOptimizer.ts's withBudgetAnalysis), exactly like a
  // directly-stated budgetTarget already did. `preferencesUsed` is never
  // passed to the optimizer at all — it's explanation-only, applied below.
  const plan = await deps.optimizeCart(items, zipcode, effectiveBudgetTarget);
  const recommended = plan.candidates.find((c) => c.id === plan.recommendedId);

  // Phase 5.5 Part 3 — the "Magic Moment" comparison. Fetched BEFORE
  // `createSession` below persists this new session, so `priorHistory`
  // can never include the very session being compared against it (see
  // shoppingHistoryInsightService.ts's own doc comment on this ordering
  // requirement).
  const priorHistory = await getSessionHistory(ownerEmail);

  const session = await createSession(ownerEmail, {
    goal: validGoal,
    items,
    constraints: effectiveBudgetTarget != null ? { budgetTarget: effectiveBudgetTarget } : {},
    preferencesUsed,
    // Phase 5.3 Part 5 — the REAL recommended candidate's own numbers,
    // captured once at completion time (see assistantShoppingSessionStore.ts's
    // own doc comment on why history is never recomputed later).
    estimatedSavings: recommended?.estimatedSavings,
    storesUsed: recommended?.storeAssignments.map((a) => a.store),
  });

  let explanation = explainShoppingOptions(recommended ? [recommended, ...plan.candidates.filter((c) => c !== recommended)] : plan.candidates);
  const preferenceNote = explainPreferenceMatch(recommended, preferencesUsed);
  if (preferenceNote) explanation = `${explanation}\n${preferenceNote}`;

  // Phase 5.3 Part 1 — a structured, evidence-carrying explanation of the
  // SAME recommended candidate, never a second/different selection.
  const recommendationExplanation = recommended ? explainRecommendation(recommended, preferencesUsed) : undefined;

  const historyComparison = compareSessionToHistory(recommended?.estimatedSavings, priorHistory);

  const data: ShoppingSessionPlanResult = {
    action: 'shopping_session_plan',
    sessionId: session.id,
    goal: validGoal,
    items,
    plan,
    explanation,
    ...(recommendationExplanation && Object.keys(recommendationExplanation).length > 0 ? { recommendationExplanation } : {}),
    ...(historyComparison ? { historyComparison } : {}),
  };
  return { success: true, intent, data };
}

/**
 * Preference Memory (Phase 5.2 Parts 1–2). Only ever writes to the LOCAL
 * `ShopperPreferences` record — never the cart, never account state (see
 * shopperPreferenceService.ts). `field`/`value` are re-validated against
 * a closed allowlist inside `applyPreferenceUpdate` itself, independent
 * of the router's own extraction — this function never trusts
 * `intent.parameters` blindly. No pending state is ever created here: a
 * preference statement either resolves in one turn or fails honestly.
 */
async function dispatchUpdatePreferences(intent: Intent, deps: DispatcherDependencies): Promise<AssistantActionResult> {
  const field = typeof intent.parameters.field === 'string' ? intent.parameters.field : undefined;
  const value = intent.parameters.value;

  if (!field || value == null || (typeof value !== 'string' && typeof value !== 'number')) {
    return {
      success: false, intent,
      error: 'I\'m not sure what to remember — try "remember I prefer Aldi" or "I prefer healthier options."',
    };
  }

  const result = await applyPreferenceUpdate(deps.getOwnerEmail(), field, value);
  if (!result.ok) return { success: false, intent, error: result.error };

  const data: PreferenceUpdateResult = { action: 'preference_update_result', field: field as PreferenceUpdateResult['field'], value, preferences: result.preferences };
  return { success: true, intent, data };
}

/**
 * set_budget_target (Phase 5.2) — finally a real implementation, but a
 * deliberately narrow one: this writes ONLY to the LOCAL
 * `ShopperPreferences.defaultBudgetTarget` (see
 * shopperPreferenceService.ts), never to the signed-in account's own
 * persisted `weeklyBudget` (see useUserStore.ts) — that remains exactly
 * as deferred as it always was, since mutating REAL account state still
 * needs its own dedicated confirmation review this sprint does not do.
 * "Set my grocery budget to $150" is honestly a preference statement,
 * not an account-settings change.
 */
async function dispatchSetBudgetTarget(intent: Intent, deps: DispatcherDependencies): Promise<AssistantActionResult> {
  const amountRaw = intent.parameters.amount;
  const amount = typeof amountRaw === 'number' && Number.isFinite(amountRaw) && amountRaw > 0 ? amountRaw : undefined;

  // Phase 5.3 Part 4 — a real, merge-capable follow-up question, exactly
  // like meal_plan's own `mealCount` question (see
  // assistantConversationStore.ts). A bare "under $100" reply only ever
  // fills in `amount` for THIS pending question — see
  // assistantService.ts's `extractParameterValue`'s `'amount'` case,
  // which is scoped to a single number and touches nothing else, no
  // matter what else the reply also says (see that function's own
  // "unrelated fields are ignored" test).
  if (amount == null) {
    const question = 'What would you like to set your budget to?';
    createPendingConversation({ pendingIntent: intent, pendingQuestion: question, collectedParameters: intent.parameters, missingField: 'amount' });
    return {
      success: false, intent,
      clarification: { type: 'clarification', message: question, originalIntent: intent },
      pendingType: 'conversation_required', missingField: 'amount',
    };
  }

  const result = await applyPreferenceUpdate(deps.getOwnerEmail(), 'defaultBudgetTarget', amount);
  if (!result.ok) return { success: false, intent, error: result.error };

  const data: PreferenceUpdateResult = { action: 'preference_update_result', field: 'defaultBudgetTarget', value: amount, preferences: result.preferences };
  return { success: true, intent, data };
}

/**
 * NEVER reads `intent.parameters.productId` — see this file's header
 * comment. The only way this function ever calls `deps.addToCart` is if
 * `productSelectionStore.getPendingCartMutationConfirmation()` already
 * holds a real, previously-resolved product for `'add_to_cart'` — set
 * exclusively by a real, separate confirmation turn (see
 * assistantService.ts). Otherwise this only ever resolves real
 * candidates via `resolveProductRequest` and asks for a selection or a
 * confirmation — it never mutates the cart on this call.
 */
async function dispatchAddToCart(intent: Intent, deps: DispatcherDependencies): Promise<AssistantActionResult> {
  const confirmation = getPendingCartMutationConfirmation();
  if (confirmation?.action === 'add_to_cart') {
    clearPendingCartMutationConfirmation();
    await deps.addToCart(confirmation.product);
    const data: CartMutationResult = { action: 'added_to_cart', product: confirmation.product };
    return { success: true, intent, data };
  }

  const item = typeof intent.parameters.item === 'string' ? intent.parameters.item : undefined;
  if (!item) return { success: false, intent, error: 'No product could be resolved from this request.' };

  const zipcode = deps.getZipcode();
  if (!zipcode) return { success: false, intent, error: 'No ZIP code set for this account yet.' };

  const resolution = await resolveProductRequest(item, { search: deps.search, getZipcode: deps.getZipcode });

  if (resolution.status === 'not_found') {
    return { success: false, intent, error: `No products found for "${item}".` };
  }

  if (resolution.status === 'needs_selection') {
    createPendingProductSelection({ originalIntent: intent, query: item, candidates: resolution.candidates });
    const data: ProductSelectionResult = { action: 'product_selection_required', query: item, candidates: resolution.candidates };
    return { success: false, intent, data, pendingType: 'product_selection_required' };
  }

  // Exactly one real candidate — STILL requires explicit confirmation.
  // Never an automatic add, even with a single unambiguous match.
  createPendingCartMutationConfirmation({ action: 'add_to_cart', product: resolution.product, originalIntent: intent });
  const data: CartConfirmationResult = { action: 'confirmation_required', mutationAction: 'add_to_cart', product: resolution.product };
  return { success: false, intent, data, pendingType: 'confirmation_required' };
}

/** The same shape as `dispatchAddToCart`, but resolves against the
 * shopper's own current cart contents (via `resolveCartItemForRemoval`)
 * rather than a fresh search — see productResolutionService.ts.
 *
 * `intent.parameters.quantity` (e.g. "remove 2 bananas") is read here —
 * unlike `parameters.productId`, a bare count doesn't identify WHICH
 * product to act on, only how many of the already-resolved one, so it's
 * safe to trust from the deterministic router. It's still never trusted
 * blindly: clamped to the real quantity already in the cart before it's
 * ever shown back to the shopper for confirmation, so "remove 5" when
 * only 3 exist means "remove all 3," never an error and never a request
 * to remove more than is real. `undefined` (no count stated) keeps the
 * original behavior of removing the whole line. */
async function dispatchRemoveFromCart(intent: Intent, deps: DispatcherDependencies): Promise<AssistantActionResult> {
  const confirmation = getPendingCartMutationConfirmation();
  if (confirmation?.action === 'remove_from_cart') {
    clearPendingCartMutationConfirmation();
    await deps.removeFromCart(confirmation.product.id, confirmation.requestedQuantity);
    const data: CartMutationResult = {
      action: 'removed_from_cart', product: confirmation.product, requestedQuantity: confirmation.requestedQuantity,
    };
    return { success: true, intent, data };
  }

  const item = typeof intent.parameters.item === 'string' ? intent.parameters.item : undefined;
  if (!item) return { success: false, intent, error: 'No item could be resolved from this request.' };

  const cartItems = deps.getCartItems();
  const resolution = resolveCartItemForRemoval(item, cartItems);

  if (resolution.status === 'not_found') {
    return { success: false, intent, error: `Nothing matching "${item}" was found in your cart.` };
  }

  if (resolution.status === 'needs_selection') {
    createPendingProductSelection({ originalIntent: intent, query: item, candidates: resolution.candidates });
    const data: ProductSelectionResult = { action: 'product_selection_required', query: item, candidates: resolution.candidates };
    return { success: false, intent, data, pendingType: 'product_selection_required' };
  }

  const requestedQuantityRaw = typeof intent.parameters.quantity === 'number' ? intent.parameters.quantity : undefined;
  const actualQuantity = cartItems.find((i) => i.product.id === resolution.product.id)?.quantity;
  const requestedQuantity =
    requestedQuantityRaw != null && requestedQuantityRaw > 0 && actualQuantity != null
      ? Math.min(requestedQuantityRaw, actualQuantity)
      : undefined;

  createPendingCartMutationConfirmation({
    action: 'remove_from_cart', product: resolution.product, originalIntent: intent, requestedQuantity,
  });
  const data: CartConfirmationResult = {
    action: 'confirmation_required', mutationAction: 'remove_from_cart', product: resolution.product, requestedQuantity,
  };
  return { success: false, intent, data, pendingType: 'confirmation_required' };
}

/**
 * Executes one resolved `Intent` and returns the real, verified outcome.
 * `context` defaults to an empty session (no cart, no active query) —
 * the same "degrade to the strictest, safest reading" rule every other
 * optional-context parameter in this app already follows. `deps`
 * defaults to the app's real services/stores; tests substitute fakes
 * here rather than mocking Zustand/AsyncStorage/network (same
 * dependency-injection convention this codebase already uses for
 * nutrition enrichment — see backend's searchService.ts).
 *
 * Two gates run BEFORE any service call, in order:
 *  1. `evaluateIntent` — confidence policy (see intentPolicy.ts). Blocked
 *     → returns `success: false` with a `clarification`.
 *  2. `validateSessionContext` — does the app actually have the context
 *     this intent needs (e.g. a non-empty cart for optimize_cart)?
 *     Blocked → also returns `success: false` with a `clarification`.
 * Only past both does execution reach the switch below. Never throws:
 * any error from an underlying service call is caught and reported as
 * `success: false`, never left to crash the caller.
 */
export async function dispatchIntent(
  intent: Intent,
  context: AssistantSessionContext = {},
  deps: DispatcherDependencies = defaultDependencies,
): Promise<AssistantActionResult> {
  const decision = evaluateIntent(intent);
  if (!decision.allowed) {
    return { success: false, intent, error: decision.reason, clarification: buildClarification(intent) };
  }

  if (!validateSessionContext(intent, context)) {
    return {
      success: false,
      intent,
      error: `Missing the context needed to safely execute "${intent.type}".`,
      clarification: buildClarification(intent),
    };
  }

  try {
    switch (intent.type) {
      case 'search':
        return await dispatchSearch(intent, deps);
      case 'optimize_cart':
        return await dispatchOptimizeCart(intent, deps);
      case 'open_planner':
        return dispatchOpenPlanner(intent);
      case 'nutrition_question':
        return await dispatchNutritionQuestion(intent, deps);
      case 'compare_options':
        return await dispatchCompareOptions(intent, deps);
      case 'meal_plan':
        return await dispatchMealPlan(intent, deps);
      case 'start_shopping_session':
        return await dispatchStartShoppingSession(intent, deps);
      case 'update_preferences':
        return await dispatchUpdatePreferences(intent, deps);
      case 'add_to_cart':
        return await dispatchAddToCart(intent, deps);
      case 'remove_from_cart':
        return await dispatchRemoveFromCart(intent, deps);
      case 'unknown':
        // Deliberately executes nothing at all, not even a lookup — an
        // unresolved intent has no verified action to take.
        return { success: false, intent, error: 'Could not understand this request.' };
      case 'set_budget_target':
        return await dispatchSetBudgetTarget(intent, deps);
      default: {
        // Exhaustiveness guard: a new IntentType added without a case
        // here fails to compile, rather than silently falling through.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const _exhaustive: never = intent.type;
        return notImplemented(intent);
      }
    }
  } catch (err) {
    return { success: false, intent, error: err instanceof Error ? err.message : String(err) };
  }
}
