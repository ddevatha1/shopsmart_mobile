# Architecture Review — `CartIQ_ai_architecture.md`

This review fact-checked the master architecture against the actual
`backend/src/` code (the prior three docs were written mostly from
`src/` research; the backend planner/optimizer logic, LLM usage, and the
Open Food Facts integration had not been directly inspected before this
review). Several findings below **correct** claims in the prior docs, not
just confirm them — flagged explicitly where that happens.

---

## 1. Compatibility with the existing codebase

| Assumption in the architecture doc | Reality | Verdict |
| --- | --- | --- |
| "PlanWeights-shaped scoring" produces the four plan candidates | **Wrong as stated.** `shoppingPlanOptimizer.ts`'s `selectCandidates()` only runs `scorePlan(plan, ranges, weights)` for **`balanced`**. `cheapest`, `fastest`, and `fewestStops` are hardcoded single/tie-broken-field sorts (`totalCost`, then `totalDriveMinutes`, then `storeCount` respectively) — no weights involved. | **Correct before building on it** — §2 below |
| Adding a new optimization dimension is "extend the mode selector" | Extending the *UI* is trivial; extending the *backend* means writing one more hardcoded sort branch (cheap, matches existing convention) **and/or** editing `scorePlan()`'s hand-written weighted sum if it should also affect Balanced. Not a generic `Record<string, number>` weight system today. | Design implication in §6 |
| `AdvisorCard.tsx` renders "identically" across insight kinds, "no kind-specific branching" | **Overstated.** `KIND_META[insight.kind]` varies icon/color per kind; `insight.detail`, `insight.product`, `insight.actions`, and the caller-supplied `primaryAction` each independently gate a piece of the render. The *skeleton* (icon + title + one detail line + one action row) is shared; the *content* genuinely varies by kind and by what data is present. | Correction — §5 |
| `substitutionService` is "narrowly scoped to the same search response" | True for `SearchScreen`/`CompareScreen`. **`CartScreen.tsx:161` passes `allProducts: []`** — substitution is silently dead (always returns `null`) when reached from the Cart's "See product" path, not just narrow. This is an existing bug, not a design nuance. | **Fix as part of Phase 1**, not a new discovery to design around |
| Extending Open Food Facts for nutrition data needs "a separate integration" | **Likely wrong, in the encouraging direction.** `backend/src/routes/productImage.ts`'s Open Food Facts call has no `fields=` parameter, so the full product record — including `nutriments`/`ingredients_text` — is plausibly already arriving in the HTTP response; the code just doesn't parse it (`OpenFoodFactsProduct` only types 4 fields). Needs one live `curl` to confirm, but if true, this is "widen a TypeScript interface," not "add an integration." | **Re-scope Phase 2's biggest line item** — §6 |
| Store hours/reliability data doesn't exist yet | Confirmed, and stronger than assumed: the optimizer's own header comment states this is a **deliberate non-goal** ("no real data source... exists"), and `PlanResultsView.tsx` already discloses this absence to the user in-app. Adding hours data means also **removing/updating that disclosure copy**. | Add to Phase 0/1 scope |
| Backend has no LLM anywhere | Confirmed absolutely — no AI SDK in `backend/package.json`, no LLM API calls anywhere in `backend/src`. Every new AI touchpoint (voice, meal planner, nutrition, quality) is genuinely greenfield backend infrastructure. | Confirmed, no correction |
| None of the 6 production stores use the Playwright browser framework | Confirmed via explicit code comment in `BrowserAdapter.ts`: *"Existing production stores... are untouched — none of them call this."* | Confirmed |
| Purchase history is single-device, AsyncStorage-only | Confirmed — zero backend route reads/writes purchase history. | Confirmed, flagged again in §2 |

**Bottom line for §1**: the architecture doc's high-level shape is sound,
but two of its concrete "this already exists to build on" claims
(uniform weighted scoring, uniform advisor-card rendering) overstated how
uniform the existing code actually is, and one dependency (Open Food
Facts) was underestimated in the *helpful* direction. All three change
what Phase 0/1/2 should actually contain, not the five-layer shape itself.

---

## 2. Architecture weaknesses

