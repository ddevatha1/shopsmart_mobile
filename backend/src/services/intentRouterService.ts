/**
 * The intent-router boundary — now a two-tier hybrid (Phase 4.1; see
 * docs/assistant_ai_integration_review.md §1 for the full design
 * rationale). Tier 1, `resolveIntent`, is exactly what it always was:
 * fixed, deterministic keyword/phrase matching over a closed vocabulary,
 * NOT NLP, no network, no AI. It is UNCHANGED by this file's Phase 4.1
 * work — every pre-existing test against it keeps passing unmodified,
 * and it remains fully usable on its own.
 *
 * Tier 2, `resolveHybridIntent`, wraps tier 1: it only ever consults an
 * (injected, optional) LLM classifier when tier 1 couldn't confidently
 * resolve the input by itself. This is the hybrid orchestrator described
 * in the architecture review — LLM-assisted, never LLM-required, and
 * structurally incapable of executing anything: both tiers only ever
 * produce the same inert `Intent` value `resolveIntent` always has.
 *
 * Every rule fires on a real WORD-BOUNDARY match in the input, never a
 * raw substring — unmatched input always resolves to `'unknown'` with
 * `confidence: 0`, never a low-confidence guess at some other type.
 *
 * Word-boundary matching (Phase 3.1 hardening) fixed a real bug a plain
 * `.includes()` check had: "I'm doing research on prices" used to
 * resolve to `'search'` purely because the substring "search" appears
 * inside "research" — nothing about the sentence is actually a search
 * request. `\bsearch\b`-style matching requires the keyword to appear as
 * its own word (or phrase), so "research" no longer matches "search",
 * "address" no longer matches "add", etc. — see `hasWordBoundaryMatch`.
 */
import type { Intent, IntentType } from '../types/index.ts';
import { getConfiguredClassifier, type IntentClassifier } from './intentClassifierService.ts';
import { validateClassifierOutput } from './intentClassifierValidation.ts';

// A fixed, documented constant, not a computed score — rule-based
// keyword matching has no real notion of a continuous confidence value.
// A future real classifier (rule-based or LLM) is free to produce a
// genuine graded score; this stub only needs to prove the shape.
const RULE_MATCH_CONFIDENCE = 0.8;

interface IntentRule {
  type: IntentType;
  /** Any ONE of these words/phrases present as a real word-boundary
   * match (case-insensitive) triggers this rule. Checked in array
   * order — the first rule that matches wins, so more specific phrasing
   * is listed before more generic overlapping keywords (e.g. "meal_plan"
   * is checked before "open_planner", since "planner" alone would
   * otherwise never get a chance to lose to the more specific phrase).
   * `open_planner`'s own keywords were deliberately narrowed away from
   * a bare "shopping list" — that phrase legitimately appears inside
   * optimize_cart phrasing too (e.g. "make my shopping list cheaper"),
   * and checking open_planner first would have won that match wrongly. */
  keywords: string[];
  extractParameters?: (input: string) => Record<string, string | number | boolean | undefined>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The one place a keyword is turned into an actual match check — a
 * real `\b<phrase>\b` regex, not `.includes()`. `\b` only fires at a
 * transition between a word character and a non-word one (or a string
 * edge), so a short keyword like "add" can never match inside a longer
 * unrelated word like "address" or "ladder". */
function hasWordBoundaryMatch(text: string, keyword: string): boolean {
  const pattern = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'i');
  return pattern.test(text);
}

/** Finds the same word-boundary match `hasWordBoundaryMatch` found, and
 * returns whatever text follows it — used to extract a rough parameter
 * (e.g. the item name in "add milk to cart") without any real parsing. */
function stripLeadingKeyword(input: string, keywords: string[]): string | undefined {
  for (const keyword of keywords) {
    const pattern = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'i');
    const match = pattern.exec(input);
    if (match) {
      const rest = input.slice(match.index + match[0].length).trim();
      return rest.length > 0 ? rest : undefined;
    }
  }
  return undefined;
}

