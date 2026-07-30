/**
 * Strict, backend-side validation of raw LLM classifier output — see
 * docs/assistant_ai_integration_review.md §2. Nothing a classifier
 * returns is ever trusted directly: this is the one place raw,
 * unvalidated JSON from an external provider is turned into (or
 * rejected in favor of) a safe `Intent`, held to exactly the same
 * closed-vocabulary contract the deterministic router already enforces.
 *
 * Every check below fails closed: the first thing that doesn't check
 * out drops the WHOLE response to `UNKNOWN_INTENT`, never a partially-
 * trusted `Intent` assembled from whatever parts of a malformed
 * response DID validate.
 */
import type { Intent, IntentType } from '../types/index.ts';

const VALID_INTENT_TYPES: ReadonlySet<string> = new Set<IntentType>([
  'search', 'add_to_cart', 'remove_from_cart', 'compare_options', 'optimize_cart',
  'open_planner', 'set_budget_target', 'meal_plan', 'nutrition_question', 'start_shopping_session',
  'update_preferences', 'unknown',
]);

/**
 * The ONLY parameter keys any classifier — rule-based or LLM — may ever
 * set, matching exactly what intentRouterService.ts's own deterministic
 * rules use (`query`/`item`/`amount`). This is a closed ALLOWLIST, not a
 * blocklist: a key like `productId` is dropped not because it's
 * "dangerous" in isolation, but because nothing in this app's contract
 * has ever agreed a classifier may originate one — see this app's own
 * "never trust an LLM-originated product ID" rule
 * (docs/assistant_ai_integration_review.md §2). A future intent that
 * legitimately needs a new parameter key must add it here deliberately,
 * the same way a new IntentType must be added to `VALID_INTENT_TYPES`
 * deliberately — never let a model's own output silently expand what
 * this app treats as a real parameter.
 */
// Phase 5.1: deliberately NOT extended for 'start_shopping_session', even
// though that intent's real parameters include `goal`/`hasList`/`items`/
// `budgetTarget` (see assistantDispatcher.ts's `dispatchStartShoppingSession`).
// This means an LLM classification of that type always arrives with an
// EMPTY parameters bag (any of those keys would be silently dropped below,
// exactly like `productId`) — the dispatcher's own multi-turn conversation
// then asks for each field explicitly, same as if the shopper had said
// nothing at all. This is the deepest, most conservative enforcement of
// this sprint's "never infer — ask instead" rule: even a hypothetical
// future LLM tier can never originate a goal/budget/item list that
// bypasses a real, explicit user answer.
// Also deliberately NOT extended with 'quantity' for 'remove_from_cart',
// even though intentRouterService.ts's own deterministic rule extracts one
// (e.g. "remove 2 bananas"). An LLM-originated removal count is still an
// LLM deciding "how many" without a real, explicit user statement passing
// through this validator — same rationale as the two exclusions below,
// just for a single field rather than a whole intent's parameter set. A
// deterministic-tier removal count keeps working today because Tier 1's
// own `resolveIntent` output is never routed through this validator at
// all (see intentRouterService.ts's `resolveHybridIntent`) — only Tier 2's
// raw classifier output is.
// Phase 5.2: also deliberately NOT extended for 'update_preferences',
// whose real fields are `field`/`value` (see
// src/services/shopperPreferenceService.ts's `applyPreferenceUpdate`).
// This means an LLM classification of that type always arrives with an
// EMPTY parameters bag — the dispatcher then reports "I'm not sure what
// to remember" rather than ever writing an LLM-invented preference. Same
// rationale as 'start_shopping_session' above: preferences are memory —
// they must only ever trace back to a real, explicit, deterministically-
// parsed user statement (see docs/assistant_phase5_roadmap.md's Phase 5.2
// safety review), never something a classifier decided on its own.
const ALLOWED_PARAMETER_KEYS: readonly string[] = ['query', 'item', 'amount'];

/** The same sentinel the deterministic router already returns for
 * unclassifiable input — reused here so "the LLM said something we
 * don't trust" and "nothing matched at all" are indistinguishable to
 * every downstream consumer, exactly as they already are today. */
export const UNKNOWN_INTENT: Intent = { type: 'unknown', confidence: 0, parameters: {} };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Copies over ONLY the allowlisted keys, and only when their value is
 * a plain scalar (string/number/boolean) — never an object, array,
 * `null`, or anything else, regardless of key. This is what makes a
 * hallucinated `productId` or a `toolCall: {...}` payload structurally
 * impossible to smuggle through: they're either not on the allowlist
 * (dropped) or not a scalar (dropped) or both. */
function sanitizeParameters(rawParameters: unknown): Intent['parameters'] {
  if (!isPlainObject(rawParameters)) return {};

  const clean: Intent['parameters'] = {};
  for (const key of ALLOWED_PARAMETER_KEYS) {
    const value = rawParameters[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      clean[key] = value;
    }
  }
  return clean;
}

/**
 * Turns raw, untyped classifier output into a safe `Intent`, or the
 * closed-vocabulary `UNKNOWN_INTENT` sentinel if the input doesn't earn
 * trust. Never throws — any shape of `raw`, including `null`,
 * primitives, and arrays, resolves to a valid `Intent`.
 */
export function validateClassifierOutput(raw: unknown): Intent {
  if (!isPlainObject(raw)) return UNKNOWN_INTENT;

  const { type, confidence } = raw;
  if (typeof type !== 'string' || !VALID_INTENT_TYPES.has(type)) return UNKNOWN_INTENT;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return UNKNOWN_INTENT;

  // "Clamped/validated," per this sprint's own requirement — an
  // out-of-range confidence (e.g. a model returning 1.4) is corrected,
  // not treated as a hard validation failure the way a wrong TYPE is.
  const clampedConfidence = Math.min(1, Math.max(0, confidence));

  return {
    type: type as IntentType,
    confidence: clampedConfidence,
    parameters: sanitizeParameters(raw.parameters),
  };
}