1. **Hallucination surface in voice reply generation is underspecified.**
   The prior doc says replies are "built from the real result," but never
   states *how* — if an LLM paraphrases structured data into a sentence
   ("ALDI has the lowest price..."), a paraphrase can still misstate a
   number, swap a store name, or add an unsupported claim ("...and it's
   organic!") that wasn't in the source data. **Fix**: either template the
   reply (fill named slots from verified data, no LLM in that specific
   step) or require a post-generation validation pass that every price/
   store-name/quantity mentioned is checked against the source object
   before the reply is spoken. This needs to be a stated rule, not an
   implicit property of "using real data."

2. **Nutrition math boundary was implied, not enforced.** "Gap analysis
   against goals" could mean either "code sums real `nutriments` fields
   and an LLM explains the gap in words" (safe) or "an LLM estimates
   macros from a list of item names" (unsafe — this is the single highest-
   stakes hallucination risk in the entire feature set, because a wrong
   protein number reaches someone making a real dietary decision). **Fix**:
   make this an explicit, named rule (§4, §8-D) — the arithmetic must be
   deterministic over canonical nutrition data; the LLM's only job is
   phrasing the already-computed gap.

3. **Client/server data-ownership boundary for personalization context is
   unresolved.** Purchase history lives only on-device (§1). Once
   Generators (meal planner, nutrition, voice intent) run server-side —
   which they must, since that's where the LLM lives — they have no way
   to know "this shopper usually buys high-protein items" unless the
   client explicitly ships that context up per request. The architecture
   doc names this as a known limitation in passing but doesn't resolve
   *how* server-side generators get personalization signal at all today.
   **Fix**: make it an explicit rule — server-side generators receive
   personalization as a small, explicit, stateless payload attached to
   each request (e.g. `{ organicAffinity, frequentBrands }` computed
   client-side, already exists as `PersonalizationProfile`), never a
   server-side lookup — and state plainly that this means personalization
   context is only as fresh/complete as what the client bothers to send.

4. **Mode additions couple mobile and backend releases.** `PlanCandidateId`
   is a closed union duplicated on both sides with no version negotiation.
   Adding a `healthiest` candidate requires shipping mobile and backend
   changes in a coordinated way; an old mobile build seeing a new
   candidate id it doesn't recognize, or a new mobile build asking a
   not-yet-updated backend for a mode it doesn't have, are both real
   failure modes with zero handling designed today. **Fix**: mobile must
   treat unrecognized `PlanCandidateId`s as safe-to-ignore (not a crash),
   and backend must ignore/gracefully degrade a mode request it doesn't
   yet support (fall back to `balanced`), stated as an explicit
   forward-compatibility rule before any new mode ships.

5. **"Intent Router" is really two different things wearing one name.**
   Internal, closed-vocabulary triggers (cart changed, time elapsed,
   location updated) don't need an LLM — `advisorService` already proves
   this can be done with plain deterministic code today. Only genuinely
   freeform input (voice/typed natural language) needs an LLM-backed
   classifier. The architecture doc's single "Intent & Orchestration
   Layer" box blurs this into one component. **Fix**: name these as two
   distinct pieces sharing one output contract — a **deterministic,
   client-side trigger dispatcher** (extends `advisorService`, no model,
   no network) and an **LLM-backed freeform classifier** (server-side, new)
   — both resolving into the same closed action vocabulary and the same
   Layer 4 queue, but built, tested, and reasoned about separately, since
   one has zero AI-safety surface and the other has all of it.

6. **Nutrition Assistant risks scope-creeping into a nutrition-tracking
   app if "conversation depth" isn't bounded.** Multi-turn nutrition
   conversation, taken literally, drifts toward persistent goals/history/
   tracking — exactly the "feels like a nutrition app" failure mode §5
   below is checking for. Needs a hard scope line (§5, §8-D).