function extractFirstNumber(input: string): number | undefined {
  const match = input.match(/\d+(\.\d+)?/);
  return match ? Number(match[0]) : undefined;
}

const REMOVAL_NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** Only ever reads a count from the START of the text remaining after the
 * remove/delete keyword (e.g. "2 bananas", "one banana") — never a bare
 * digit anywhere else in the sentence, so "remove milk from my cart"
 * (no count stated) correctly returns `undefined`, meaning "remove the
 * whole line," exactly like before this existed. `undefined` is a real,
 * common, and safe outcome, never treated as an error. */
function extractRemovalQuantity(itemText: string | undefined): number | undefined {
  if (!itemText) return undefined;
  const match = /^\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i.exec(itemText);
  if (!match) return undefined;
  const token = match[1].toLowerCase();
  const quantity = /^\d+$/.test(token) ? Number(token) : REMOVAL_NUMBER_WORDS[token];
  return quantity > 0 ? quantity : undefined;
}

// Phase 5.2 — no shared StoreName export exists in this backend (same
// note as shoppingPlanOptimizer.ts's own ALL_STORES) — hardcoded here
// deliberately rather than importing a frontend-only constant.
const KNOWN_STORE_NAMES = ["Trader Joe's", 'Sprouts', 'Kroger', 'Aldi', 'Albertsons', 'Harris Teeter'];

function findStoreNameIn(input: string): string | undefined {
  const lower = input.toLowerCase();
  return KNOWN_STORE_NAMES.find((s) => lower.includes(s.toLowerCase()));
}

/**
 * update_preferences' own extraction — a closed, deterministic mapping,
 * never a guess. Returns `{ field: undefined, value: undefined }` when
 * nothing recognizable was said, so the dispatcher can honestly report
 * "I'm not sure what to remember" rather than writing anything.
 *
 * "Don't show me Walmart" is handled even though this app has no Walmart
 * data source at all (see backend's own STORE list) — a shopper's stated
 * dislike of a store this app doesn't carry is still a real, harmless
 * preference to remember, just currently inert; nothing here validates
 * the extracted store name against `KNOWN_STORE_NAMES`, only the POSITIVE
 * "I prefer shopping at X" case does (since asserting a preference FOR an
 * unsupported store would be actively misleading, asserting a preference
 * AGAINST one is not).
 */
