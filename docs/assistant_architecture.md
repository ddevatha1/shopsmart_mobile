# CartIQ Assistant Architecture

Status as of Phase 3.3 (Assistant Transport + End-to-End Boundary). This
document describes the deterministic pipeline built across Phases
3.0–3.3 — the stable contract every future voice/text/camera feature
plugs into. **No LLM, voice, speech recognition, camera, or chat UI
exists yet.** Everything described here is real, tested, deterministic
code with zero AI involved — the point of building it this way was to
prove the entire boundary compiles and behaves safely *before* any AI
spend, so a future classifier only ever has to slot into one seam
(`resolveIntent`) rather than requiring a redesign of everything
downstream of it.

## The pipeline

```
Input Sources (future: voice / typed text / camera-derived commands)
        |
        v
Intent Resolution        (backend, classification ONLY)
   backend/src/services/intentRouterService.ts — resolveIntent(text)
   backend/src/routes/assistant.ts — POST /api/assistant/intent
        |
        v
Safety Policy             (mobile, execution gate)
   src/services/intentPolicy.ts — evaluateIntent() + validateSessionContext()
        |
        v
Dispatcher                (mobile, the only place an Intent can act)
   src/services/assistantDispatcher.ts — dispatchIntent()
        |
        v
Existing Domain Services  (never duplicated, never bypassed)
   searchRepository / plannerService / comparisonService / ...
        |
        v
Verified Data
   AssistantActionResult / AssistantOutcome — real service output only,
   never fabricated, never estimated
```

`src/services/assistantService.ts`'s `runAssistant(text, context)` is the
single function that walks this whole pipeline end to end:
`resolveAssistantIntent()` (network call to the backend) →
`dispatchIntent()` (policy + execution, entirely on-device) →
`AssistantOutcome`. It is the intended entry point for every future
input source — a voice transcript, typed text, or a camera-derived
command all funnel through the exact same function, with the exact same
safety guarantees, differing only in how they produce the `text` string
in the first place.

## Why the backend does classification only

`POST /api/assistant/intent` (`backend/src/routes/assistant.ts`) takes
`{ text, context? }` and returns `{ intent: Intent }` — nothing else. It
never searches, never touches a cart, never calls the planner, never
generates a response. This split is deliberate, not incidental:

- **A network boundary is the wrong place to enforce safety.** Confidence
  thresholds and session-context checks (see below) need to react to
  *live, on-device* state — the shopper's actual current cart, actual
  current screen — at the exact moment of dispatch. Round-tripping that
  state to the backend and back would mean either sending sensitive live
  state over the network unnecessarily, or trusting a stale snapshot.
- **It keeps the closed-vocabulary guarantee enforceable in one place.**
  `IntentType` is a fixed, reviewed set (see `src/models/intent.ts`) —
  the backend's only job is picking one of those values; deciding
  whether that value is *safe to act on right now* is a separate
  question the backend has no way to answer correctly from a stateless
  HTTP request.
- **It makes the backend replaceable without touching safety.** The
  entire backend classification step — today a deterministic keyword
  router, someday possibly an LLM — can be swapped without any change to
  the mobile safety/dispatch code, because the boundary between them is
  exactly `Intent` (see `docs/CartIQ_ai_implementation_roadmap.md`'s
  Phase 0 rationale). A classifier that gets *more* uncertain (lower,
  noisier confidence scores) is handled by policy thresholds that
  already exist — no new code path needed.

## Why mobile owns execution policy

Every safety decision — is this confident enough, does the app have the
context this action needs — happens in `src/services/intentPolicy.ts`
and is enforced inside `dispatchIntent()`, never in the backend route
and never skipped by `assistantService.ts`:

1. **`evaluateIntent(intent)`** — a universal confidence floor (0.6,
   below which nothing executes regardless of type) and a higher bar
   (0.8) for intents that mutate cart/account state. Intents not
   explicitly reviewed as safe or mutating are blocked by default, never
   defaulted to allowed.
2. **`validateSessionContext(intent, context)`** — even a confident
   intent doesn't execute without the real context it needs (e.g.
   `optimize_cart` requires a non-empty cart in the current session).

Both gates run, in that order, *inside* `dispatchIntent()` before any
service call — this is enforced structurally, not by convention:
`assistantService.ts`'s `runAssistant` calls `dispatchIntent()` directly
and never has its own separate path to a domain service. The backend
returning an `Intent` never bypasses either gate; there is no code path
from "the network response arrived" to "a service executed" that
doesn't pass through both checks first.

## Why cart mutations remain blocked

`add_to_cart`, `remove_from_cart`, and `set_budget_target` are
classifiable (the router resolves them, the policy layer would allow
them at high confidence) but still return `success: false` from the
dispatcher. This isn't a missing feature so much as an unmade decision,
left unmade on purpose:

- A free-text product name (e.g. "milk" from "add milk to cart") is
  **not** a verified product. Real search results for "milk" return
  multiple matches — different brands, sizes, stores — and nothing in
  this pipeline specifies which one an intent-driven action should act
  on.
- Silently picking one (cheapest? first? most relevant?) would mean the
  dispatcher inventing a product-selection policy nobody has reviewed,
  then using it to mutate a real cart. That is exactly the "never invent
  results" rule this whole boundary exists to enforce, violated at the
  one point (an actual state mutation) where it matters most.
- `validateSessionContext` already requires either a resolved
  `parameters.productId` or active search context before even
  considering `add_to_cart` — the seam a real implementation will use
  once a product-resolution policy is deliberately designed. That
  design work hasn't happened yet.

## What's real vs. what's still a contract

Executable today, through `dispatchIntent()`: `search`, `optimize_cart`,
`open_planner` (a navigation *instruction* only — see
`PlannerAction`), `nutrition_question` (real Open Food Facts data via
the same search path, never estimated), `compare_options` (a thin
adapter over `comparisonService.ts`'s existing best-value ranking, not a
new comparison engine). `meal_plan` returns an honest, permanent
`meal_plan_not_available` — not a temporary placeholder standing in for
generation logic that doesn't exist. `add_to_cart`, `remove_from_cart`,
and `set_budget_target` are classifiable but return an explicit
"not implemented yet" — see above.

## What Phase 3.3 specifically added

- `backend/src/routes/assistant.ts` — `POST /api/assistant/intent`
- `src/services/assistantRepository.ts` — the one place that calls it
- `src/services/assistantService.ts` — `runAssistant()`, the end-to-end
  orchestration entry point, with an explicit `AssistantError` taxonomy
  (`network_error` / `unknown_intent` / `blocked_intent` /
  `service_failure`) so a future caller never has to parse raw error
  text or catch a raw exception.

Nothing about `intentPolicy.ts` or `assistantDispatcher.ts` changed —
Phase 3.3 is purely transport and orchestration around the safety
boundary Phases 3.1/3.2 already built and tested.