7. **Three user-facing "budget types" is more choice than the feature
   needs**, and risks becoming a mini-settings-screen ("what kind of
   budget do you have?") that contradicts "minimal user effort." Detailed
   simplification in §5.

---

## 3. Data model review

| Model | Why it exists | Required | Optional | Complexity guard |
| --- | --- | --- | --- | --- |
| **Canonical Product** | One product identity that price comparison, meal planning, and nutrition all resolve against — without it, three features independently guess whether "milk" and "Milk 1gal" are the same thing | `canonicalId`, `headNoun`, `baseUnit`+`baseUnitQuantity` | `variantFlags`, `category`, `nutritionRef` | Deliberately identity-only — no description/images/reviews here; those stay owned by the per-store `ApiProduct` listing. Don't let this become a second product catalog. |
| **Nutrition attributes** | Needed for health/protein optimization modes and the Nutrition Assistant | `caloriesPerServing`, `proteinG` | `fatG`, `carbsG`, `fiberG`, `sugarG`, `sodiumMg`, `nutriScore`, micronutrients | Must degrade to `unknown` gracefully — most real-world entries (especially store-brand/regional items) won't have complete data; a feature that *requires* full data will silently exclude half the catalog |
| **User preferences** | Personalization signal for ranking/substitution/nutrition-goal framing | *(none new required)* | one new optional field: a dietary-goal hint (e.g. "general" / "high-protein" / "reduce sugar") | **Do not build a new "UserPreferences" model.** Reuse `User` (zipcode, weeklyBudget) + the already-existing derived `PersonalizationProfile` + `plannerPreferenceService`'s remembered choices. One new optional string-ish field on `User` is the entire net-new surface needed. |
| **Budget constraint** | Lets the optimizer and Advisor layer reason about "how much is too much" regardless of which of the three budget flavors produced it | `amount` | `cadence` (weekly/biweekly/monthly, on the *standing* budget), a separate **ephemeral, non-persisted** per-trip override | See §5 — do not expose this as a "budget type" choice in UI |
| **Inventory estimate** | Lets pantry/food-waste features reason about "probably running low" without ever asking the user to enter a count | `normalizedName`, `estimatedRemaining` (3-state: plenty/running-low/likely-out), `confidence`, `basis` | none | **Derived/compute-on-read only, never the source of truth and never a browsable list** — purchase history remains the one real record; this is a view over it, disposable and recomputable, not a table the user (or even the app) treats as authoritative |
| **Store availability/hours** | The one hard correctness requirement — never route someone to a closed store | `storeLocationId`, regular weekly open/close hours | holiday-exception overrides | **Ship weekly hours only for v1.** Holiday-specific closures are a small fraction of the value and a real ongoing data-maintenance burden — don't block "never recommend a closed store" on solving the holiday calendar problem too |
| **Optimization goals** | The seven (see §5 — really five or six) mode labels the user picks from | *(none new)* | *(none new)* | **This is `PlanCandidateId`, extended — not a new model.** Introducing a parallel "OptimizationGoals" type alongside the existing enum would be the exact kind of duplicated-truth this review is trying to prevent |
| **AI-generated shopping list** | The Meal Planner's (and any future generator's) output | *(none new)* | a transient, non-persisted provenance tag for display only (e.g. "Generated from: beef and broccoli") | **This must not be a new model at all.** The output is `CartItem[]`/`PlannerListItem[]` — identical to a manually typed list. The provenance tag exists only long enough to show where the suggestion came from before the user commits it; once added to the cart, it is indistinguishable from anything else in it. A distinct "AI list" entity would directly contradict "the AI is not the source of truth." |

Net: of the eight requested, **only three are genuinely new models**
(Canonical Product, Nutrition Attributes, Store Hours) at the size
described. The other five are correctly served by extending something
that already exists — building them as new, separate models would be the
"unnecessary complexity" this section was explicitly checking for.

---

## 4. AI boundary review

| Feature | Where AI's authority ends | Verdict |
| --- | --- | --- |
| **Voice assistant** | LLM classifies intent + extracts slots only; execution is 100% existing deterministic services; **reply generation is the one open risk** (§2.1) — needs templating or a post-generation fact-check pass, not assumed-safe | Needs one more explicit rule before build |
| **Meal planner** | LLM may invent a recipe/ingredient list; it may **never** state a price, a store, or availability for any ingredient — those facts only exist once the generated list runs through real search | Correctly bounded already; state as a hard rule (§8-D) |
| **Nutrition assistant** | LLM may **never** compute a calorie/macro number itself; all sums/percentages must be deterministic arithmetic over canonical nutrition data; LLM's only job is phrasing the gap explanation on top of numbers already computed and verifiable | **Biggest gap found in this review** — this was implied, not enforced, in the prior doc. Must become an explicit rule, not an assumption. |
| **Quality assessment** | Already correctly bounded (hedged language, no bare safety claims — `ai_grocery_assistant_design.md` §2.3). One addition: the verdict must stay **advisory-only** — never disable or block "add to cart" based on a bad read; the user always keeps final say | Add one rule, otherwise sound |
| **Occasion detection** | LLM-enrichment tier (Phase 2+) may propose a *generic category label* ("drinks") only; it never names a specific product/brand/price — real inventory resolution happens through existing search, same as everywhere else | Correctly bounded already |
| **List optimization** | **Zero LLM involvement today, confirmed** (§1) — pure deterministic combinatorial scoring. This is the model every other feature should be held to. Any new "healthiest"/"protein" dimension must be added the same way (real nutrition data, deterministic scoring), never delegated to an LLM's judgment of "which option is healthier" | This is the reference implementation for "AI suggests, deterministic systems decide" — hold everything else to this standard, don't let anything regress below it |

