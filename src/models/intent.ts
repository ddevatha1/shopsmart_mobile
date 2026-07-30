import type { EnrichedListing } from '../services/comparisonService';
import type { RecommendationExplanation } from '../services/recommendationExplanationService';
import type { SessionSavingsComparison } from '../services/shoppingHistoryInsightService';
import type {
  ApiProduct, AssistantSuggestion, MealPlanMeal, NutritionAttributes, PlannerListItem, ShopperPreferences, SearchResponse,
  ShoppingPlanResponse,
} from './types';

/**
 * The Intent Contract — the one shape every future voice/text/LLM input
 * must resolve to before this app executes anything (see
 * docs/CartIQ_ai_implementation_roadmap.md's Phase 0). Nothing in this
 * app imports this yet, deliberately: this is a contract-first change,
 * proving the boundary compiles with zero AI involved before any future
 * feature spends a single LLM call against it.
 *
 * Closed vocabulary by design: `IntentType` is NOT an open string.
 * Whatever eventually classifies free-form input (a voice transcript,
 * typed text) must select from this fixed, enumerated set — it can never
 * invent a new action name, and this app must never execute an intent
 * type it doesn't already have real, hand-written logic for. Adding a
 * new capability means adding a new union member here FIRST, on purpose
 * — never letting a model's raw output silently define new app behavior.
 */
export type IntentType =
  | 'search'
  | 'add_to_cart'
  | 'remove_from_cart'
  | 'compare_options'
  | 'optimize_cart'
  | 'open_planner'
  | 'set_budget_target'
  | 'meal_plan'
  | 'nutrition_question'
  | 'start_shopping_session'
  | 'update_preferences'
  | 'unknown';

/**
 * `confidence` is a plain 0–1 number, not tied to any particular
 * classifier's internals — a future rule-based matcher and a future LLM
 * classifier both produce this exact same shape, so a confidence-
 * threshold/clarification policy can be written once against this
 * contract and never need to know which one produced a given `Intent`.
 *
 * `parameters` is deliberately a flat, scalar-only bag — no nested
 * objects or arrays. Every future intent handler can trust that any value
 * it reads is a plain string/number/boolean or simply absent, never a
 * structure it has to further validate or parse.
 */
export interface Intent {
  type: IntentType;
  confidence: number;
  parameters: Record<string, string | number | boolean | undefined>;
}

/**
 * The data contract for "I'm not confident/safe enough to act on this
 * yet — did you mean X?" (see intentPolicy.ts's `evaluateIntent`/
 * `buildClarification`). Deliberately just data: no UI component reads
 * this yet, on purpose — that's a separate, later change once there's an
 * actual entry point (voice/chat) for a shopper to respond to it. `type:
 * 'clarification'` is a discriminant so a future caller can distinguish
 * this from other possible future response shapes without inspecting
 * multiple optional fields.
 */
export interface ClarificationRequest {
  type: 'clarification';
  message: string;
  originalIntent: Intent;
}

/** search intent's data — the exact same shape /api/search already
 * returns, never reshaped. Named separately from `SearchResponse` only
 * so this file's other result types (which all need their own names
 * anyway) read consistently side by side. */
export type SearchResult = SearchResponse;

/** open_planner intent's data — a UI INSTRUCTION only, never a direct
 * screen manipulation (see assistantDispatcher.ts's `dispatchOpenPlanner`
 * and this sprint's "no navigation code inside the dispatcher" rule). A
 * future caller (voice/chat entry point) is responsible for actually
 * navigating; the dispatcher only ever says WHAT should happen. */
export interface PlannerAction {
  action: 'open_planner';
}

/** nutrition_question intent's data — `nutrition` is the exact,
 * unmodified `NutritionAttributes` already attached to the matched
 * product by /api/search (see backend/src/routes/productImage.ts's
 * extractNutrition) — real per-100g Open Food Facts fields, deliberately
 * NOT renamed/flattened/estimated. `productName` names which real
 * product this data came from, since bare nutrition figures with no
 * product reference would be ambiguous. */
