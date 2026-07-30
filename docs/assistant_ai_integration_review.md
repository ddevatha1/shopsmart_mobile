# AI Integration Design Review — CartIQ Assistant (Phase 4.0)

**Status: architecture review only. No code changes in this document.**

This review analyzes the deterministic assistant boundary built across
Phases 3.0–3.3 (see `docs/assistant_architecture.md`) and designs how an
LLM-based classifier can be introduced without weakening any existing
safety guarantee. The central finding, stated up front: **the
contract-first design of Phases 3.0–3.3 already does almost all of the
hard work.** `Intent` is a closed, inert data shape; `dispatchIntent()`
is the only code path from an `Intent` to a real action; every safety
gate lives on-device, downstream of network input. Introducing an LLM
means replacing *one function's internals* (`resolveIntent`) — nothing
downstream of `Intent` needs to change to stay safe.

---

## 1. LLM Boundary Design

### Where the LLM lives: backend only

The LLM call must happen **only on the backend**, never on the mobile
client. This isn't a style preference — it's forced by:

- **API key custody.** Any credential shipped inside a mobile bundle is
  extractable. The backend is already the only thing with secrets in
  this app (Kroger OAuth, Open Food Facts, etc.) — an LLM API key
  belongs in exactly that same place, not a new one.
- **Swappability.** The provider/model can change without a mobile app
  release, exactly like every other backend-owned integration in this
  app (Kroger, Aldi, Open Food Facts).
- **A single point for cost/rate control and observability.** Token
  spend, request logging, and abuse throttling all need to live in one
  place; that place is the backend, where they can sit next to the
  existing `perfLog` infrastructure.

Nothing about the mobile-facing contract needs to change: `POST
/api/assistant/intent` still takes `{ text, context? }` and returns
`{ intent: Intent }`. Only what happens *inside* `resolveIntent`
changes.

### Does resolveIntent() get replaced, wrapped, or hybridized?

**Hybrid, tiered — not a straight replacement, and not "LLM as rare
fallback."** Recommended resolution order inside a new orchestrating
`resolveIntent`:

