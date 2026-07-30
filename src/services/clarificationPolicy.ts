import type { AssistantSessionContext, ClarificationRequest, Intent } from '../models/intent';
import { buildClarification } from './intentPolicy';

/**
 * The Clarification Layer (Phase 4.2) — sits BEFORE `dispatchIntent` in
 * assistantService.ts's `runAssistant`, per the new architecture:
 *
 *   text -> resolveHybridIntent() -> Intent -> clarification policy -> either:
 *     a) dispatchIntent()
 *     b) return a clarification request
 *
 * This is a SEPARATE, ADDITIONAL gate — it does not replace, modify, or
 * weaken intentPolicy.ts's `evaluateIntent`/`validateSessionContext`,
 * which remain completely unchanged and still run INSIDE `dispatchIntent`
 * for anything this layer lets through (defense in depth: a bug here
 * can make this layer too permissive, but it can never make
 * `dispatchIntent` itself less safe, since that file isn't touched at
 * all). "Do not change the dispatcher safety model" is enforced simply
 * by this file never importing or calling `dispatchIntent`.
 *
 * NEVER executes anything: no search, no product lookup, no cart
 * mutation, no service call of any kind. Every decision here is made
 * purely from the `Intent`'s own `parameters` and the passed-in
 * `AssistantSessionContext` — see `evaluateClarificationPolicy`'s own
 * doc comment for the exact rules.
 */

export interface ClarificationDecision {
  required: boolean;
  request?: ClarificationRequest;
  missingFields?: string[];
}

const PROCEED: ClarificationDecision = { required: false };

// Mirrors intentPolicy.ts's MINIMUM_CONFIDENCE exactly — this is the
// same universal floor, checked here too so a low-confidence intent
// gets a real, specific clarification question before ever reaching
// dispatchIntent, rather than relying solely on that file's own
// (unchanged) generic block.
const CONFIDENCE_FLOOR = 0.6;

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function clarify(intent: Intent, question: string, missingFields: string[]): ClarificationDecision {
  return {
    required: true,
    request: { type: 'clarification', message: question, originalIntent: intent },
    missingFields,
  };
}

/**
 * Decides whether `intent` is safe to hand to `dispatchIntent` as-is, or
 * whether the app should ask the user something first.
 *
 * Rules (see this sprint's own brief):
 * - confidence < 0.6 -> always clarify, regardless of type.
 * - `add_to_cart` / `remove_from_cart` -> clarify (asking WHICH product)
 *   only when there's no item text at all to even attempt resolving.
 *   When item text IS present, this function proceeds — it deliberately
 *   does NOT itself decide "resolved" vs. "needs selection," because
 *   that requires a real search/cart-contents lookup, and this file's
 *   own, already-established invariant is that it never makes a service
 *   call of any kind (see this file's header comment). That real
 *   resolution — and the "which one?"/"are you sure?" follow-ups it can
 *   produce — happens downstream in assistantDispatcher.ts's
 *   `dispatchAddToCart`/`dispatchRemoveFromCart` (see
 *   productResolutionService.ts and productSelectionStore.ts). Nothing
 *   here ever trusts `parameters.productId` as a verified selection —
 *   that field isn't even read; a verified product only ever comes from
 *   a real, separate confirmation turn (see assistantService.ts).
 * - `compare_options` / `nutrition_question` -> clarify unless
 *   `parameters.query` is a non-empty string.
 * - `search` -> clarify only if `parameters.query` is missing (a valid
 *   query never clarifies).
 * - `open_planner` / `optimize_cart` / `meal_plan` / `set_budget_target` /
 *   `start_shopping_session` / `update_preferences` -> no extra check
 *   here; each has its own real, downstream conversation/validation (see
 *   the `PROCEED` cases below).
 * - `unknown` -> already caught by the confidence floor above in every
 *   real case (the router always assigns it confidence 0).
 */
export function evaluateClarificationPolicy(intent: Intent, _context: AssistantSessionContext = {}): ClarificationDecision {
  if (intent.confidence < CONFIDENCE_FLOOR) {
    return clarify(intent, buildClarification(intent).message, ['confidence']);
  }

  switch (intent.type) {
    case 'search': {
      if (!hasNonEmptyString(intent.parameters.query)) {
        return clarify(intent, 'What would you like to search for?', ['query']);
      }
      return PROCEED;
    }

    case 'add_to_cart': {
      if (hasNonEmptyString(intent.parameters.item)) return PROCEED;
      return clarify(intent, 'Which product would you like to add to your cart?', ['item']);
    }

    case 'remove_from_cart': {
      if (hasNonEmptyString(intent.parameters.item)) return PROCEED;
      return clarify(intent, 'Which item would you like to remove from your cart?', ['item']);
    }

    case 'compare_options': {
      if (!hasNonEmptyString(intent.parameters.query)) {
        return clarify(intent, 'What would you like to compare?', ['query']);
      }
      return PROCEED;
    }

    case 'nutrition_question': {
      if (!hasNonEmptyString(intent.parameters.query)) {
        return clarify(intent, 'Which food or product did you want nutrition info for?', ['query']);
      }
      return PROCEED;
    }

    case 'open_planner':
    case 'optimize_cart':
    case 'meal_plan':
    // Phase 5.1: same tension-resolution as meal_plan (see this file's
    // header comment and assistantDispatcher.ts's `dispatchStartShoppingSession`)
    // — the real, multi-turn "what's missing" logic requires state this
    // file's own invariant forbids it from touching (a real session
    // store), so it proceeds and the dispatcher asks the real questions.
    // Phase 5.2: same tension-resolution as start_shopping_session/
    // meal_plan — real validation (does this text resolve to a real,
    // closed field/value pair?) requires the router's own extraction
    // this file never re-parses; it proceeds and
    // assistantDispatcher.ts's `dispatchUpdatePreferences` reports an
    // honest failure if nothing recognizable was said.
    // Phase 5.3: set_budget_target joins this same group — its own
    // missing-amount follow-up is now a real, merge-capable conversation
    // (see assistantDispatcher.ts's `dispatchSetBudgetTarget`) rather
    // than a plain, non-merge-capable clarification, so a reply like
    // "under $100" actually resolves instead of being re-classified from
    // scratch (see assistantService.ts's `extractParameterValue`).
    case 'set_budget_target':
    case 'start_shopping_session':
    case 'update_preferences':
      return PROCEED;

    case 'unknown':
    default:
      // Unreachable in practice (confidence 0 is always caught by the
      // floor above) — kept as an explicit, safe default rather than an
      // assumption.
      return clarify(intent, buildClarification(intent).message, ['intent']);
  }
}