export interface NutritionResult {
  action: 'nutrition_result';
  productName: string;
  nutrition: NutritionAttributes;
}

/** compare_options intent's data — the exact output of
 * comparisonService.ts's `getBestValueSummary` over real search results
 * for `query` (see assistantDispatcher.ts's `dispatchCompareOptions`),
 * wrapped with the query it's about and an action discriminant. `best`/
 * `savings` are untouched — comparisonService.ts's own real ranking/
 * savings logic, never reimplemented here (see this sprint's "do not
 * create a new comparison engine" rule). */
export interface ComparisonResult {
  action: 'comparison_result';
  query: string;
  best: EnrichedListing;
  savings: number | null;
}

/** add_to_cart/remove_from_cart intent data (Phase 4.3) — real search (or,
 * for removal, real cart-contents) candidates only, per
 * productResolutionService.ts. `candidates` is always a subset of what a
 * real service call actually returned — never invented, never a single
 * auto-picked "best" product (see this sprint's own "never select
 * automatically when multiple reasonable products exist" rule). */
export interface ProductSelectionResult {
  action: 'product_selection_required';
  query: string;
  candidates: ApiProduct[];
}

/** The "about to mutate — are you sure?" data — `product` is always
 * either a single real search/cart-resolved product (exactly one
 * candidate, no ambiguity) or the one candidate the shopper explicitly
 * picked from a `ProductSelectionResult`'s `candidates`. Never populated
 * from an intent's own `parameters.productId` — see
 * assistantDispatcher.ts's `dispatchAddToCart`/`dispatchRemoveFromCart`
 * header comments for why that field is never trusted. */
export interface CartConfirmationResult {
  action: 'confirmation_required';
  mutationAction: 'add_to_cart' | 'remove_from_cart';
  product: ApiProduct;
  /** `remove_from_cart` only — how many units the shopper asked to remove
   * (e.g. "remove 2 of the 3 bananas"), already clamped to the real
   * quantity in the cart by `dispatchRemoveFromCart`. `undefined` means
   * "remove the whole line," the same default this always had. Never set
   * for `add_to_cart`. */
  requestedQuantity?: number;
}

/** The real, verified outcome of an actual cart mutation — set ONLY
 * after a real `PendingCartMutationConfirmation` was found and consumed
 * (see productSelectionStore.ts) — this is the one and only path
 * `cartStore.addToCart`/`.remove` are ever called from this boundary. */
export interface CartMutationResult {
  action: 'added_to_cart' | 'removed_from_cart';
  product: ApiProduct;
  /** `removed_from_cart` only — same meaning as `CartConfirmationResult`'s
   * own field, carried through to the executed result so response
   * generation can say "Removed 2 of your 3 bananas" instead of always
   * implying the whole line was removed. */
  requestedQuantity?: number;
}

/** meal_plan intent data (Phase 5.0 — Conversational Grocery Planner v1).
 * `meals`/`groceryItems` are exactly whatever
 * backend/src/services/mealPlanService.ts's deterministic, curated-template
 * generator returned — never reshaped, never a fabricated recipe, never a
 * price (this domain service has no notion of price at all; see
 * assistantDispatcher.ts's `dispatchMealPlan`). `pantryAdditions` names
 * which real, on-device low-stock items (see inventoryEstimationService.ts)
 * were folded into `groceryItems` — advisory only, so a caller can say "I
 * noticed you're low on X and included it" rather than silently changing
 * the list. This never mutates the cart or the Smart Shopping Planner on
 * its own — a shopper reviews this output and explicitly opts in before
 * anything downstream happens (see AssistantScreen.tsx). */
export interface MealPlanResult {
  action: 'meal_plan_result';
  meals: MealPlanMeal[];
  groceryItems: string[];
  pantryAdditions: string[];
}