---

## 5. Simplicity review

Checking the architecture against "the user should never feel like
they're operating a nutrition app / budgeting app / meal planner / fridge
tracker / route optimizer / chatbot platform":

- **Budgeting-app risk — real, in the current design.** Three named
  "budget types" (weekly allowance / paycheck-based / one-trip) reads
  like a settings menu waiting to be built ("which kind of budget do you
  have?"). **Simplify**: there is one standing budget (`weeklyBudget`,
  already exists) with an optional cadence, and a separate *ephemeral*
  per-trip override stated in the moment ("keep this trip under $100")
  that's never persisted and never surfaced as a "type" to choose from.
  The user never picks a budget *type* — they either have a standing
  number or they don't, and they can override it for one trip by just
  saying so.
- **Nutrition-app risk — real, if "conversation depth" is taken
  literally.** **Simplify**: nutrition Q&A is always anchored to *the
  current list or cart*, stateless across sessions, never a persistent
  goals/history/tracking surface. If a user wants to ask a second
  nutrition question, that's a second bounded query against the same
  list — not a growing conversation with memory of its own.
- **Route-optimizer risk — real, in the mode selector as specified.**
  Seven labels (cheapest / fastest / fewest-stores / healthiest /
  highest-protein / best-quality / balanced) is more choice than
  "minimal user effort" should tolerate — that's a decision-paralysis
  surface, not a simplification of the four-tab planner it replaced.
  **Simplify two ways**: (1) `balanced` is always the pre-selected
  default — most shoppers should never have to choose at all; (2) merge
  "highest-protein" into "healthiest" as a refinement, not a sibling
  top-level mode (protein-focus is a *reason* someone wants "healthiest,"
  not a different goal) — bringing the real top-level choice down to five:
  balanced (default), cheapest, fastest, fewest-stores, healthiest.
- **Chatbot-platform risk — real, and worth a hard rule, not just a
  hope.** "Universal assistant as main entry point" can quietly become
  "general-purpose chatbot with a grocery skin" if it ever tries to
  handle input outside its closed intent vocabulary. **Rule**: when input
  doesn't map to a known intent with reasonable confidence, the assistant
  says so and offers its actual capabilities ("I can help you search,
  build a list, optimize a trip, or check nutrition — what would you like
  to do?") — it never attempts open-ended conversation to fill the gap.
- **Fridge-tracker risk — already well-guarded**, no correction needed:
  `InventoryEstimate` was already specified as "always computed, never
  stored as user input," with no browsable screen anywhere in the design.
- **Meal-planner-app risk — already well-guarded**, no correction needed:
  output is an ordinary list on the existing List screen, not a separate
  wizard/tab.

---

## 6. Roadmap validation

**Ordering is directionally correct** (shared infra → cheap extensions →
data foundations → flagship AI surfaces → generative capabilities), but
three changes based on this review's findings:

1. **Add a Phase 0 spike: confirm Open Food Facts already returns
   `nutriments`/`ingredients_text`** (one `curl`, §1). If confirmed —
   likely — **promote nutrition-attribute wiring from Phase 2 into Phase
   1.** This is now "widen an existing TypeScript interface and parse
   fields already arriving over the wire," not a new integration effort,
   and several Phase 3/4 items (healthiest mode, protein mode, Nutrition
   Assistant) are gated on this data existing. Cheaper and earlier than
   previously scoped.
2. **Split "healthiest/protein optimization mode" from "Nutrition
   Assistant conversation"** — they were bundled into one Phase-4 lift in
   the prior doc but have very different costs now that §1/§2 clarified
   the backend: the optimization mode is "one more hardcoded sort branch
   over real nutrition data" (cheap, matches the existing `cheapest`/
   `fastest`/`fewestStops` pattern) and can move up to **Phase 2**,
   immediately after nutrition data lands. The full conversational
   Nutrition Assistant still needs voice/LLM infrastructure and stays in
   **Phase 3/4**.
