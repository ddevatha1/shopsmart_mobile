/**
 * The LLM boundary — the ONLY file in this backend that may ever call an
 * external LLM provider. Its output is inert, unvalidated JSON handed to
 * intentClassifierValidation.ts's `validateClassifierOutput` — this
 * function never calls a tool, never touches a domain service, and has
 * no awareness any of those exist (see docs/assistant_ai_integration_review.md
 * §1/§6 — "the LLM must never directly execute app actions" is enforced
 * structurally: this file has no import of, or reference to, any search/
 * cart/planner service).
 *
 * No SDK dependency — this app's own established convention for every
 * other external integration (Kroger, Aldi, Open Food Facts) is a plain
 * `fetch` call, not a vendor SDK. The same choice here avoids adding a
 * dependency before a real provider has actually been chosen and
 * reviewed (see docs/assistant_ai_integration_review.md §9, Phase 4.1's
 * own "do not add an SDK yet" scope).
 */
import type { IntentType } from '../types/index.ts';

export interface IntentClassifierInput {
  text: string;
  context?: { currentScreen?: string };
}

/**
 * The ONLY shape any code in this file may ever hand to an external LLM
 * provider — the input-side mirror of intentClassifierValidation.ts's own
 * `ALLOWED_PARAMETER_KEYS` (which allowlists what's trusted back FROM a
 * provider; this is what's allowed to go TO one). `IntentClassifierInput`
 * is free to grow new fields for other future callers without this
 * allowlist silently widening too — a future field (cart contents, an
 * account email, anything else) requires a deliberate edit to
 * `buildLLMContext` below before it could ever leave this backend, the
 * same "closed allowlist, not a blocklist" discipline
 * docs/assistant_ai_integration_review.md §4 calls for.
 */
export interface SafeLLMContext {
  text: string;
  currentScreen?: string;
}

/**
 * The one choke point between `IntentClassifierInput` and an actual
 * provider call. `currentScreen` is allowlisted here but — same as
 * backend/src/routes/assistant.ts's own note on this field — not
 * currently placed anywhere in the provider request body below; it's
 * safe to pass through this function today with no behavior change,
 * ready for a deliberate future use, never smuggled in some other way.
 */
export function buildLLMContext(input: IntentClassifierInput): SafeLLMContext {
  const safe: SafeLLMContext = { text: input.text };
  if (typeof input.context?.currentScreen === 'string') {
    safe.currentScreen = input.context.currentScreen;
  }
  return safe;
}

/**
 * Returns raw, UNVALIDATED provider output — see
 * intentClassifierValidation.ts's `validateClassifierOutput`, the only
 * place this is ever trusted. May throw (network error, timeout,
 * non-2xx response, unparseable body); callers
 * (intentRouterService.ts's `resolveHybridIntent`) must treat any throw
 * as "classifier unavailable for this request" and fall back — never
 * propagate it to a caller.
 */
export type IntentClassifier = (input: IntentClassifierInput) => Promise<unknown>;

const DEFAULT_TIMEOUT_MS = 3000;

// ─── Cost control: a simple global rate limit on real LLM calls ───────────
//
// This backend has no per-shopper auth on the assistant route (see
// routes/assistant.ts) — there's no account/session identity to key a
// per-caller limit off of at this layer. A single global sliding-window
// cap is the simplest thing that actually protects real LLM spend
// regardless of where requests come from, without adding a new dependency
// (this app's own convention — see this file's header comment on "no SDK
// dependency"). `LLM_RATE_LIMIT_PER_MINUTE` is optional; unset falls back
// to a conservative default rather than no limit at all.
//
// A rate-limited call throws, and `resolveHybridIntent` (intentRouterService.ts)
// already treats ANY throw from the classifier as "unavailable for this
// request" and falls back to tier 1's deterministic result — so hitting
// this limit degrades a request to the same safe behavior as the LLM
// tier being unconfigured, never an error surfaced to a shopper.
const DEFAULT_RATE_LIMIT_PER_MINUTE = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;
let recentCallTimestamps: number[] = [];

function configuredRateLimit(): number {
  const raw = Number(process.env.LLM_RATE_LIMIT_PER_MINUTE);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RATE_LIMIT_PER_MINUTE;
}