// ── Conversational Shopping Intelligence Foundation (Phase 5.1) ────────────

/** The closed set of shopping goals a session can be started for — a
 * shopper's own stated answer to "what are you trying to optimize/do?"
 * (see assistantDispatcher.ts's `dispatchStartShoppingSession`), never
 * inferred from unrelated text. Closed by design, matching `IntentType`'s
 * own "never let free text silently define new app behavior" rule. */
export type ShoppingGoal = 'save_money' | 'meal_plan' | 'restock' | 'compare_prices' | 'general_shopping';

/** Every field here is set ONLY from an explicit, real user answer to a
 * real question — never guessed, never defaulted from account data, never
 * produced by an LLM (see docs/assistant_phase5_roadmap.md's Phase 5.1
 * safety review: "no guessed user preferences"). `storesPreference`/
 * `dietaryPreferences` exist in the shape now so a future phase has
 * somewhere real to put them once a real conversational flow collects
 * them — nothing sets them yet, matching this codebase's own "type
 * exists, nothing consumes it yet" convention. */
export interface AssistantShoppingSessionConstraints {
  budgetTarget?: number;
  storesPreference?: string[];
  dietaryPreferences?: string[];
  timeLimit?: number;
}

/** A completed, explicitly-confirmed shopping session — see
 * assistantShoppingSessionStore.ts. Deliberately only ever written ONCE,
 * after every required field (`goal`, `items`) has been explicitly
 * answered — never a partially-guessed draft. `preferences` exists for
 * future, still-undesigned personalization (see the Phase 5 roadmap's own
 * "Personal Grocery Memory" candidate, deliberately deferred) — nothing
 * writes to it yet. */
export interface AssistantShoppingSession {
  id: string;
  createdAt: number;
  goal: ShoppingGoal;
  items: PlannerListItem[];
  constraints: AssistantShoppingSessionConstraints;
  preferences: Record<string, string | number | boolean>;
  status: 'active' | 'completed' | 'abandoned';
  /** Phase 5.2 Part 4 — which REAL, already-stored `ShopperPreferences`
   * (see shopperPreferenceService.ts) were consulted when this session
   * was built. Purely informational/explanatory (see
   * assistantExplanationService.ts's `explainPreferenceMatch`) — the
   * optimizer itself receives no different inputs because of this; see
   * assistantDispatcher.ts's `dispatchStartShoppingSession` for exactly
   * where `deps.optimizeCart` is called, unchanged from Phase 5.1. */
  preferencesUsed?: {
    stores?: string[];
    optimizationPreference?: string;
  };
  /** Phase 5.3 Part 5 — the REAL recommended candidate's own savings/
   * store list at the moment this session's plan was generated, kept
   * so history views (see assistantShoppingSessionStore.ts's
   * `getSessionHistory`) never have to recompute or estimate anything
   * after the fact. */
  estimatedSavings?: number;
  storesUsed?: string[];
}

/** A lightweight, display-ready projection of a real, already-stored
 * `AssistantShoppingSession` (see assistantShoppingSessionStore.ts's
 * `getSessionHistory`, this type's only producer) — never a second
 * storage mechanism. */
export interface ShoppingSessionHistory {
  id: string;
  createdAt: number;
  goal: ShoppingGoal;
  itemCount: number;
  optimizationPreference?: string;
  estimatedSavings?: number;
  storesUsed?: string[];
}

/** start_shopping_session's real, terminal result — `plan` is exactly
 * whatever `deps.optimizeCart` (the SAME `generateShoppingPlan` call
 * `optimize_cart` already uses — see assistantDispatcher.ts) returned,
 * never reshaped or re-ranked. `explanation` is real, template-built text
 * over that same real data (see assistantExplanationService.ts) — never
 * an LLM summary. */