3. **Add explicit Phase 0 deliverables that were previously implicit or
   missing entirely:**
   - Fix the `CartScreen` substitution dead path (`allProducts: []` → a
     real candidate pool) — a genuine existing bug, not new scope.
   - Update `PlanResultsView`'s existing "store hours aren't factored in"
     disclosure copy once hours data ships (Store Reliability work isn't
     done until this stale disclaimer is removed too).
   - State and enforce the client/server personalization-context rule
     (§2.3) as a decision, not a silent gap.
   - State and enforce the mobile/backend `PlanCandidateId`
     forward-compatibility rule (§2.4) before any new mode ships.
   - **Microphone/camera permission UX and a clear, plain-language
     disclosure of what's sent to a backend AI service** (voice audio,
     cart contents used for meal-planning/nutrition prompts). This was
     entirely absent from the prior roadmap and cannot be deferred to
     Phase 3 — it needs to be designed alongside the features that first
     need those permissions, not bolted on after.

No phase is fundamentally out of order; the corrections above move two
cheap, now-better-understood wins earlier and add missing groundwork to
Phase 0 rather than reshuffling the whole sequence.

---

## 7. Competitive differentiation

- **Instacart / Walmart Grocery / Amazon Fresh** are structurally
  retailer-aligned — each has a direct financial interest in keeping the
  shopper inside its own inventory/fulfillment network. None of them can
  credibly tell a user "actually, skip us, Aldi is cheaper this week,"
  because that's against their own business model. CartIQ's
  retailer-agnostic position (already true today, before any of this AI
  work) is the one advantage no amount of AI investment from a retailer-
  owned competitor can copy without changing their business model.
- **Traditional price-comparison apps** (Flipp, Basket, etc.) have the
  same neutrality but stop at "here's where it's cheaper" — no list-
  building, no route/trip execution, no meal-to-groceries pipeline.
  CartIQ already closes part of this gap (planner, route, cart); this
  architecture closes the rest of it (voice-driven, goal-driven, end-to-
  end).
- **The strongest, most defensible unique value proposition**: *"the
  only assistant that turns a meal idea or a personal goal into a fully
  priced, store-optimized, ready-to-shop plan — from a neutral position
  with no retailer to protect."* The Meal Planner → price comparison →
  optimization → route pipeline (H) is something Instacart/Walmart/Amazon
  cannot offer with a straight face (any recommendation they generate is
  suspect by construction), and something traditional comparison apps
  don't have the execution layer to attempt at all. Nutrition-aware +
  budget-aware + neutral-price-optimized, combined, is not something any
  of the four named competitors offer together today.
- **Where competitors are genuinely ahead, and this doc shouldn't
  overclaim**: Instacart and Amazon Fresh offer actual *fulfillment* —
  someone else shops and delivers. CartIQ is a planning/comparison
  layer, not a fulfillment service. That's a real, structural scope
  difference, not a gap this architecture is trying to close, and the
  competitive positioning should say so plainly rather than imply
  CartIQ replaces those services outright.

---

## 8. Final output

### A. Critical issues to fix before implementation

1. Backend optimizer scoring is not uniformly weight-driven — three of
   four candidates are hardcoded sorts. Design new modes accordingly
   (§1, §6), don't assume a generic weighting system that doesn't exist.
2. `AdvisorCard` has real, data-driven conditional rendering — "identical
   rendering" language should be corrected to "shared skeleton,
   data-driven content" wherever this claim appears in prior docs.
3. `substitutionService` is silently dead on the Cart→ProductDetail path
   (`allProducts: []`) — fix as a bug, independent of the broader
   trigger-wiring work already planned.
4. Nutrition arithmetic must be a hard, enforced rule (deterministic
   only, never LLM-computed) — this was the single most consequential
   gap found in the AI-boundary review (§4).