/** Records a call attempt and reports whether it's over the limit —
 * mutates `recentCallTimestamps` as a side effect, so this must only be
 * called once per real attempt. Exported (alongside
 * `resetRateLimitForTests`) so this — the actual rate-limiting logic —
 * can be tested directly and network-free, without exercising
 * `callLLMProvider`'s real `fetch` call. */
export function isOverRateLimit(): boolean {
  const now = Date.now();
  recentCallTimestamps = recentCallTimestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recentCallTimestamps.length >= configuredRateLimit()) return true;
  recentCallTimestamps.push(now);
  return false;
}

/** Test-only escape hatch — every test that exercises rate limiting needs
 * a clean window, and this module-level array would otherwise leak state
 * across test files/runs. Never called from application code. */
export function resetRateLimitForTests(): void {
  recentCallTimestamps = [];
}

const CLOSED_INTENT_TYPES: IntentType[] = [
  'search', 'add_to_cart', 'remove_from_cart', 'compare_options', 'optimize_cart',
  'open_planner', 'set_budget_target', 'meal_plan', 'nutrition_question', 'unknown',
];

/**
 * Deliberately short and mechanical, not "prompt engineering" — real
 * tuning is out of scope for this foundation phase (see
 * docs/assistant_ai_integration_review.md §9's Phase 4.1 scope). The one
 * hard rule worth stating explicitly here: no chain-of-thought. This
 * app never surfaces a model's raw reasoning tokens to any client (see
 * §2's "chain-of-thought: explicitly excluded") — `reasoningSummary`,
 * when a future phase adds it to the schema, must stay a short, final
 * sentence, never a trace.
 */
const CLASSIFIER_SYSTEM_PROMPT = `You classify a shopper's grocery-app request into exactly one intent.
Respond with ONLY a JSON object, no other text, shaped exactly like:
{ "type": "<one of: ${CLOSED_INTENT_TYPES.join(', ')}>", "confidence": <number 0 to 1>, "parameters": { "query"?: string, "item"?: string, "amount"?: number } }
Rules:
- "type" MUST be one of the listed values, verbatim. If nothing fits, use "unknown" with confidence 0.
- Never invent a product id, a database id, or any field not shown above.
- Do not include reasoning, explanation, or any text outside the JSON object.`;

/**
 * A real, working implementation — calls an OpenAI-compatible chat
 * completions endpoint (JSON/structured-output mode) via plain `fetch`.
 * Reads `LLM_API_KEY`/`LLM_API_URL`/`LLM_MODEL` from the environment
 * (see backend/.env.example). Deliberately NOT wired in as anyone's
 * default without a configured key — see `getConfiguredClassifier`
 * below — and never exercised by a real network call in tests (every
 * test injects a fake `IntentClassifier` instead).
 */
export async function callLLMProvider(input: IntentClassifierInput): Promise<unknown> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error('LLM_API_KEY is not configured.');
  }
  if (isOverRateLimit()) {
    throw new Error(`LLM classifier rate limit exceeded (${configuredRateLimit()}/min).`);
  }
  const apiUrl = process.env.LLM_API_URL ?? 'https://api.openai.com/v1/chat/completions';
  const model = process.env.LLM_MODEL ?? 'gpt-4o-mini';

  // Everything past this line only ever reads `safeContext`, never `input`
  // directly — see `buildLLMContext`'s own comment on why that's the rule.
  const safeContext = buildLLMContext(input);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
          { role: 'user', content: safeContext.text },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`LLM provider returned HTTP ${res.status}`);
    }
    const body = await res.json();
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('LLM provider response missing message content.');
    }
    // May throw SyntaxError on malformed JSON — the caller
    // (resolveHybridIntent) treats any throw here as "classifier
    // unavailable for this request" and falls back safely.
    return JSON.parse(content);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The one place `LLM_API_KEY`'s presence is checked. Returns `undefined`
 * — "no classifier configured" — when it's unset, which is this app's
 * out-of-the-box state today: the hybrid resolver simply skips the LLM
 * tier entirely in that case, identical to pre-Phase-4.1 behavior. This
 * is intentionally the only integration point between "is a real
 * provider available" and the orchestrator in intentRouterService.ts.
 */
export function getConfiguredClassifier(): IntentClassifier | undefined {
  return process.env.LLM_API_KEY ? callLLMProvider : undefined;
}