export interface ShoppingSessionPlanResult {
  action: 'shopping_session_plan';
  sessionId: string;
  goal: ShoppingGoal;
  /** The exact real items this session was built from — the same
   * `PlannerListItem[]` handed to `deps.optimizeCart` (see
   * assistantDispatcher.ts). Kept here directly (mirroring
   * `MealPlanResult.groceryItems`'s own "ready to prefill the Planner"
   * shape) rather than making a caller reverse-engineer them out of
   * `plan`'s per-store assignments. */
  items: PlannerListItem[];
  plan: ShoppingPlanResponse;
  explanation: string;
  /** Phase 5.3 Part 1 — a structured, evidence-carrying explanation of
   * `plan.recommendedId`'s own candidate (see
   * recommendationExplanationService.ts's `explainRecommendation`) —
   * absent whenever no real evidence backs any reason, never an empty
   * placeholder. Consumed by components/assistant/WhyThisPlanCard.tsx. */
  recommendationExplanation?: RecommendationExplanation;
  /** Phase 5.5 Part 3 — the "Magic Moment" comparison against this
   * shopper's own REAL prior sessions (see
   * shoppingHistoryInsightService.ts's `compareSessionToHistory`), computed
   * from history fetched BEFORE this session was persisted so the
   * comparison never includes itself. Absent whenever there's no real
   * prior data or no real current savings figure — a UI showing this
   * field is the only thing allowed to say "you improved," and only
   * because a real previous comparison exists. */
  historyComparison?: SessionSavingsComparison;
}

// ── Personalized Shopping Intelligence + Memory Foundation (Phase 5.2) ─────

/** update_preferences / set_budget_target's real result — `preferences`
 * is the REAL, freshly-saved `ShopperPreferences` record (see
 * shopperPreferenceService.ts's `applyPreferenceUpdate`), returned so a
 * caller can show exactly what's now remembered without a second read. */
export interface PreferenceUpdateResult {
  action: 'preference_update_result';
  field: 'preferredStores' | 'avoidedStores' | 'optimizationPreference' | 'defaultBudgetTarget';
  value: string | number;
  preferences: ShopperPreferences;
}

/** "What should I buy?" — real, data-backed suggestions only (see
 * assistantSuggestionService.ts, this shape's only producer).
 * Deliberately terminal: unlike `ShoppingSessionPlanResult`, this never
 * calls the optimizer or creates a session on its own — a shopper reviews
 * these and explicitly opts in (see AssistantScreen.tsx's "Add to list"),
 * exactly like `MealPlanResult`'s own "never automatic" contract. */
export interface RestockSuggestionsResult {
  action: 'restock_suggestions';
  suggestions: AssistantSuggestion[];
}

// ── Adaptive Shopping Intelligence + Explainable Recommendations (Phase 5.3) ─

/** "Show my previous shopping sessions" / "How did my shopping improve?"
 * (see assistantDispatcher.ts's `dispatchStartShoppingSession`) — real,
 * already-persisted history only (see
 * assistantShoppingSessionStore.ts's `getSessionHistory`). Read-only and
 * terminal, same contract as `RestockSuggestionsResult`: no editing, no
 * automatic reuse (see AssistantScreen.tsx's ShoppingHistoryCard). */
export interface ShoppingHistoryResult {
  action: 'shopping_history_result';
  sessions: ShoppingSessionHistory[];
}

/**
 * Every real shape `AssistantActionResult.data` can hold today.
 * `ShoppingPlanResponse` (optimize_cart) is real backend response data
 * returned completely untouched, unlike this file's other result types,
 * which wrap their data with an `action` discriminant — that asymmetry
 * is deliberate (see `AssistantActionResult`'s own doc comment: an
 * existing service's response is never reshaped). Only types actually
 * produced by assistantDispatcher.ts today — no speculative future
 * members added ahead of a real implementation.
 */