1. Run the existing deterministic keyword router first (it's free,
   synchronous, and already correct for the traffic it's designed for).
2. If it returns a high-confidence match (today's flat `0.8`) for an
   unambiguous case, **return immediately — skip the LLM call
   entirely.** This is a real cost/latency optimization: a large
   fraction of assistant traffic ("find bananas," "add eggs") doesn't
   need a model at all.
3. Otherwise (rules produced `unknown`, or the input is more
   conversational/ambiguous than keyword matching can resolve), call
   the LLM classifier with a bounded timeout.
4. If the LLM call fails, times out, or returns malformed output, fall
   back to whatever the rules produced — even if that's `unknown` — and
   classify the failure via the existing `AssistantError` taxonomy (see
   §8). **Never block the pipeline waiting on the LLM, and never let an
   LLM failure surface as anything other than a normal, already-handled
   `network_error`/low-confidence outcome.**

This keeps the deterministic router as a permanent, load-bearing part of
the system — not legacy code to delete. It's the safety net, the fast
path, and the zero-cost tier all at once.

### The exact contract

```
User text
   |
   v
resolveIntent(text)          <- backend, now a tiered orchestrator
   |  (rules fast-path, or LLM call)
   v
Intent { type, confidence, parameters }   <- UNCHANGED shape
   |
   v
intentPolicy.evaluateIntent()              <- UNCHANGED, mobile
   |
   v
intentPolicy.validateSessionContext()      <- UNCHANGED, mobile
   |
   v
dispatchIntent()                           <- UNCHANGED, mobile
   |
   v
existing domain service
```

**The LLM's output is just another producer of the exact same `Intent`
value `resolveIntent` already produces today.** It has no code path to
`dispatchIntent`, no awareness of domain services, and no ability to
cause a side effect — it emits one JSON object and its job is over. This
is the core guarantee the prompt asks for ("the LLM must never directly
execute app actions"), and it's already structurally true given how
Phase 3.0 drew the `Intent` boundary — the LLM sits entirely upstream of
it.

---

## 2. Structured Output Contract

### Schema

```ts
interface LLMClassificationResponse {
  type: IntentType;                 // MUST be one of the closed enum values
  confidence: number;               // 0–1, self-reported
  parameters: Record<string, string | number | boolean | null>; // flat, scalar only
  needsClarification?: boolean;     // model's own uncertainty signal
  clarificationOptions?: string[];  // short, enumerable candidates — never open-ended
  reasoningSummary?: string;        // ONE short, user-presentable sentence — NOT a trace
}
```

This deliberately mirrors `Intent` almost exactly (see `src/models/intent.ts`)
— `type`/`confidence`/`parameters` are unchanged in shape. The two new
fields (`needsClarification`, `clarificationOptions`) feed §5;
`reasoningSummary` is display-only metadata, never consumed by policy or
dispatch logic.

### Should the LLM output JSON schema? Yes — enforced, not requested.

Use the provider's native structured-output / schema-constrained
generation mode (JSON mode, function-calling with a fixed schema,
whatever the chosen provider calls it), with `type` constrained to the
`IntentType` enum at the schema level. This eliminates most parsing
failures before they happen. It is **not** a substitute for backend
validation — providers occasionally truncate on token limits or degrade
under load, and schema-constrained generation is a strong guarantee, not
an absolute one.

### Should confidence be trusted? No — treat it as one signal, not gospel.

Self-reported LLM confidence is known to be poorly calibrated (models
tend toward overconfidence, and the number doesn't reliably track actual
accuracy). Two mitigations:

- The backend may clamp or adjust the reported confidence before it
  reaches the mobile app (e.g., cap the maximum confidence for
  historically error-prone intent types) — but this is a tuning
  concern to revisit empirically once real traffic exists, not something
  to over-engineer up front.
- More importantly: **the enforcement point doesn't change.**
  `intentPolicy.ts`'s existing `0.6`/`0.8` thresholds still gate
  everything, regardless of which system produced the number. A
  miscalibrated LLM confidence is bounded by the exact same policy a
  miscalibrated deterministic score would be. This is a direct payoff
  of building the policy layer before the classifier.

### Should the backend validate every field? Yes, always, unconditionally.

- `type`: must be an exact match to one of the ten `IntentType` strings.
  Anything else — a near-miss, a synonym, a hallucinated new category —
  is rejected outright and treated as `{ type: 'unknown', confidence: 0 }`.
  Never coerce or guess at intent.
- `confidence`: must be a finite number in `[0, 1]`; clamp out-of-range
  values and log the anomaly (a model consistently returning `1.7` is a
  signal something upstream is broken).
- `parameters`: only scalar values pass through. Any nested object or
  array in a parameter value is stripped, not coerced — this is a
  structural invariant `Intent.parameters` already promises to every
  downstream handler (see `models/intent.ts`), and it must hold
  regardless of what an LLM manages to emit.

### How do we prevent hallucinated product IDs?

This is the single most important validation rule in the whole design,
and it's mostly already enforced by an existing decision:
`intentPolicy.ts`'s `validateSessionContext` already treats a resolved
`parameters.productId` as meaningfully different from free-text
`parameters.item`, and nothing today — not the rule router, and nothing
proposed here for the LLM — is allowed to *originate* a `productId`.

The rule going forward: **`productId` may only ever be populated from a
real product the mobile app itself already retrieved** (e.g., echoed
back from `AssistantSessionContext.selectedProduct` after a real search
the user saw) — never generated by the LLM from its own knowledge of
grocery products. If a future prompt allows the model to reference a
`selectedProduct` from context, the mobile/backend boundary must verify
that ID against what was actually sent in the request, not merely trust
that the model echoed it correctly. An LLM-authored product name (e.g.
"whole milk") is always free text that must be resolved through the
**existing search service** — exactly how `nutrition_question` and
`compare_options` already work today (§6 expands on why this pattern is
non-negotiable).

### Chain-of-thought: explicitly excluded

`reasoningSummary` is a short (recommend capping at ~140 characters),
single-sentence, user-presentable justification the model is
*explicitly prompted* to produce for display purposes — not raw
reasoning tokens. If the chosen provider offers an extended/hidden
reasoning mode, those tokens must never be surfaced to the client, full
stop; `reasoningSummary` is a separate, deliberately constrained field,
validated server-side (length cap, single-sentence check) before it ever
leaves the backend.

---

## 3. Intent Safety Model Review

| Intent | Auto-executable? | Validation required | Confirmation? | What's missing |
|---|---|---|---|---|
| `search` | Yes (already) | free-text query only, read-only | No | Nothing — fully wired |
| `open_planner` | Yes (already) | none — pure UI instruction | No | Nothing |
| `nutrition_question` | Yes (already) | resolved product must carry real `.nutrition` | No | Better query extraction (LLM helps here directly) |
| `compare_options` | Yes (already) | resolved products must come from a real search | No | Nothing structural |
| `meal_plan` | Partial — can *suggest*, never auto-apply | generated ingredients are free text, must still flow through real search/planner | Yes, lightweight (review/edit before it becomes a real list) | Generation logic + wiring into the existing planner flow |
| `add_to_cart` | **No** — see below | product ID must originate from a real, recent search result — never LLM-invented | **Yes, always**, specific to one resolved product | Product-resolution UX + confirmation surface |
| `remove_from_cart` | **No** — see below | must match a real item in `useCartStore`'s current items; disambiguate on 2+ matches | **Yes, always** | Cart-item fuzzy-match + disambiguation UX |
| `set_budget_target` | **No** | amount must pass the existing `isValidBudgetTarget` | **Yes, always**, must echo back the exact parsed number | Confirmation UX that restates the number |
| `optimize_cart` | Already allowed | zipcode + non-empty cart | No (it only *computes* a plan) | See note below — likely mis-bucketed |
| `unknown` | Never | n/a | n/a | Working as intended |

### A finding worth flagging: `optimize_cart` may be mis-classified as "mutating"

`dispatchOptimizeCart` is **read-only** — it calls the planner and
returns a `ShoppingPlanResponse`; it never calls
`cartStore.applyOptimizedItems()`. The actual cart mutation is a
separate, already-existing, explicit user tap ("Apply Plan" in
`AutoOptimizeSheet`). Yet `optimize_cart` currently sits in
`intentPolicy.ts`'s `MUTATING_INTENTS` set, requiring the `0.8`
confidence bar. This isn't wrong exactly — computing a full plan is
expensive and worth being confident before doing — but the *reason* is
different from the other three members of that set, which genuinely
change stored state. Recommend documenting this distinction explicitly
in `intentPolicy.ts` (or reconsidering the bucket) before adding a real
`apply_optimized_plan` intent, so the two "mutating" reasons (expensive
computation vs. real state change) don't get conflated.

### `add_to_cart`: recommended design

**Default behavior: the assistant never adds anything to the cart by
itself.** `add_to_cart` resolves to a *search*, not a mutation:

1. Extract the free-text item name from the intent's parameters (as
   today).
2. Run it through the **existing** search service — the same call
   `search` already makes.
3. Return the top candidates as data (reusing existing product-card
   rendering, not new UI).
4. The user taps a product, which triggers the **app's pre-existing**
   add-to-cart interaction (`cartStore.addToCart`) — completely
   unchanged, completely outside the assistant boundary.

Under this design, `add_to_cart` never needs to become a true
cart-mutating dispatcher action. It's the safest possible answer to
"how should product resolution work" — resolution and mutation are
different steps performed by different actors (the assistant resolves,
the human commits).

A **fuller, opt-in-later** design for hands-free (primarily voice) use:
add a confirmation step where the assistant reads back ONE specific
resolved candidate ("Store Brand Whole Milk, $3.50 at Kroger — add it?")
and only calls `cartStore.addToCart` after an explicit "yes." Store
preference (from `personalizationService`/purchase history, both of
which already exist) may be used to *rank* candidates for this
read-back, never to silently skip confirmation. This should ship well
after and separately from the default search-only behavior (see the
roadmap, Phase 4.3).

### `remove_from_cart`: recommended design

The candidate universe is bounded and already known — `useCartStore`'s
current `items`, not the full catalog. Resolve free text against that
list (reusing `normalizeProductName` from `priceHistoryService.ts`,
already used for exactly this kind of fuzzy identity matching):

- **Zero matches** → honest "nothing matching that in your cart," no
  action.
- **Exactly one match** → still requires confirmation ("Remove Whole
  Milk?") before mutating — a single match isn't the same as a *correct*
  match.
- **Multiple matches** → present the specific matches; never guess
  which one.

### `set_budget_target`: always confirm, no exceptions

This mutates a persisted account preference, not session state — and
this app's existing budget code already treats that distinction
carefully (`updateBudget`'s explicit `null`-clears-vs-real-`$0`
handling, `budgetAnalysisService.ts`'s refusal to fabricate a comparison
against an invalid target). Confirmation must **echo back the specific
parsed number** ("Set your weekly budget to $100?"), not a generic "are
you sure" — a misheard or misparsed amount is a realistic failure mode
this specific echo directly catches.

---

## 4. Context Architecture

### Proposed future `AssistantSessionContext`

```ts
interface AssistantSessionContext {
  currentScreen?: string;
  cartSize?: number;
  cartSummary?: { itemCount: number; storeNames: string[]; approxTotal: number };
  activeQuery?: string;
  selectedProductId?: string;   // only ever a REAL id the app already retrieved
  recentSearchTerms?: string[]; // capped (e.g. last 1–3), ephemeral
  zipcode?: string;
  weeklyBudget?: number;
}
```

`cartSummary` (aggregate) is deliberately offered instead of full cart
contents — see below.

### What's safe to send to the LLM vs. what stays local

Principle: **data minimization by default, opt-in per field, never
"send everything just in case."**

| Field | Send to LLM? | Why |
|---|---|---|
| `currentScreen` | Yes | Pure navigation state, no personal data |
| `activeQuery` / `recentSearchTerms` (capped) | Yes, small amounts | Helps disambiguate follow-ups; not a durable log |
| `cartSize` / `cartSummary` (aggregate) | Yes | Enough for "optimize my cart"-style intents |
| Full cart contents (every product name) | **No, by default** | Rarely needed for classification; a richer profile than the task requires |
| `zipcode` | Sparingly | Classification rarely needs it — dispatch/execution (which never touches the LLM) is where location actually matters |
| `weeklyBudget` | Sparingly | Only when the intent category plausibly needs it |
| Purchase history (any form) | **No** | The most sensitive, longitudinally-identifying data this app holds; `purchaseHistoryService`/`inventoryEstimationService` already keep it strictly on-device. If a future intent genuinely benefits from purchase patterns, the REASONING should happen locally (mobile already has this data) and only a derived, pre-resolved hint should ever leave the device — never raw history. |
| Account email / name / any PII | **No** | Never needed for one-shot intent classification |
| Precise GPS | **No** | Zipcode is already this app's established granularity everywhere; no reason to send anything finer to a third party |

### How privacy boundaries should work structurally

Recommend a dedicated, explicit **allowlist function** —
`buildLLMContext(sessionContext): SafeLLMContext` — as the only place
that serializes context into the LLM request body. `SafeLLMContext`
should be a narrow, separately-defined type (not just "send the whole
`AssistantSessionContext`"), so that adding a new field to the broader
session context in the future can never accidentally leak into an LLM
payload without a deliberate, reviewed change to this one function. This
mirrors the same "closed vocabulary, deliberate opt-in" philosophy
`IntentType` itself already enforces — consistent with how this
architecture has approached every other boundary so far.

---

## 5. Conversation State

### What "conversation state" means here — and what it deliberately doesn't

Every phase so far has been explicit that `AssistantSessionContext` is
"NOT a conversation log... every field is a snapshot of right-now app
state, re-read fresh each time, never accumulated." Multi-turn
clarification must respect that constraint, not quietly reintroduce a
chat history. The resolution: a **pending clarification is not a
history — it's one bounded, short-lived slot**, closer to a modal
dialog's transient state than a memory feature.

```ts
interface PendingClarification {
  id: string;                    // opaque, session-scoped
  originalText: string;
  partialIntent: Partial<Intent>;
  missingSlot: string;           // e.g. 'query', 'variant'
  askedAt: number;               // for expiration
  turnCount: number;             // bounded — e.g. max 3 follow-ups before giving up
}
```

- **One slot, not a stack.** The app can be mid-clarification for at
  most one intent at a time. A new, unrelated request replaces it; it
  is never queued.
- **In-memory only, never persisted to AsyncStorage.** This is
  transient interaction state, not something a user expects to survive
  an app restart — and persisting it risks resuming a clarification
  against stale app state (e.g. the cart changed since the question was
  asked).
- **Expiration** reuses the exact pattern `dismissalStore.ts` already
  established: a short TTL (recommend 2–5 minutes of inactivity),
  checked on read, opportunistically pruned — not a new mechanism.
- **Restoring sessions:** within the TTL, backgrounding/foregrounding
  the app can resume the pending clarification. Beyond the TTL, or after
  a full relaunch, it's simply gone, and the next input starts a fresh
  top-level resolution. Never attempt to guess what a stale pending
  clarification might have meant.

### Slot-filling mechanics

When a `PendingClarification` exists, new user text should not be
re-classified in isolation — it needs to be merged with the pending
partial intent. Recommend threading an optional `pendingClarification`
field into the `POST /api/assistant/intent` request (minimal: just the
missing slot name and the original text), so the backend can prompt the
model with "the user is answering: which variant?" rather than asking it
to re-classify a bare word like "whole" as a top-level intent.

Prefer **enumerable options over open-ended follow-up questions**
wherever possible (`clarificationOptions` from §2) — "Whole, 2%, Skim,
or Almond?" is both a better UX (voice- and tap-friendly) and far safer
to re-resolve than parsing arbitrary free text a second time.

---

## 6. Retrieval / Grounding Strategy

### The dispatcher remains the only tool gateway — the LLM never calls a service directly

This is the single most important recommendation in this review, and it
should be treated as non-negotiable rather than a tuning choice.

Many agentic-LLM patterns give the model direct "tool calling" access to
functions like search or checkout. **This app must not do that.** The
moment an LLM can invoke `searchRepository.search()` or a cart mutation
as a callable tool, the entire safety architecture from Phases 3.0–3.3
— confidence thresholds, session-context validation, "`dispatchIntent`
is the only place intents cause behavior" — is bypassed by construction.
Prompt-level instructions ("don't call the mutation tool without
asking") are requests, not enforcement, and are exactly the kind of
thing malformed or adversarial input can override.

Instead: **retrieval happens after classification, using the exact same
domain services and dispatcher code that exist today.** The LLM's only
output is inert `Intent` data. The fixed, hand-written mapping from
`Intent.type` to "which service gets called" already lives in
`dispatchIntent`'s switch statement — that mapping is reviewed,
versioned code, not something the model decides at runtime.

This is also the app's strongest built-in hallucination defense: the
LLM runs strictly **before** any real data retrieval. It never sees a
live product, a real price, or real nutrition data — so it structurally
cannot fabricate one. `dispatchNutritionQuestion` still reads the
verified `.nutrition` field off a real search result exactly as it does
today; the LLM only ever decided that the user *asked* a nutrition
question, never what the answer is.

**Rule for future clarification wording that references real data**
(e.g., "did you mean the $3.50 store-brand or the $5.20 organic
option?"): retrieval must happen first, through the existing path, and
only the already-retrieved real values are handed to the LLM to phrase
— never the reverse. Retrieval is never LLM-initiated.

---

## 7. Voice Integration Readiness

### Already works, unchanged

Everything from `Intent` onward: `dispatchIntent`, `intentPolicy`, every
domain service. `assistantService.ts`'s `runAssistant(text, context)` is
already the correct entry point — voice is simply a new way to produce
the `text` string. No changes needed to `runAssistant` itself.

### What needs new abstraction

- **Speech-to-text**: a device-native STT module (e.g.
  `expo-speech-recognition`, per the earlier design notes in
  `docs/ai_grocery_assistant_design.md`) — a new dependency, out of
  scope for this review.
- **Response generation**: today, `AssistantOutcome`/
  `AssistantActionResult` is structured data with **no natural-language
  response step at all** — this has been explicitly out of scope through
  every phase so far. Voice needs an actual spoken reply:
  `AssistantOutcome → response text → TTS`. Recommend starting with a
  small set of **templates per intent-type/success-failure combination**
  (a `formatNutritionResult(data): string`-style pure function, in the
  spirit of this app's existing `formatBudgetLine`/`formatMinutes`
  helpers) rather than an LLM call for phrasing — cheaper, instant, and
  grounded by construction, since it can only ever describe fields
  already present on real response data. An LLM-generated reply is a
  reasonable later upgrade once templates prove too rigid, not a
  starting requirement.
- **A microphone entry point** — new UI, not yet built.

### Latency risks

- The classification call itself (when the LLM tier is hit) is likely
  the dominant cost — the tiered design from §1 directly helps here too:
  simple utterances that resolve via the deterministic router skip both
  the LLM round-trip and its latency.
- Domain service calls (live store scrapers) are an existing latency
  source, unrelated to voice — but voice UX tolerates multi-second
  silence far worse than a typed/tapped spinner does. Recommend
  intermediate spoken feedback ("Let me check that…") for calls likely
  to exceed ~1–2s — a UX concern, not an architecture one, but worth
  flagging now so it isn't a surprise later.
- TTS generation itself adds latency before the user hears anything,
  reinforcing the template-first recommendation above.

---

## 8. Error Handling

| Failure | Behavior |
|---|---|
| LLM unavailable | Fall back to the deterministic rule router (§1's tiered design) — never a hard failure. If that also fails to match, resolve to `unknown`/confidence `0`, identical to today's behavior. |
| Malformed JSON / schema violation | Treated the same as "LLM unavailable" for this request — fall back to rules, log the anomaly (a monitoring signal for prompt/schema drift), never pass unvalidated data downstream. |
| Low confidence | **No new handling needed.** `intentPolicy.ts`'s existing `0.6`/`0.8` thresholds already cover this regardless of which system produced the score. |
| Conflicting intents (rules and LLM disagree, when both are consulted) | Prefer the higher-confidence result; on an exact tie, prefer the deterministic rule result — cheaper, more auditable, zero hallucination risk. |
| Missing context | The LLM should be prompted to lower confidence or set `needsClarification: true` rather than guess — and regardless, `validateSessionContext` remains the real backstop on the mobile side, unchanged. |
| API timeout | A tight, explicit budget (recommend ~2–3s), using the same `AbortController`/`setTimeout` pattern `apiClient.ts`'s `resolveProductImage` already uses — not a new mechanism. On timeout, fall back exactly as "LLM unavailable" does. |

Notably, the existing `AssistantError` taxonomy from Phase 3.3
(`'network_error' | 'unknown_intent' | 'blocked_intent' |
'service_failure'`) already covers every one of these cases without
modification — `network_error` for LLM-unreachable/timeout,
`unknown_intent` for a low-confidence/unresolved result,
`blocked_intent` for policy rejections, `service_failure` for anything
downstream. This is a strong signal the Phase 3.3 design already
anticipated the LLM integration correctly.

---

## 9. Recommended Implementation Roadmap

### Phase 4.0 — AI architecture (this document)
No code. Deliverable: this review, and a go/no-go decision on which LLM
provider and which structured-output mechanism to standardize on.

### Phase 4.1 — LLM intent replacement (hybrid tiered classification)

- **Files affected**: `backend/src/services/intentRouterService.ts`
  (becomes an orchestrator: rules first, LLM on low-confidence/unknown);
  new `backend/src/services/llmClassifierService.ts` (isolated provider
  call + schema validation, injectable for tests); `backend/src/routes/assistant.ts`
  (same contract, now backed by the hybrid resolver); new env
  config for API key/provider; `backend/package.json` — **the first new
  dependency this entire engagement has added** (an LLM provider SDK),
  worth flagging explicitly since every prior sprint has held a strict
  "no new dependencies" line.
- **Risks**: real per-call cost (needs a budget/rate-limit design before
  shipping); latency (§8's timeout+fallback); prompt injection via raw
  `text` (mitigated structurally — the LLM's output is still just inert
  classification data, never a tool-calling agent, per §6); schema drift
  as providers evolve (needs versioned prompts + monitoring); privacy
  (§4's context allowlist must ship *with* this phase, not after).
- **Tests required**: schema validation (malformed responses,
  out-of-enum types, wrong parameter types, nested-object parameters,
  over-long strings); fallback-to-rules tests on every LLM failure mode;
  a fully mocked LLM client in CI (never call a real provider in tests
  — same DI convention used throughout this codebase); confidence-
  clamping tests. Every existing test in `intentRouterService.test.ts`
  must keep passing unchanged — the rule router itself doesn't change,
  it only gains a caller.
- **Do NOT build yet**: clarification conversations, cart mutations,
  voice, response-text generation/TTS.

### Phase 4.2 — Clarification conversations

- **Files affected**: new `src/store/assistantSessionStore.ts` (the
  `PendingClarification` slot from §5); `src/services/assistantService.ts`
  (pending-clarification-aware branching in `runAssistant`);
  `src/models/intent.ts` (`PendingClarification` type); backend
  `assistant.ts`/types (optional `pendingClarification` request field).
  `intentPolicy.ts` likely unchanged — clarification sits upstream of
  policy, not inside it.
- **Risks**: state leaking across unrelated requests (must stay
  one-slot, never a stack); expiration edge cases
  (background/foreground, timezone); a stale pending clarification
  silently swallowing a later, unrelated utterance — needs a clearly
  tested heuristic for "does this new input still answer the pending
  question, or is it a fresh request," ideally validated with a small
  spike before broad rollout.
- **Tests required**: TTL/expiration tests (reuse `dismissalStore.test.ts`'s
  time-mocking style); slot-fill-merge tests; "a new unrelated intent
  clears pending state" tests; a full multi-turn integration test
  exercising this review's own example ("find cheapest" → "milk" →
  "whole").
- **Do NOT build yet**: cart mutations, voice, any AsyncStorage
  persistence of conversation state.

### Phase 4.3 — Safe cart actions

- **Files affected**: `intentPolicy.ts` (new validation: a `productId`
  must match a real, recently-retrieved search result); `assistantDispatcher.ts`
  (real `dispatchAddToCart`/`dispatchRemoveFromCart`/`dispatchSetBudgetTarget`,
  per §3's designs); a new lightweight confirmation surface reusing
  existing product-card components — not a new design system.
  **Open decision to make explicitly at the start of this phase**:
  4.3a (`add_to_cart` stays search-and-present only, human always taps
  the existing cart-add flow — no dispatcher-initiated mutation ever)
  vs. 4.3b (a fuller confirm-then-auto-add flow). Recommend shipping
  4.3a first and evaluating real usage before considering 4.3b.
- **Risks**: this is the highest-risk phase in the roadmap — real,
  possibly irreversible-feeling state mutation driven indirectly by a
  probabilistic classifier. Wrong-item risk, wrong-quantity risk,
  duplicate-add-on-double-confirm risk, budget-mutation risk. Ship
  behind a feature flag, opt-in, with no "don't ask again" escape hatch
  initially.
- **Tests required**: product-resolution-from-real-search tests; a
  security-relevant test explicitly rejecting an LLM-supplied
  `productId` not present in the last real search results;
  confirmation-required-even-at-high-confidence tests for all three
  mutating intents; `remove_from_cart` disambiguation tests (0/1/N
  matches); budget-amount-echo-back tests.
- **Do NOT build yet**: voice — confirmation UX for voice is a
  materially different, harder problem than a button tap, and should
  not block this phase.

### Phase 4.4 — Voice assistant

- **Files affected**: new STT/TTS native modules + `app.json`
  permissions; a new mic-entry-point UI component; new
  `src/services/responseFormatterService.ts` (template-based
  `AssistantOutcome → spoken text`, per §7); `assistantService.ts`
  (optionally threading a "voice session" flag so response formatting
  knows to produce speakable text).
- **Risks**: latency (§7); interruption handling (e.g. a phone call
  mid-command); two stacked probabilistic stages (STT errors compounding
  with intent-classification uncertainty) likely warranting stricter
  confidence handling specifically for voice-sourced text; the Phase 4.3
  confirmation UX needs a genuinely voice-native equivalent (spoken
  confirmation, not a repurposed button) — real design work, not just
  wiring.
- **Tests required**: STT-mock-driven integration tests (fake
  transcripts, same DI pattern as everything else in this codebase);
  response-formatter unit tests per intent/outcome combination. Real
  STT/TTS accuracy cannot be meaningfully tested in CI — flag this
  explicitly as a manual/device-testing requirement, matching this
  repo's existing practice of saying so plainly rather than claiming
  false coverage.
- **Do NOT build yet**: always-listening/wake-word behavior; persisting
  voice transcripts beyond a single request (violates the "no history"
  principle already established); skipping Phase 4.3's confirmation step
  just because voice makes typing/tapping inconvenient — the safety bar
  must not drop for voice.
