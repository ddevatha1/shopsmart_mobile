# Phase 5 Architecture & Product Review — CartIQ Assistant

**Status: review and roadmap only. No code changes in this document.**

This reviews the completed Assistant Foundation (Phases 3.0–4.4) as a
whole — closed intent contract, safety layer, capability wiring,
transport, hybrid classification, clarification, safe cart actions,
voice — and recommends what to build next. The verdict up front: **the
architecture is sound and should not be touched structurally.** Every
gap identified below is a *content* or *reach* gap (what the assistant
can talk about, and whether anyone can talk to it at all), not a
*safety* or *design* gap. Phase 5 should add capability through the
exact same pattern every prior phase used — a new or upgraded
`dispatchX` function behind the same unchanged dispatcher — not through
any new kind of boundary.

---

## 1. Current Assistant Capability Map

One finding applies to every row below and is worth stating once,
prominently, rather than repeating ten times: **every intent's status
here describes the service/orchestration layer only. No screen, button,
or voice entry point in this app calls `runAssistant` anywhere.** The
entire pipeline is real, tested, and reachable only from test code. This
is the single most consequential fact in this review, and it reframes
almost everything in §2.

| Intent | Status | Current UX (if reached) | Missing before production |
|---|---|---|---|
| `search` | Fully usable | Real results, no confirmation needed | No UI entry point; generic response text doesn't scale to many results (bad for voice) |
| `optimize_cart` | Fully usable, but incomplete | Returns a real computed plan; **never applies it** — no "apply this plan" follow-up exists | An apply-plan confirmation flow (Phase 4.3's own pattern, not yet extended here); response text omits the actual savings number, losing the point of asking |
| `add_to_cart` | Partially usable | Real resolve → select → confirm → mutate state machine works end-to-end | No UI; one item per turn only ("add milk and eggs" unsupported); candidate matching is crude word-overlap; no quantity support |
| `remove_from_cart` | Partially usable | Resolves against real cart contents, same confirm-before-mutate flow | Same UI gap; **always removes the full line item** — "remove one" when qty=3 removes all 3, a real correctness gap worth fixing before this ships anywhere |
| `compare_options` | Fully usable | Real best-value verdict via existing comparisonService | No UI; only ever names one winner, never the fuller comparison a shopper might want; no explanation of the math |
| `open_planner` | Fully usable, trivially | Returns `{action:'open_planner'}` | Literally nothing consumes this signal — it currently does nothing observable |
| `set_budget_target` | Intentionally blocked | "Not implemented yet" | The entire safe-confirmation design (parse amount → echo back → confirm → mutate) that every cart action already has — deferred every phase so far |
| `meal_plan` | Placeholder | Honest, permanent `meal_plan_not_available` | Actual generation logic — see §4, this is the flagship candidate |
| `nutrition_question` | Fully usable | Real per-100g Open Food Facts data, honest failure otherwise | No UI; real coverage gaps (many live SKUs have no OFF match) will surface as frequent honest failures that may still *feel* broken to a user |
| `unknown` | Working as designed | "I didn't understand" / rephrase prompt | Not a gap in itself, but note: with the LLM tier never exercised against a real provider (Phase 4.1 built the seam, no key has ever been set), almost anything outside exact keyword matches resolves here **today** |

---

## 2. Biggest Product Gaps (ranked by user impact)

Engineering completeness was explicitly out of scope for this ranking —
these are the reasons a real shopper would not feel like they're talking
to a grocery AI assistant, even if every service above is fully
functional.

1. **There is no way to reach it.** Restated from §1 because it
   dominates every other ranking: zero UI or voice surface calls
   `runAssistant`. Every other gap is moot until this is fixed.
2. **No conversational memory across sessions.** Close the app, or wait
   the 3-minute TTL, and every piece of pending state is gone — the
   assistant never remembers *anything* said five minutes ago, let alone
   yesterday.
3. **No personalized preferences / no learning from corrections.**
   Every "which one did you mean?" starts from zero, forever — an
   assistant that doesn't get easier to use over time isn't really
   assisting.
4. **Pantry intelligence exists but isn't connected.** This is the most
   striking finding in this review: `inventoryEstimationService.ts` and
   the `low_stock` Advisor insight (Phase 2.5) already compute "what are
   you probably running low on" — today, asking the assistant that
   question resolves to `unknown`, even though the app already knows the
   answer elsewhere on screen.
5. **No meal planning.** One of the single most natural things to ask a
   grocery assistant, and it's a hard-coded "not available."
6. **No multi-item, multi-turn shopping list workflows.** "Add milk,
   eggs, and bread" isn't supported — one item per turn, despite the
   Smart Shopping Planner already handling full lists just fine outside
   the assistant.
7. **No proactive suggestions.** The Advisor system already surfaces
   deals, budget warnings, and pantry reminders on-screen unprompted —
   the assistant never initiates anything; it only ever answers.
8. **No explanation of recommendations.** "X is the best value" with no
   visible reasoning is a harder thing to trust than a shopper's own
   quick mental math — this matters more for a grocery budget than most
   domains.
9. **No voice UI, despite a fully built voice service.** Same shape as
   gap #1, specific to voice — the entire STT/TTS boundary exists with
   no microphone button, no permission flow, nothing to trigger it.
10. **No budget-setting through the assistant.** Undercuts the
    "help me save money" pitch directly — a shopper can't even tell it
    their budget without leaving the assistant entirely.

---

## 3. Ideal Assistant UX — Worked Example

**"Help me save money this week"** deliberately doesn't map cleanly onto
any single existing intent — that's real, useful signal, not a flaw in
this example. Below is how it plays out with today's architecture
*exactly as built*, annotated with where a Phase 5 addition would smooth
a seam.

```
User (voice or text): "Help me save money this week"
  → resolveHybridIntent(): no exact keyword match today; a live LLM
    tier would likely land near optimize_cart or budget-related, but
    at best moderate confidence for a compound request like this.
  → clarificationPolicy: confidence/ambiguity → clarification.

Assistant (spoken + on-screen): "I can optimize your current cart, or
help you set a budget for the week — which would you like?"
  [conversational state: clarification]

User: "Optimize my cart"
  → Re-classified: optimize_cart, high confidence.
  → dispatchIntent → real evaluateIntent/validateSessionContext gates
    → dispatchOptimizeCart → real ShoppingPlanResponse.

Assistant (spoken): "Splitting your list between Kroger and Aldi saves
you about $12 and adds 8 minutes of driving. Want to see the plan?"
  [conversational state: result — a card renders the full store/item
   breakdown; voice gives the ONE-SENTENCE summary, never reads every
   line item aloud]

User: "Yes, and can I also compare the milk?"
  → compare_options, real query extracted, read-only, no confirmation
    needed.

Assistant (spoken): "The best value is Kroger's store brand at $3.20."
  [a card shows the fuller comparison; voice stays to one sentence]

User: "Add that one"
  → add_to_cart. Since a specific product was JUST shown on a card
    (the exact "recent search/product context" validateSessionContext
    already requires), this should resolve directly to a single
    candidate — no "which one?" needed, since context already narrowed
    it. → confirmation_required.

Assistant (spoken): "Add Kroger Whole Milk, one gallon, for $3.20?"
  [conversational state: confirmation — a card shows the exact product]

User: "Yes"
  → Re-enters through dispatchIntent exactly as Phase 4.3 built it →
    real cartStore.addToCart → success.

Assistant (spoken): "Added. Anything else?"
  [conversational state: idle, ready for the next turn]
```

**State/UI rules this example makes concrete:**
- **Clarification** appears whenever confidence is low OR a compound/
  ambiguous request maps to more than one plausible intent — never a
  silent guess.
- **Confirmation** appears immediately before, and only before, any real
  state mutation — never for a read-only intent (search, compare,
  nutrition).
- **Cards** appear whenever `data` carries something visual (a plan, a
  comparison, a product) — voice gives the one-sentence takeaway, the
  card gives the detail. This is a real, currently-missing rule:
  today's `assistantResponseService.ts` has no length-awareness at all.
- **Navigation** only ever happens from an explicit instruction
  (`PlannerAction`-style), and only ever performed by the UI layer —
  never the dispatcher, unchanged from Phase 3.2's original rule.
- **Voice responses** happen once per turn, after the outcome is fully
  resolved — never mid-processing, never narrating intermediate steps.

---

## 4. The Phase 5 Flagship Feature

### Candidates evaluated

| Candidate | User value | Differentiation | Architecture fit | Risk |
|---|---|---|---|---|
| **A. Conversational Grocery Planner** | High | High — few grocery-comparison apps do integrated meal+budget planning | Excellent — reuses `buildShoppingPlan`, `budgetAnalysisService`, `parseListInput`/`analyzeItems` almost untouched | Low–moderate |
| B. Autonomous Shopping Assistant | High in theory | Moderate — mostly "chain existing intents" without new content underneath | Poor — depends on A or C existing first; directly pressures the per-item confirmation model to loosen | **High** |
| C. Smart Pantry Intelligence | Moderate–high | Moderate — useful, not a headline | Excellent — the data already exists (Phase 2.5); nearly pure wiring | Very low |
| D. Personal Grocery Memory | High, long-term | Moderate — valuable but invisible, hard to demo | Moderate — needs its own new safety design (a stored belief silently biasing later turns is a genuinely new failure class this architecture hasn't had to handle yet) | Moderate |
| E. Voice Grocery Assistant | Low today | High ceiling, low near-term | Foundation exists, but this candidate is fundamentally UI/permissions work — a scope-type shift this engagement hasn't done | Moderate–high (UX risk, not safety risk) |

### Decision: **A — Conversational Grocery Planner**

Highest value, strongest differentiation, and — decisively — the best
architecture fit of any candidate: `meal_plan` **already exists** in the
closed `IntentType` vocabulary, is **already** in `intentPolicy.ts`'s
safe bucket, and the backend router **already** has keywords for it.
Phase 5's safest possible shape is "replace one placeholder function,"
not "add new surface area to the closed vocabulary." The generative part
(suggesting meals) has a small, bounded hallucination surface — a bad
suggestion is a bad ingredient search, the same low-consequence failure
mode every intent already has — because it never touches the cart or a
price on its own; every ingredient still re-enters the exact same
untrusted-free-text pipeline `add_to_cart` already built and proved in
Phase 4.3.

Recommend bundling **C (pantry intelligence wiring)** as a small,
nearly-free companion in the same phase — the data already exists, the
integration is pure wiring, and it directly complements meal planning
("you're low on milk — include it in tonight's plan?").

### Why the others wait

- **B** has no independent content — it's a UX wrapper over A/C that
  doesn't exist yet, and its "autonomous" framing pulls directly against
  the confirmation-per-mutation model this entire engagement was built
  to defend. Revisit only after A/C ship and only if user data shows
  per-item confirmation is genuinely the friction point (not assumed).
- **D** needs a dedicated safety-design phase of its own before it's
  safe to build at all — this architecture has never had to reason
  about a *stored* fact silently influencing a *later, unrelated* turn,
  and rushing that design under flagship-feature time pressure is
  exactly how a real gap gets introduced.
- **E** has nothing compelling to say yet (§1/§2) and represents the
  first real UI/permissions scope this engagement has taken on — better
  attempted after A gives voice actual content worth the investment.

---

## 5. Architecture Changes for the Conversational Grocery Planner

**New `IntentType` members needed: none.** This is the headline
architectural fact of this section.

- **New service**: `mealPlanGenerationService.ts` — recommend starting
  with a small, curated, deterministic recipe/template set (20–30
  hand-authored templates keyed by cuisine/dietary tag/day-count,
  matching `groceryTaxonomy.ts`'s own existing static-data convention)
  rather than a live LLM call. This keeps the *AI flagship feature*
  introducing **zero new AI risk** for v1. A real LLM-backed version is
  a clearly-scoped later upgrade, reusing Phase 4.1's already-built
  plain-fetch, no-SDK, strict-validation pattern for a new purpose
  (generation, not classification) — not a new boundary.
- **New service**: a small adapter converting a chosen meal plan's
  ingredient list into `PlannerListItem[]`, reusing `parseListInput`/
  `analyzeItems` completely unchanged.
- **New model**: `MealPlanResult` (`action: 'meal_plan_result'`, a list
  of `{ name, ingredients }`, an estimated item count) — extends
  `AssistantData`, following the exact discriminated-union pattern every
  prior phase already established.
- **Backend changes**: **none**, if the curated-template path is chosen.
  If the LLM path is chosen instead: one new endpoint mirroring
  `/api/assistant/intent`'s exact shape (classify/generate-only, mobile
  owns everything downstream) — same layering, new purpose.
- **Mobile changes**: `dispatchMealPlan` gets a real implementation:
  generate meals → convert to a draft list → return `MealPlanResult` as
  a **suggestion** → a new, lightweight confirmation step (reusing
  Phase 4.3's `PendingCartMutationConfirmation`-style pattern, likely a
  new `PendingMealPlanAcceptance`) before the draft ever reaches the
  real planner.
- **Storage**: **none required for v1** — curated templates are static,
  in-repo data, same as `groceryTaxonomy.ts`.
- **API endpoints**: none for the template path; one, if the LLM path is
  chosen, following `/api/assistant/intent`'s established shape exactly.
- **Testing requirements**: template-selection determinism; ingredient
  → real-product resolution (reusing `resolveProductRequest`'s existing
  test patterns verbatim); budget-constraint checks that call the
  *existing* `budgetAnalysisService` rather than a new ad hoc check; and
  a safety test proving meal-plan-sourced items go through the
  **identical** add-to-cart confirmation flow as any manually typed item
  — no shortcut, no bulk-add bypass.

---

## 6. Safety Review

**What still requires confirmation**: any new mutation this feature
introduces (applying a generated list to the cart) must reuse the exact
Phase 4.3 confirm-before-mutate pattern — never a bulk "add everything"
without itemized visibility. `set_budget_target`, whenever it's finally
unblocked. Any future "apply this optimized plan" action (doesn't exist
yet).

**What should never be trusted from an LLM** (if/when the generation
path uses one): product IDs (unchanged since Phase 4.1/4.3), **prices**
— a generated plan must never claim a price, only real search results
may — **nutrition claims** — defer entirely to the existing, real
`nutrition_question` pipeline, never let generation assert a nutrition
fact — and the ingredient list itself, which must be treated as a query
suggestion only, re-entering the same untrusted-free-text pipeline every
other intent's `item`/`query` already goes through.

**What should remain read-only**: meal plan *generation* itself. It
never touches the cart until a human explicitly converts one specific,
accepted plan into a shopping list — and even then, items still require
the same per-item (or an explicitly and separately reviewed bulk)
confirmation everything else requires today.

**What personalization data is acceptable to store**: for this
feature specifically, **none is required** — "under $100" and "my
family" can be taken as explicit per-request parameters, never
remembered between sessions, which sidesteps the entire Candidate-D
memory question for now. If household size/dietary tags are ever
persisted later, they're a plausible, low-risk addition (similar
sensitivity to the zipcode this app already stores) — but that's a
deliberate, separate decision, not a side effect of shipping meal
planning.

---

## 7. Production Readiness Checklist

**Before public beta:**
- [ ] A real UI or voice entry point exists that calls `runAssistant` (today: none exist)
- [ ] Response text for every intent has been read by a human, not just unit-tested
- [ ] Rate limiting / cost controls are in place for the LLM tier before any real API key is ever set
- [ ] The context-privacy allowlist from the Phase 4.0 design review is actually implemented (still only a recommendation)
- [ ] Product-resolution UX (word-overlap candidate matching) has been usability-tested with real users, not just unit-tested
- [ ] Failure/error copy has had a product-tone pass, not just an engineering-safe one
- [ ] `remove_from_cart`'s full-line-item-removal behavior (vs. quantity-aware removal) is either fixed or explicitly accepted

**Before adding more AI:**
- [ ] The Phase 4.1 hybrid classifier has been run against a real provider at least once (today: never)
- [ ] Confidence calibration has been measured against real traffic, not assumed
- [ ] A conflict/precedence policy exists for when structured data (e.g. a stated budget) contradicts a generated suggestion
- [ ] Any new generative surface (meal plans or otherwise) has its own strict output-validation layer, mirroring `intentClassifierValidation.ts`'s discipline exactly

**Before voice launch:**
- [ ] A real microphone/permissions UI exists (today: none)
- [ ] Response text has been re-audited specifically for spoken length — some responses (e.g. many search results) are unfit to read aloud verbatim as-is
- [ ] A real STT/TTS provider has been integrated and tested for accuracy and latency
- [ ] Voice-specific confirmation UX has been designed — today's yes/no parsing is a text-first design, not tuned for interruption or ambient noise
- [ ] An accessibility review has been done — voice should be evaluated as an accessibility feature, not only a novelty

---

## Constraints honored in this review

- **No dispatcher redesign recommended anywhere in this document.**
  `dispatchIntent` remains the only path from intent to action in every
  scenario above, including the flagship feature.
- **No unrestricted tool-calling introduced.** The flagship's generative
  step produces free text only, re-validated and re-resolved through
  the exact same untrusted-input pipeline every existing intent uses.
- **No assumption that the assistant can directly mutate state.** Every
  new mutation path described above is confirm-then-dispatch, matching
  Phase 4.3 exactly.
- **Every recommendation is additive** — a new dispatch function, a new
  `AssistantData` member, at most one new pending-state type. Nothing
  above requires rewriting `assistantService.ts`, `intentPolicy.ts`, or
  `assistantDispatcher.ts`'s existing behavior.