export type AssistantData =
  | SearchResult
  | ShoppingPlanResponse
  | PlannerAction
  | NutritionResult
  | ComparisonResult
  | ProductSelectionResult
  | CartConfirmationResult
  | CartMutationResult
  | MealPlanResult
  | ShoppingSessionPlanResult
  | PreferenceUpdateResult
  | RestockSuggestionsResult
  | ShoppingHistoryResult
  | undefined;

/**
 * What assistantDispatcher.ts (this file's other consumer) hands back
 * after acting on an `Intent` — always the REAL outcome of calling an
 * existing app service, never a fabricated one. `success: false` covers
 * three distinct cases: the underlying service call failed, this intent
 * type has no real implementation yet, or the intent was blocked before
 * ever reaching a service call (see intentPolicy.ts) — in every case,
 * nothing was verified to have happened, so a caller must never report
 * it as if it did. `data`, when present, is exactly whatever the real
 * service returned, untouched — the dispatcher never reshapes or
 * summarizes it. `clarification` is set ONLY when the intent was blocked
 * by policy (confidence too low, or required session context missing)
 * — never when it simply has no implementation yet (that's a different
 * kind of "no," with nothing to clarify).
 */
export interface AssistantActionResult {
  success: boolean;
  intent: Intent;
  data?: AssistantData;
  error?: string;
  clarification?: ClarificationRequest;
  /** Phase 4.3: set ONLY by `dispatchAddToCart`/`dispatchRemoveFromCart`
   * (see assistantDispatcher.ts) when a cart-mutation request needs a
   * follow-up beyond a generic clarification question — either picking a
   * specific product from real candidates, or confirming one specific
   * already-resolved product before anything is actually mutated.
   * assistantService.ts maps this directly onto `AssistantOutcome.type`;
   * `data` (see `ProductSelectionResult`/`CartConfirmationResult`) always
   * carries the real candidates/product this refers to.
   *
   * `'conversation_required'` (Phase 5.0) — set ONLY by `dispatchMealPlan`
   * when a required parameter (e.g. `mealCount`) is missing. Unlike a
   * plain clarification, a follow-up answer to THIS question gets
   * deterministically MERGED into the original intent's parameters
   * rather than starting over — see assistantConversationStore.ts and
   * assistantService.ts's conversation-merge step. `missingField` names
   * exactly which parameter the follow-up answer should fill.
   * assistantService.ts still maps this onto the same
   * `AssistantOutcome.type: 'clarification_required'` marker a caller
   * already knows how to render — no new UI branch required. */
  pendingType?: 'product_selection_required' | 'confirmation_required' | 'conversation_required';
  /** Set only alongside `pendingType: 'conversation_required'` — see
   * above. */
  missingField?: string;
}

/**
 * Whatever ambient app state a future intent resolver/dispatcher might
 * use to disambiguate input (e.g. "optimize it" implicitly meaning the
 * current cart) — deliberately thin, and deliberately NOT a
 * conversation log. No history, no prior turns, no stored transcripts:
 * every field here is a snapshot of right-now app state, re-read fresh
 * each time, never accumulated.
 */
export interface AssistantSessionContext {
  currentScreen?: string;
  cartSize?: number;
  activeQuery?: string;
}

/**
 * The closed set of reasons assistantService.ts's `runAssistant` (the
 * future entry point for voice/text/camera input) can fail to produce a
 * usable result — a caller (a future voice/chat UI) can build real,
 * differentiated messaging off this instead of parsing raw error text.
 *
 * - `network_error` — the backend intent-resolution call itself failed
 *   (see assistantRepository.ts) — no Intent was ever established.
 * - `unknown_intent` — the backend resolved a real Intent, but its own
 *   type is `'unknown'` (the router couldn't classify the input at all).
 * - `blocked_intent` — a real, classified Intent was resolved but
 *   intentPolicy.ts's `evaluateIntent`/`validateSessionContext` blocked
 *   it (low confidence, or missing required session context) — see
 *   `AssistantActionResult.clarification`, which is set in this case.
 * - `service_failure` — the intent passed policy, but the underlying
 *   service call failed, or that intent type has no real implementation
 *   yet (see assistantDispatcher.ts) — either way, nothing executed.
 */
