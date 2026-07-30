import type {
  AssistantData, AssistantError, AssistantOutcome, AssistantVoiceResponse, CartConfirmationResult, CartMutationResult,
  ComparisonResult, MealPlanResult, NutritionResult, PlannerAction, PreferenceUpdateResult, ProductSelectionResult,
  RestockSuggestionsResult, ShoppingHistoryResult, ShoppingSessionPlanResult,
} from '../models/intent';
import type { SearchResponse, ShoppingPlanResponse } from '../models/types';

/**
 * Response Generation (Phase 4.4) — the one place an `AssistantOutcome`
 * (structured, machine-oriented data) becomes a plain sentence a shopper
 * could hear or read. Every sentence here is built from a fixed,
 * hand-written template over fields the outcome already carries — never
 * an LLM call, never invented content. If a future phase wants richer,
 * more natural phrasing, that's a deliberate, separate upgrade — this
 * foundation only needs to be correct and honest, not eloquent.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPlannerAction(data: AssistantData): data is PlannerAction {
  return isRecord(data) && data.action === 'open_planner';
}
function isNutritionResult(data: AssistantData): data is NutritionResult {
  return isRecord(data) && data.action === 'nutrition_result';
}
function isComparisonResult(data: AssistantData): data is ComparisonResult {
  return isRecord(data) && data.action === 'comparison_result';
}
function isProductSelectionResult(data: AssistantData): data is ProductSelectionResult {
  return isRecord(data) && data.action === 'product_selection_required';
}
function isCartConfirmationResult(data: AssistantData): data is CartConfirmationResult {
  return isRecord(data) && data.action === 'confirmation_required';
}
function isCartMutationResult(data: AssistantData): data is CartMutationResult {
  return isRecord(data) && (data.action === 'added_to_cart' || data.action === 'removed_from_cart');
}
function isMealPlanResult(data: AssistantData): data is MealPlanResult {
  return isRecord(data) && data.action === 'meal_plan_result';
}
function isShoppingSessionPlanResult(data: AssistantData): data is ShoppingSessionPlanResult {
  return isRecord(data) && data.action === 'shopping_session_plan';
}
function isPreferenceUpdateResult(data: AssistantData): data is PreferenceUpdateResult {
  return isRecord(data) && data.action === 'preference_update_result';
}
function isRestockSuggestionsResult(data: AssistantData): data is RestockSuggestionsResult {
  return isRecord(data) && data.action === 'restock_suggestions';
}
function isShoppingHistoryResult(data: AssistantData): data is ShoppingHistoryResult {
  return isRecord(data) && data.action === 'shopping_history_result';
}
// SearchResult/ShoppingPlanResponse carry no `action` discriminant at
// all (they're real backend response shapes, returned untouched — see
// models/intent.ts's own note on this asymmetry) — distinguish them by
// their own real, always-present fields instead.
function isSearchResult(data: AssistantData): data is SearchResponse {
  return isRecord(data) && Array.isArray(data.products) && Array.isArray(data.storeStatuses);
}
function isShoppingPlanResponse(data: AssistantData): data is ShoppingPlanResponse {
  return isRecord(data) && Array.isArray(data.candidates) && typeof data.recommendedId === 'string';
}

function formatSuccessResponse(outcome: AssistantOutcome): string {
  const data = outcome.data;

  if (isPlannerAction(data)) return 'Opening your shopping planner.';

  if (isCartMutationResult(data)) {
    if (data.action === 'added_to_cart') return `Added ${data.product.name} to your cart.`;
    const qty = data.requestedQuantity != null ? `${data.requestedQuantity} of ` : '';
    return `Removed ${qty}${data.product.name} from your cart.`;
  }

  if (isNutritionResult(data)) {
    const facts: string[] = [];
    if (data.nutrition.caloriesPer100g != null) facts.push(`${data.nutrition.caloriesPer100g} calories`);
    if (data.nutrition.proteinGPer100g != null) facts.push(`${data.nutrition.proteinGPer100g}g protein`);
    const detail = facts.length > 0 ? ` has ${facts.join(', ')} per 100g` : '';
    return `${data.productName}${detail}.`;
  }

  if (isComparisonResult(data)) {
    return `The best value for ${data.query} is ${data.best.product.name} at $${data.best.product.price.toFixed(2)}.`;
  }

  if (isShoppingPlanResponse(data)) {
    return "Here's your optimized shopping plan.";
  }

  if (isShoppingSessionPlanResult(data)) {
    // `explanation` is already real, template-built text over the real
    // plan (see assistantExplanationService.ts) — spoken/displayed
    // verbatim, never regenerated here.
    return data.explanation;
  }

  if (isMealPlanResult(data)) {
    const mealWord = data.meals.length === 1 ? 'meal' : 'meals';
    const pantryNote = data.pantryAdditions.length > 0
      ? ` I also noticed you're low on ${data.pantryAdditions.join(', ')} and included ${data.pantryAdditions.length === 1 ? 'it' : 'them'}.`
      : '';
    return `Here's a plan for ${data.meals.length} ${mealWord} with ${data.groceryItems.length} grocery items.${pantryNote}`;
  }

  if (isPreferenceUpdateResult(data)) {
    const label: Record<PreferenceUpdateResult['field'], string> = {
      preferredStores: `I'll remember you prefer ${data.value}.`,
      avoidedStores: `Got it — I'll avoid suggesting ${data.value}.`,
      optimizationPreference: `Got it — I'll lean toward ${data.value} options.`,
      defaultBudgetTarget: `Got it — I'll remember a default budget of $${Number(data.value).toFixed(2)}.`,
    };
    return label[data.field];
  }

  if (isRestockSuggestionsResult(data)) {
    if (data.suggestions.length === 0) return "I don't have enough shopping history yet to suggest anything.";
    const items = data.suggestions.map((s) => s.itemName).join(', ');
    return `Based on your shopping history, you might need: ${items}.`;
  }

  if (isShoppingHistoryResult(data)) {
    if (data.sessions.length === 0) return "You don't have any previous shopping sessions yet.";
    return `You have ${data.sessions.length} previous shopping session${data.sessions.length === 1 ? '' : 's'}.`;
  }

  if (isSearchResult(data)) {
    const query = typeof outcome.intent.parameters.query === 'string' ? outcome.intent.parameters.query : 'that';
    return data.products.length > 0
      ? `Here are the options I found for ${query}.`
      : `I couldn't find any results for ${query}.`;
  }

  return 'Done.';
}

function formatProductSelectionResponse(outcome: AssistantOutcome): string {
  const data = outcome.data;
  if (isProductSelectionResult(data)) {
    return `I found ${data.candidates.length} options for ${data.query}. Which one would you like?`;
  }
  return 'Which product did you mean?';
}

function formatConfirmationResponse(outcome: AssistantOutcome): string {
  const data = outcome.data;
  if (isCartConfirmationResult(data)) {
    const verb = data.mutationAction === 'add_to_cart' ? 'Add' : 'Remove';
    const qty = data.mutationAction === 'remove_from_cart' && data.requestedQuantity != null ? `${data.requestedQuantity} of ` : '';
    return `${verb} ${qty}${data.product.name}?`;
  }
  return 'Are you sure?';
}

// Fixed, safe, generic fallbacks — used only when there's no more
// specific outcome data to build a sentence from (see
// `formatFailureResponse`). Deliberately not a verbatim echo of
// `outcome.error`: some error strings in this codebase are already good
// sentences, but others (e.g. dispatchMealPlan's `'meal_plan_not_available'`)
// are code-like identifiers, never meant to be spoken aloud.
const GENERIC_FAILURE_MESSAGES: Record<AssistantError, string> = {
  network_error: "Sorry, I'm having trouble connecting right now.",
  unknown_intent: "Sorry, I didn't understand that.",
  blocked_intent: 'Sorry, I need a bit more information for that.',
  service_failure: "Sorry, I couldn't do that right now.",
};
const DEFAULT_FAILURE_MESSAGE = 'Sorry, something went wrong.';

function formatFailureResponse(outcome: AssistantOutcome): string {
  if (outcome.errorType) return GENERIC_FAILURE_MESSAGES[outcome.errorType];
  return DEFAULT_FAILURE_MESSAGE;
}

/**
 * Converts a real `AssistantOutcome` into user-facing text — the one
 * function voiceAssistantService.ts (and any future text/chat UI) calls
 * to know what to say or display. `shouldSpeak` is `true` whenever there
 * is real text to say, which is every branch below (there is currently
 * no outcome shape this foundation considers "not worth speaking").
 */
export function formatAssistantResponse(outcome: AssistantOutcome): AssistantVoiceResponse {
  let text: string;

  if (outcome.success) {
    text = formatSuccessResponse(outcome);
  } else if (outcome.type === 'clarification_required' && outcome.clarification) {
    // The deterministic clarification/policy layers already produce a
    // real, safe question — see intentPolicy.ts's buildClarification and
    // clarificationPolicy.ts — never regenerated or reworded here.
    text = outcome.clarification.message;
  } else if (outcome.type === 'product_selection_required') {
    text = formatProductSelectionResponse(outcome);
  } else if (outcome.type === 'confirmation_required') {
    text = formatConfirmationResponse(outcome);
  } else {
    text = formatFailureResponse(outcome);
  }

  return { text, shouldSpeak: text.length > 0 };
}
