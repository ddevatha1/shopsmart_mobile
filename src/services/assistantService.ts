import type {
  AssistantActionResult, AssistantError, AssistantOutcome, AssistantSessionContext, CartConfirmationResult,
  ClarificationRequest, Intent,
} from '../models/intent';
import type { ApiProduct } from '../models/types';
import { resolveAssistantIntent } from './assistantRepository';
import { dispatchIntent, parseShoppingGoal } from './assistantDispatcher';
import { evaluateClarificationPolicy } from './clarificationPolicy';
import { createPendingClarification } from './clarificationStore';
import {
  clearPendingCartMutationConfirmation, clearPendingProductSelection, createPendingCartMutationConfirmation,
  getPendingCartMutationConfirmation, getPendingProductSelection,
} from './productSelectionStore';
import { clearPendingConversation, getPendingConversation } from './assistantConversationStore';

/**
 * The end-to-end assistant entry point — the future home for voice,
 * text, and camera-derived commands. No UI is added here; this is
 * orchestration only.
 *
 * As of Phase 5.0, `runAssistant` checks for THREE kinds of pending
 * multi-turn state, in priority order, before the normal pipeline even
 * starts:
 *
 *   1. A pending conversation ("How many meals should I plan for?") — is
 *      this input a real answer to it? (Phase 5.0 — see
 *      assistantConversationStore.ts.)
 *   2. A pending cart-mutation confirmation ("Add Organic Milk?") — is
 *      this input a yes/no answer to it?
 *   3. A pending product selection ("Which one?") — does this input pick
 *      one of the real candidates?
 *
 * None of these checks ever mutate the cart, or anything else, directly.
 * A "yes" (2) or a merged answer (1) always re-enters through
 * `dispatchIntent` — see `finalizeDispatchResult` below — because
 * `dispatchIntent` remains the ONLY action gateway, exactly as every
 * prior phase established. A "which one" match (3) only ever creates a
 * NEW pending confirmation and asks the user to confirm THAT specific
 * product.
 *
 * The conversation-merge step (1) is deterministic parameter extraction
 * only — see `extractParameterValue` below — never an LLM, and it never
 * infers any field beyond the single one the pending question named
 * (`missingField`). If the follow-up text can't be parsed for that field,
 * this asks the same question again rather than guessing.
 *
 * If neither pending state applies, the normal pipeline runs exactly as
 * it has since Phase 4.2:
 *
 *   user text -> resolveAssistantIntent() -> Intent -> clarification policy -> either:
 *     a) dispatchIntent()
 *     b) return a clarification_required AssistantOutcome
 *
 * `dispatchIntent` still runs its own full safety boundary internally
 * (intentPolicy.ts's evaluateIntent, then validateSessionContext) before
 * ever calling a real service — completely unchanged by this sprint.
 */

export interface AssistantServiceDependencies {
  resolveIntent: (text: string, context?: { currentScreen?: string }) => Promise<Intent>;
  dispatch: (intent: Intent, context?: AssistantSessionContext) => Promise<AssistantActionResult>;
}

const defaultDependencies: AssistantServiceDependencies = {
  resolveIntent: resolveAssistantIntent,
  dispatch: (intent, context) => dispatchIntent(intent, context),
};

// Reused for the one case with no real resolved Intent to report (a
// network failure reaching the backend) — see AssistantOutcome's own doc
// comment in models/intent.ts for why this is honest, not a fabrication,
// and how `errorType` (not this shape) is what actually disambiguates it
// from a genuine router-level 'unknown' classification.
const NETWORK_FAILURE_INTENT: Intent = { type: 'unknown', confidence: 0, parameters: {} };

function classifyDispatchFailure(intent: Intent, clarification: ClarificationRequest | undefined): AssistantError {
  if (intent.type === 'unknown') return 'unknown_intent';
  if (clarification) return 'blocked_intent';
  return 'service_failure';
}

// ─── Confirmation ("yes add it") parsing — deterministic, not NLP ─────────
// Same word-boundary-matching discipline as backend/src/services/
// intentRouterService.ts, for the exact same reason: a bare `.includes`
// check would let "no" match inside "know", etc.

const YES_WORDS = ['yes', 'yeah', 'yep', 'yup', 'confirm', 'confirmed', 'correct', 'sure', 'add it', 'do it', 'remove it', 'ok', 'okay'];
const NO_WORDS = ['no', 'nope', 'cancel', 'never mind', 'nevermind', 'stop', 'don\'t'];