export type AssistantError = 'network_error' | 'unknown_intent' | 'blocked_intent' | 'service_failure';

/**
 * `runAssistant`'s return shape — an `AssistantActionResult` with two
 * additional optional fields, so every existing consumer of
 * `AssistantActionResult` (e.g. assistantDispatcher.ts's own callers)
 * still works unchanged against it. `errorType` is set only alongside
 * `success: false`, classifying WHY per the `AssistantError` cases above
 * — this behavior is UNCHANGED by Phase 4.2's clarification layer.
 *
 * The one case with no real `Intent` to report — a `network_error`,
 * where the backend call itself never returned — still needs to satisfy
 * `intent: Intent`'s required field. That case always reuses the same
 * `{ type: 'unknown', confidence: 0, parameters: {} }` shape a genuine
 * router-level `'unknown'` classification already produces (see
 * assistantService.ts's `NETWORK_FAILURE_INTENT`) — never throw a raw
 * error to a caller instead. This is NOT the same thing as a real
 * `unknown_intent` classification: `errorType` is what actually
 * disambiguates the two (`'network_error'` vs. `'unknown_intent'`), not
 * the reused intent shape itself.
 *
 * `type: 'clarification_required'` (Phase 4.2) is a pure, derived
 * marker set whenever `clarification` is populated, REGARDLESS of which
 * layer produced it — clarificationPolicy.ts's new upstream check
 * (before dispatchIntent is ever called) or intentPolicy.ts's existing,
 * completely unchanged internal gates (evaluateIntent/
 * validateSessionContext, still enforced inside dispatchIntent as
 * before). A caller only needs to know THAT a clarification exists to
 * show one, not which of the two independent gates produced it.
 *
 * `type: 'product_selection_required'` / `'confirmation_required'`
 * (Phase 4.3) are the two new cart-action follow-up states — see
 * `AssistantActionResult.pendingType`, which this is copied from
 * verbatim by assistantService.ts. Distinct from
 * `'clarification_required'` on purpose: a clarification asks "what
 * information is missing," while these ask "which VERIFIED product did
 * you mean" / "are you sure about THIS specific product" — a caller
 * needs to render a genuinely different UI for each.
 */
export interface AssistantOutcome extends AssistantActionResult {
  errorType?: AssistantError;
  type?: 'clarification_required' | 'product_selection_required' | 'confirmation_required';
}

/**
 * One bounded, short-lived "we asked the user something, waiting for
 * their answer" slot (see clarificationStore.ts and
 * docs/assistant_ai_integration_review.md §5) — deliberately NOT a
 * conversation log, matching `AssistantSessionContext`'s own "no
 * history" rule. `intentCandidate` is the real, already-classified
 * `Intent` that triggered the question (e.g. `add_to_cart` with
 * `parameters.item: 'milk'`) — a future follow-up answer gets merged
 * against this, not re-classified from scratch in isolation.
 * `missingFields` names which of `intentCandidate.parameters` (or which
 * confidence/context requirement) is still unresolved, so a future UI
 * can target its follow-up precisely instead of asking a generic
 * "can you clarify?" every time.
 */