5. Voice reply generation needs an explicit anti-hallucination mechanism
   (templating or a fact-check pass) — not currently specified (§2.1).
6. No microphone/camera permission-and-disclosure design exists anywhere
   in the roadmap — must be added before Phase 3, not during it.

### B. Architecture changes recommended

1. Split the "Intent & Orchestration Layer" into two explicitly separate
   pieces: a deterministic client-side trigger dispatcher (extends
   `advisorService`, zero AI-safety surface) and an LLM-backed freeform
   classifier (server-side, all of the AI-safety surface). Both resolve
   into the same closed action vocabulary and the same Layer 4 queue.
2. State an explicit client/server personalization-context rule: server
   generators receive personalization only as an explicit per-request
   payload the client sends; no server-side purchase-history persistence
   is introduced by this architecture.
3. State an explicit forward-compatibility rule for `PlanCandidateId`
   (and any similarly shared closed-enum contract): unrecognized values
   must degrade gracefully on both ends, never crash or hard-fail.
4. Collapse the three "budget types" into one standing budget (with
   optional cadence) plus one ephemeral, non-persisted per-trip override
   — no budget-type selector, ever.
5. Reduce the optimization mode selector from seven to five real choices
   (merge "highest-protein" into "healthiest"; `balanced` always
   pre-selected) — see §5.
6. Confirm and then treat nutrition data (Open Food Facts) as a Phase 1
   near-zero-cost win, not a Phase 2 integration effort, pending one
   verification spike.

### C. Updated roadmap

- **Phase 0** (unchanged focus, expanded scope): shared queue + dismissal
  memory, one action sheet, one mode selector (five options, balanced
  default), the *split* trigger-dispatcher/freeform-classifier
  foundation, store hours data + "never recommend a closed store"
  enforcement + removal of the now-stale disclosure copy, the
  personalization-context rule, the `PlanCandidateId` forward-
  compatibility rule, and the mic/camera permission-and-disclosure design.
  **Add**: the Open Food Facts nutrition-fields verification spike.
- **Phase 1**: mode-selector wired to real (if hardcoded-sort) backend
  candidates, substitution trigger fix (including the Cart dead-path
  bug), shopping-memory dismissal + list-similarity, the collapsed
  budget model (standing + ephemeral override) feeding the optimizer.
  **Promoted into this phase**: nutrition-attribute wiring, if the Phase
  0 spike confirms it's already arriving over the wire.
- **Phase 2**: occasion detection (rule-based), household inventory/
  depletion model. **Promoted into this phase**: the "healthiest"
  optimization mode as one more hardcoded sort branch, now that real
  nutrition data exists from Phase 1.
- **Phase 3**: voice as primary interaction surface (with the templated/
  fact-checked reply-generation rule enforced from day one), camera
  quality assessment (advisory-only, hedged language enforced and
  tested).
- **Phase 4**: full Meal Planner pipeline, full conversational Nutrition
  Assistant (deterministic math + LLM phrasing, bounded to the current
  list, no persistent tracking), food-waste prevention.

### D. Non-negotiable principles for all future CartIQ AI development

1. **AI proposes; deterministic CartIQ systems decide and execute.**
   No exceptions, including for prices, availability, nutrition numbers,
   and store facts.
2. **One suggestion, system-wide, at a time** — every new insight kind
   competes in the same single ranked queue with the same dismissal
   memory; there is never a second queue, inbox, or notification surface.
3. **Silence is a correct, common outcome**, not a bug to eliminate —
   every AI feature must be comfortable producing nothing when confidence
   is low.
4. **A generator's output is always an ordinary input to an existing
   system** (a list, a query, a constraint) — never a new data model, new
   screen, or new source of truth of its own.
5. **Numbers a user could rely on for a real decision (price, nutrition,
   store hours, budget) are computed deterministically from real data —
   never estimated or phrased into existence by a model.**
6. **No feature earns its own settings screen, dashboard, history view,
   or tab.** If a feature seems to need one, that's a signal to simplify
   the feature, not to build the screen.
7. **Every closed contract shared between mobile and backend (candidate
   ids, intent vocabulary, insight kinds) must degrade gracefully on
   both sides when the other side doesn't recognize a value.**