function matchesAnyPhrase(text: string, phrases: string[]): boolean {
  const lower = text.trim().toLowerCase();
  return phrases.some((phrase) => new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower));
}

type ConfirmationResponse = 'yes' | 'no' | 'unclear';

function parseConfirmationResponse(text: string): ConfirmationResponse {
  if (matchesAnyPhrase(text, YES_WORDS)) return 'yes';
  if (matchesAnyPhrase(text, NO_WORDS)) return 'no';
  return 'unclear';
}

// ─── Conversation-merge follow-up parsing (Phase 5.0) — deterministic ────
// only, never an LLM, never inferring a field beyond the one requested.
// Mirrors backend/src/services/intentRouterService.ts's own
// `extractFirstNumber` — a plain regex, not NLP.

function extractParameterValue(field: string, text: string): string | number | boolean | undefined {
  switch (field) {
    case 'mealCount': {
      const match = text.match(/\d+/);
      return match ? Number(match[0]) : undefined;
    }
    // Phase 5.1 — start_shopping_session's multi-turn fields. Each of
    // these is a closed, deterministic mapping over the SAME fixed
    // choices the assistant's own question offered (see
    // assistantDispatcher.ts's `dispatchStartShoppingSession`) — never
    // free-form inference.
    case 'goal':
      return parseShoppingGoal(text);
    case 'hasList': {
      if (matchesAnyPhrase(text, YES_WORDS)) return true;
      if (matchesAnyPhrase(text, NO_WORDS)) return false;
      return undefined;
    }
    case 'items': {
      const trimmed = text.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    // Phase 5.3 Part 4 — set_budget_target's own missing-amount follow-up
    // (see assistantDispatcher.ts's `dispatchSetBudgetTarget`). A reply
    // like "Actually keep it under $100 and use Aldi" only ever extracts
    // the number — "and use Aldi" is never inspected for anything else;
    // this switch has no case (and no code path at all) that could turn
    // it into a preference update. See this file's own "targeted
    // extraction, no unrelated side effects" tests.
    case 'amount': {
      const match = text.match(/\d+(\.\d+)?/);
      return match ? Number(match[0]) : undefined;
    }
    default:
      // No known deterministic extraction for this field — never guess.
      return undefined;
  }
}

/** Matches free text (e.g. "the organic one") against a real candidate
 * list by simple, deterministic word overlap — never fuzzy/AI matching.
 * Returns the matching candidates; the caller only acts when there's
 * EXACTLY one, never guessing between several. */
function matchCandidates(text: string, candidates: ApiProduct[]): ApiProduct[] {
  const words = text.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return [];
  return candidates.filter((c) => {
    const name = c.name.toLowerCase();
    return words.some((w) => name.includes(w));
  });
}

/** Shared by both the normal pipeline and the confirmation-response
 * re-dispatch path — turns a dispatcher result into the right
 * `AssistantOutcome`, including registering a `PendingClarification` for
 * any NEW clarification a dispatch call produced. */
function finalizeDispatchResult(intent: Intent, result: AssistantActionResult, originalText: string): AssistantOutcome {
  if (result.success) return result;

  if (result.pendingType) {
    // 'conversation_required' (Phase 5.0) is reported to a caller as the
    // SAME 'clarification_required' marker a plain clarification uses —
    // both mean "I asked a real question, show it" — a caller doesn't
    // need a distinct UI branch just because the follow-up answer will be
    // merged differently under the hood (see assistantConversationStore.ts).
    const type = result.pendingType === 'conversation_required' ? 'clarification_required' : result.pendingType;
    return { ...result, type };
  }

  if (result.clarification) {
    createPendingClarification({
      originalText,
      intentCandidate: intent,
      missingFields: [],
      question: result.clarification.message,
    });
  }

  return {
    ...result,
    errorType: classifyDispatchFailure(intent, result.clarification),
    type: result.clarification ? 'clarification_required' : undefined,
  };
}

/**
 * Resolves `text` to an `Intent` (via the backend), checks the
 * clarification policy, and either asks for more information or
 * dispatches — returning the real, verified outcome either way. Never
 * throws: a failure at any stage (network, clarification, policy block,
 * or service failure) comes back as `{ success: false, errorType, ... }`,
 * never a raw exception — see `AssistantError` for the closed set of
 * reasons, and `AssistantOutcome.type` for the clarification/selection/
 * confirmation markers.
 */
export async function runAssistant(
  text: string,
  context: AssistantSessionContext = {},
  deps: AssistantServiceDependencies = defaultDependencies,
): Promise<AssistantOutcome> {
  // ── Phase 5.0, priority 0: a pending multi-turn conversation ──────────
  const pendingConversation = getPendingConversation();
  if (pendingConversation) {
    const extracted = extractParameterValue(pendingConversation.missingField, text);
    if (extracted === undefined) {
      // Couldn't deterministically parse an answer for the field this
      // question asked about — ask again rather than guess (see this
      // file's header comment and models/intent.ts's
      // AssistantConversationState doc comment). Deliberately does NOT
      // clear the pending state: the shopper gets another real chance to
      // answer the same question, same as a stale/unmatched product
      // selection is dropped below, not silently defaulted.
      return {
        success: false,
        intent: pendingConversation.pendingIntent,
        type: 'clarification_required',
        clarification: { type: 'clarification', message: pendingConversation.pendingQuestion, originalIntent: pendingConversation.pendingIntent },
      };
    }

    clearPendingConversation();
    const mergedIntent: Intent = {
      ...pendingConversation.pendingIntent,
      parameters: { ...pendingConversation.collectedParameters, [pendingConversation.missingField]: extracted },
    };
    // Re-enters through dispatchIntent — the only action gateway. Never
    // re-classified from scratch: the ORIGINAL intent, with the missing
    // field now filled in, is what gets dispatched.
    const result = await deps.dispatch(mergedIntent, context);
    return finalizeDispatchResult(mergedIntent, result, text);
  }

  // ── Phase 4.3, priority 1: a pending cart-mutation confirmation ───────
  const pendingConfirmation = getPendingCartMutationConfirmation();
  if (pendingConfirmation) {
    const response = parseConfirmationResponse(text);
    if (response === 'yes') {
      // Re-enter through dispatchIntent — the only action gateway.
      // dispatchAddToCart/dispatchRemoveFromCart will find this exact
      // same pending confirmation and perform the real mutation; this
      // file never touches the cart store directly.
      const result = await deps.dispatch(pendingConfirmation.originalIntent, context);
      return finalizeDispatchResult(pendingConfirmation.originalIntent, result, text);
    }
    if (response === 'no') {
      clearPendingCartMutationConfirmation();
      return { success: false, intent: pendingConfirmation.originalIntent, error: 'Okay, not making that change.' };
    }
    // An unclear response never defaults to "yes" — drop the stale
    // confirmation and treat this input as a brand-new request instead
    // of guessing what the shopper meant.
    clearPendingCartMutationConfirmation();
  }

  // ── Phase 4.3, priority 2: a pending product selection ────────────────
  const pendingSelection = getPendingProductSelection();
  if (pendingSelection) {
    const matches = matchCandidates(text, pendingSelection.candidates);
    if (matches.length === 1) {
      clearPendingProductSelection();
      const mutationAction = pendingSelection.originalIntent.type === 'remove_from_cart' ? 'remove_from_cart' : 'add_to_cart';
      createPendingCartMutationConfirmation({
        action: mutationAction,
        product: matches[0],
        originalIntent: pendingSelection.originalIntent,
      });
      const data: CartConfirmationResult = { action: 'confirmation_required', mutationAction, product: matches[0] };
      return { success: false, intent: pendingSelection.originalIntent, type: 'confirmation_required', data };
    }
    // No confident single match — drop the stale selection rather than
    // guessing, and fall through to treating this as a fresh request.
    clearPendingProductSelection();
  }

  // ── Normal pipeline (unchanged since Phase 4.2) ────────────────────────
  let intent: Intent;
  try {
    intent = await deps.resolveIntent(text, context.currentScreen != null ? { currentScreen: context.currentScreen } : undefined);
  } catch (err) {
    return {
      success: false,
      intent: NETWORK_FAILURE_INTENT,
      errorType: 'network_error',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const clarificationDecision = evaluateClarificationPolicy(intent, context);
  if (clarificationDecision.required && clarificationDecision.request) {
    createPendingClarification({
      originalText: text,
      intentCandidate: intent,
      missingFields: clarificationDecision.missingFields ?? [],
      question: clarificationDecision.request.message,
    });
    return {
      success: false,
      intent,
      type: 'clarification_required',
      clarification: clarificationDecision.request,
      errorType: classifyDispatchFailure(intent, clarificationDecision.request),
    };
  }

  const result = await deps.dispatch(intent, context);
  return finalizeDispatchResult(intent, result, text);
}