export interface PendingClarification {
  id: string;
  originalText: string;
  intentCandidate: Intent;
  missingFields: string[];
  question: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Phase 4.3 — separate from `PendingClarification` on purpose (see
 * productSelectionStore.ts): a clarification asks "what information is
 * missing"; this asks "which of these REAL, already-retrieved products
 * did you mean." `candidates` always come from a real service call
 * (search, for add_to_cart; the shopper's own current cart, for
 * remove_from_cart) — see productResolutionService.ts. `originalIntent`
 * is the real `add_to_cart`/`remove_from_cart` `Intent` that triggered
 * this, kept so a follow-up answer resolves against the SAME request
 * rather than being re-classified from scratch.
 */
export interface PendingProductSelection {
  id: string;
  originalIntent: Intent;
  query: string;
  candidates: ApiProduct[];
  createdAt: number;
  expiresAt: number;
}

/**
 * Phase 4.3 — the last gate before a real cart mutation. `product` is
 * always a single, already-verified `ApiProduct` (never built from
 * `parameters.productId`, an LLM-generated value, a guessed UPC, or a
 * guessed store id — see assistantDispatcher.ts's `dispatchAddToCart`/
 * `dispatchRemoveFromCart`). Only a real, separate, later confirmation
 * turn (see assistantService.ts's `parseConfirmationResponse`) causes
 * `cartStore.addToCart`/`.remove` to actually be called — never this
 * object's mere existence.
 */
export interface PendingCartMutationConfirmation {
  id: string;
  action: 'add_to_cart' | 'remove_from_cart';
  product: ApiProduct;
  originalIntent: Intent;
  createdAt: number;
  expiresAt: number;
  /** See `CartConfirmationResult`'s own field — same meaning, carried
   * through the pending-confirmation slot so the later confirmation turn
   * knows how many units to actually remove. */
  requestedQuantity?: number;
}

/**
 * Phase 5.0 — true multi-turn parameter collection (see
 * assistantConversationStore.ts and docs/assistant_phase5_roadmap.md §5).
 * Distinct from `PendingClarification` on purpose: a plain clarification
 * (Phase 4.2) has no mechanism for a follow-up answer to be merged back
 * in — nothing ever reads `getPendingClarification()` again after it's
 * created. This DOES get read back: a follow-up answer is deterministically
 * parsed for exactly `missingField` (see assistantService.ts's
 * `extractParameterValue` — never an LLM, never inferring any field beyond
 * the one named here) and merged into `collectedParameters`, then the
 * MERGED intent is re-dispatched through `dispatchIntent` — never bypassing
 * it. `pendingIntent` is the real, already-classified `Intent` that
 * triggered the question (e.g. `meal_plan` with `parameters.mealType:
 * 'dinner'`); `collectedParameters` starts as a copy of its own
 * `parameters` so nothing already known is lost when the missing field is
 * filled in.
 */
export interface AssistantConversationState {
  id: string;
  pendingIntent: Intent;
  pendingQuestion: string;
  collectedParameters: Record<string, string | number | boolean | undefined>;
  missingField: string;
  lastAssistantResponse: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Phase 4.4 — voice is only another input/output modality (see
 * voiceService.ts's own header comment): none of this changes how an
 * `Intent` gets resolved or dispatched. `'processing'` covers the window
 * between "recognition finished" and "the assistant pipeline/response
 * finished" — a real, observable state (not merely "listening" or
 * "speaking") a future UI would want to render distinctly (e.g. a
 * "thinking" spinner).
 */
export type VoiceStatus = 'idle' | 'listening' | 'processing' | 'speaking' | 'error';

/** A snapshot of one voice session's current state — see
 * voiceService.ts's `createVoiceSession`. `transcript`/`error` are only
 * ever populated when relevant to the current `status`; neither is a
 * running log (matching `AssistantSessionContext`'s own "no history"
 * rule) — each new turn's own state simply replaces the last. */
export interface VoiceSessionState {
  status: VoiceStatus;
  transcript?: string;
  error?: string;
}

/** The user-facing text an `AssistantOutcome` was converted into (see
 * assistantResponseService.ts's `formatAssistantResponse`) — deliberately
 * separate from `AssistantOutcome` itself, since outcome data is
 * structured/machine-oriented while this is specifically meant to be
 * spoken or displayed as a sentence. `shouldSpeak` lets a future caller
 * skip text-to-speech for a response with nothing meaningful to say
 * aloud, without needing to inspect `text` itself to decide. */
export interface AssistantVoiceResponse {
  text: string;
  shouldSpeak: boolean;
}