function extractPreferenceUpdate(input: string): Record<string, string | number | boolean | undefined> {
  const lower = input.toLowerCase();

  const negativeMatch = /\b(?:don't show me|do not show me)\s+(.+)/i.exec(input);
  if (negativeMatch) {
    const value = negativeMatch[1].replace(/[.?!]+$/, '').trim();
    if (value) return { field: 'avoidedStores', value };
  }

  const store = findStoreNameIn(input);
  if (store) return { field: 'preferredStores', value: store };

  if (/\bhealth(y|ier)\b|\bnutrition\b/.test(lower)) return { field: 'optimizationPreference', value: 'healthiest' };
  if (/\bcheapest\b/.test(lower)) return { field: 'optimizationPreference', value: 'cheapest' };
  if (/\bfastest\b|\bquickest\b/.test(lower)) return { field: 'optimizationPreference', value: 'fastest' };
  if (/\bbalanced\b/.test(lower)) return { field: 'optimizationPreference', value: 'balanced' };

  return { field: undefined, value: undefined };
}

/** For nutrition_question specifically — prefers whatever follows a
 * standalone "in" (e.g. "how much protein is IN milk" -> "milk",
 * "calories in a banana" -> "a banana"), the most common phrasing for
 * this kind of question. Falls back to the full input when no such split
 * point exists, letting the search this resolves to do what it can with
 * the raw text rather than returning nothing. */
function extractNutritionSubject(input: string): string | undefined {
  const match = /\bin\s+(.+)$/i.exec(input);
  if (match) {
    const subject = match[1].replace(/[?.!]+$/, '').trim();
    if (subject.length > 0) return subject;
  }
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const RULES: IntentRule[] = [
  {
    type: 'remove_from_cart',
    keywords: ['remove', 'delete', 'take off', 'take out'],
    // `quantity` is deliberately NOT added to intentClassifierValidation.ts's
    // LLM-tier allowlist (see that file's own comment on `start_shopping_session`/
    // `update_preferences`) — it stays deterministic-router-only until a
    // deliberate review decides an LLM may originate a removal count too.
    extractParameters: (input) => {
      const item = stripLeadingKeyword(input, ['remove', 'delete', 'take off', 'take out']);
      return { item, quantity: extractRemovalQuantity(item) };
    },
  },
  {
    type: 'add_to_cart',
    keywords: ['add'],
    extractParameters: (input) => ({ item: stripLeadingKeyword(input, ['add']) }),
  },
  {
    type: 'set_budget_target',
    keywords: ['budget'],
    extractParameters: (input) => ({ amount: extractFirstNumber(input) }),
  },
  {
    type: 'update_preferences',
    // Phase 5.2 — Personalized Shopping Intelligence + Memory Foundation.
    // Deliberately explicit "remember/prefer/don't show me" phrasing only
    // — never bare 'cheaper'/'healthy'/'fastest' alone, which stay
    // optimize_cart's/start_shopping_session's own territory (this rule's
    // keywords never collide with either). `extractParameters` only ever
    // extracts a `field`+`value` pair from a CLOSED set of fields — see
    // shopperPreferenceService.ts's `applyPreferenceUpdate`, which
    // re-validates this same closed set independently before ever writing
    // anything, and intentClassifierValidation.ts's own deliberate choice
    // to NEVER allowlist `field`/`value` for a future LLM tier (see that
    // file's comment) — this app's preferences are only ever set from a
    // real, explicit, deterministically-parsed statement.
    keywords: [
      'remember i prefer', 'remember that i prefer', 'i prefer shopping at', 'i like shopping at',
      "don't show me", 'do not show me', 'i prefer healthier', 'i prefer the cheapest',
      'i prefer the fastest', 'i prefer balanced',
    ],
    extractParameters: (input) => extractPreferenceUpdate(input),
  },
  {
    type: 'meal_plan',
    // Phase 5.0: added phrasing for the Conversational Grocery Planner's
    // actual worked example ("Plan dinners for this week") — see
    // docs/assistant_phase5_roadmap.md §4/§5. `extractParameters` pulls a
    // real, explicit `mealCount`/`mealType` when the input already states
    // them (e.g. "plan 5 dinners"); when it doesn't (the common case —
    // "Plan dinners for this week" states no count), both come back
    // `undefined` and the mobile dispatcher asks a real follow-up
    // question rather than guessing (see assistantDispatcher.ts's
    // `dispatchMealPlan` and assistantConversationStore.ts).
    keywords: [
      'meal plan', 'what should i cook', 'plan my meals', 'recipe', 'meal ideas',
      'dinner', 'dinners', 'breakfast', 'breakfasts',
    ],
    extractParameters: (input) => {
      const numberMatch = input.match(/\d+/);
      const mealType = /\bbreakfast(s)?\b/i.test(input) ? 'breakfast' : /\bdinner(s)?\b/i.test(input) ? 'dinner' : undefined;
      return { mealCount: numberMatch ? Number(numberMatch[0]) : undefined, mealType };
    },
  },
  {
    type: 'start_shopping_session',
    // Phase 5.1 — Conversational Shopping Intelligence Foundation. These
    // phrases are deliberately more specific multi-word phrases than
    // optimize_cart's own bare 'save money'/'cheaper' keywords (checked
    // later in this array): "help me save money this week" starts a
    // guided, multi-turn SESSION (see assistantDispatcher.ts's
    // `dispatchStartShoppingSession`), while a bare "make this cheaper"
    // still means "optimize what's already in my cart right now," exactly
    // as it always has. `extractParameters` only ever pulls an EXPLICIT
    // currency amount the shopper themselves stated (e.g. "keep groceries
    // under $100") — never a guess; every other field (goal, whether they
    // have a list, the list itself) is deliberately left for the
    // dispatcher's real, multi-turn conversation to ask about (see this
    // sprint's own "never infer — ask instead" rule).
    // Phase 5.2: added "what should I buy"-style restock phrasing —
    // `extractParameters` sets `goal: 'restock'` directly for these so the
    // dispatcher can skip straight to real purchase-history-based
    // suggestions (see assistantSuggestionService.ts) instead of asking
    // "what are you optimizing for" first — the phrasing itself already
    // answers that question.
    // Phase 5.3 Part 5: added "show my previous shopping sessions"/"how
    // did my shopping improve" phrasing — `extractParameters` sets
    // `showHistory: true` directly, which assistantDispatcher.ts's
    // `dispatchStartShoppingSession` checks BEFORE anything else needs a
    // goal at all (see that function's own header comment) — a pure,
    // read-only history lookup, never a session-starting flow.
    keywords: [
      'help me save money', 'build me a grocery plan', 'grocery plan', 'shopping session',
      'help me shop', 'start shopping', 'keep groceries under', 'create my plan', 'create my shopping plan',
      'what should i buy', 'what should i get', 'what do i need', 'what am i missing', 'suggest items',
      'show my previous', 'previous shopping sessions', 'how did my shopping improve', 'my shopping history',
      'past shopping sessions',
    ],
    extractParameters: (input) => {
      const budgetMatch = /(?:under|below|no more than|less than)\s*\$?(\d+(?:\.\d+)?)/i.exec(input);
      const isRestockPhrase = /\bwhat should i (buy|get)\b|\bwhat do i need\b|\bwhat am i missing\b|\bsuggest items\b/i.test(input);
      const isHistoryPhrase = /\bshow my previous\b|\bprevious shopping sessions?\b|\bhow did my shopping improve\b|\bmy shopping history\b|\bpast shopping sessions?\b/i.test(input);
      return {
        budgetTarget: budgetMatch ? Number(budgetMatch[1]) : undefined,
        goal: isRestockPhrase ? 'restock' : undefined,
        showHistory: isHistoryPhrase ? true : undefined,
      };
    },
  },
  {
    type: 'open_planner',
    // Deliberately specific — see this file's header comment on why the
    // old bare "shopping list" keyword was removed (it collided with
    // optimize_cart phrasing like "make my shopping list cheaper").
    keywords: ['planner', 'open the planner', 'smart shopping planner', 'plan my shopping trip'],
  },
  {
    type: 'optimize_cart',
    keywords: ['cheaper', 'optimize', 'save money', 'best price', 'lower the cost'],
  },
  {
    type: 'compare_options',
    keywords: ['compare', 'vs', 'which is better', 'better deal'],
    extractParameters: (input) => ({ query: stripLeadingKeyword(input, ['compare', 'vs', 'which is better', 'better deal']) }),
  },
  {
    type: 'nutrition_question',
    // Plural forms listed explicitly ("calorie"/"calories",
    // "carb"/"carbs", "vitamin"/"vitamins") rather than stemmed — the
    // word-boundary matching this file uses (see `hasWordBoundaryMatch`)
    // requires an exact word, so "calories" no longer matches a bare
    // "calorie" keyword the way a loose `.includes()` check once did.
    // Enumerating both forms is simpler and more honest than adding real
    // stemming logic to what's deliberately "not NLP."
    keywords: ['protein', 'calorie', 'calories', 'nutrition', 'healthy', 'carb', 'carbs', 'sugar', 'vitamin', 'vitamins', 'fat content'],
    extractParameters: (input) => ({ query: extractNutritionSubject(input) }),
  },
  {
    type: 'search',
    keywords: ['find', 'search for', 'look for', 'search'],
    extractParameters: (input) => ({ query: stripLeadingKeyword(input, ['find', 'search for', 'look for', 'search']) }),
  },
];

/**
 * Resolves free-form text (a voice transcript or typed input, once those
 * exist) to one closed-vocabulary `Intent`. Deliberately simple — no
 * tokenization, no scoring, no ML — a documented, first-match-wins,
 * word-boundary keyword scan. Never throws: any input, including
 * empty/whitespace-only strings, resolves to a valid `Intent`.
 */
export function resolveIntent(input: string): Intent {
  const text = (input ?? '').trim();
  if (!text) return { type: 'unknown', confidence: 0, parameters: {} };

  for (const rule of RULES) {
    if (rule.keywords.some((keyword) => hasWordBoundaryMatch(text, keyword))) {
      return {
        type: rule.type,
        confidence: RULE_MATCH_CONFIDENCE,
        parameters: rule.extractParameters ? rule.extractParameters(text) : {},
      };
    }
  }

  return { type: 'unknown', confidence: 0, parameters: {} };
}

// ─── Tier 2: hybrid orchestration (Phase 4.1) ──────────────────────────────

// Only escalate to the classifier tier when tier 1 couldn't confidently
// resolve the input on its own. Written as a real threshold comparison
// (not a hardcoded `type === 'unknown'` check) so this keeps working
// correctly if tier 1 is ever extended to produce a graded score instead
// of today's binary RULE_MATCH_CONFIDENCE-or-0.
const HYBRID_ESCALATION_CONFIDENCE = RULE_MATCH_CONFIDENCE;
const DEFAULT_CLASSIFIER_TIMEOUT_MS = 3000;

export interface HybridResolverDependencies {
  /** Defaults to whatever `getConfiguredClassifier()` returns — a real
   * provider call when `LLM_API_KEY` is set, or `undefined` (the LLM
   * tier is skipped entirely) otherwise. Every test overrides this with
   * a fake (see intentRouterService.hybrid.test.ts), so no test path
   * ever makes a real network call. */
  classifier?: IntentClassifier;
  timeoutMs?: number;
}

/** Races an arbitrary injected promise against a timer — works
 * regardless of whether the injected classifier itself cooperates with
 * cancellation (a test double has no obligation to), unlike an
 * AbortController-based timeout, which only the real HTTP implementation
 * in intentClassifierService.ts can meaningfully use. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Intent classifier timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * The hybrid orchestrator (Phase 4.1) — see this file's header comment
 * and docs/assistant_ai_integration_review.md §1. Tier 1 (`resolveIntent`,
 * above) always runs first and is completely unmodified by this
 * function; tier 2 (an injected LLM classifier) is only ever consulted
 * when tier 1 couldn't confidently resolve the input by itself.
 *
 * This never throws, and every failure mode falls back to the SAME safe
 * value: whatever tier 1 already produced. Since escalation only ever
 * happens when that was already `'unknown'`, the safe floor for every
 * fallback path here is always `'unknown'` — never a fabricated guess,
 * and never a raw error surfaced to a caller (see
 * backend/src/routes/assistant.ts, this function's only real caller).
 */
export async function resolveHybridIntent(input: string, deps: HybridResolverDependencies = {}): Promise<Intent> {
  const ruleResult = resolveIntent(input);
  if (ruleResult.type !== 'unknown' && ruleResult.confidence >= HYBRID_ESCALATION_CONFIDENCE) {
    return ruleResult;
  }

  const classifier = deps.classifier ?? getConfiguredClassifier();
  if (!classifier) {
    return ruleResult;
  }

  try {
    const raw = await withTimeout(classifier({ text: input }), deps.timeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS);
    return validateClassifierOutput(raw);
  } catch {
    // Timeout, thrown network/provider error, malformed-JSON parse
    // failure inside the classifier — all treated identically: the
    // classifier was unavailable for this request, fall back safely.
    return ruleResult;
  }
}
