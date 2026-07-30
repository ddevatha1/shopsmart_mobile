# CartIQ AI Implementation Roadmap

An execution plan, not another architecture explanation — see
`CartIQ_ai_architecture.md` (why the system is shaped this way) and
`architecture_review.md` (what was wrong in the first draft) for that.
This doc assumes both and gets to files, tasks, and sequencing.

Repo structure used throughout (verified just now, not assumed): mobile
source is **`src/`** at the repo root (not `frontend/mobile/src/`),
backend is **`backend/src/`** in the same repo, with `routes/` (5 files:
`planner.ts`, `productImage.ts`, `search.ts`, `trip.ts`, `warmup.ts`) and
`services/` (`shoppingPlanOptimizer.ts`, `searchService.ts`,
`tripPlanner.ts`, `routingService.ts`, `browser/`, `locators/`, five
per-store live-scraper files).

## 0. Corrections found while writing this doc (repo-verified, not in prior docs)

Writing this at file-and-line precision surfaced three things the
architecture and review docs didn't catch:

1. **`shoppingPlanOptimizer.ts`'s own `ALL_STORES` is `["Trader Joe's",
   'Sprouts', 'Kroger', 'Aldi']` — four stores, not the six
   `searchService.ts` searches.** Harris Teeter has real product data
   (confirmed in earlier work — it's a Kroger-API banner) but the planner
   never considers it when brute-forcing store subsets. Albertsons'
   exclusion is correct (no product data anywhere); Harris Teeter's is a
   genuine bug. Fixing it goes from 15 subsets (2⁴-1) to 31 (2⁵-1) — still
   trivially cheap to brute-force, just a data/correctness fix.
2. **"Healthiest mode is one more hardcoded sort branch" (from
   `architecture_review.md` §1/§6) undersells the real work.**
   `evaluateSubset()` (`shoppingPlanOptimizer.ts:107-170`) always picks
   the single cheapest candidate per item, per store, unconditionally
   (line 117-120: `reduce` by `p.price < best.price`). A subset's
   `totalCost`/`storeAssignments` are therefore always "cheapest possible
   in this store combination" — full stop, regardless of what
   `selectCandidates()` later sorts by. A `healthiest` candidate built by
   only adding a sort branch to `selectCandidates()` would be sorting
   store-combinations by the nutrition of items that were selected for
   being cheap, not for being healthy — a plan that's "the healthiest
   among already-cheapest-per-store options," not "the healthiest plan
   available." That's a real, meaningfully weaker feature than "Healthiest
   mode" implies, and needs to be either accepted explicitly (cheap, §2
   Phase 2) or built properly (bigger lift — item selection itself has to
   become mode-aware, §2 Phase 2 alternative).
3. **The Open Food Facts nutrition data question is now settled, not
   "likely."** Live-tested `world.openfoodfacts.org/cgi/search.pl` just
   now (`search_terms=organic whole milk`): the response **does** include
   a full `nutriments` object (`energy-kcal_100g`, `proteins_100g`,
   `carbohydrates_100g`, `fat_100g`, `fiber_100g`, `sodium_100g`, etc.),
   `ingredients_text`, and `nutriscore_grade` — confirmed, not inferred.
   One new finding this surfaced: a single product's JSON is **~38KB**,
   and `productImage.ts` requests `page_size=8` — meaning the backend is
   already pulling roughly 300KB per lookup and discarding all of it
   except `product_name`/`brands`/`image_url`. Any nutrition work must
   **extract a handful of fields backend-side**, never forward the raw
   payload to the client.

Everything below is written with these three corrections already applied.

---

## 1. What exists today, per capability

| Capability | Files involved | Reusable as-is | Missing | Must refactor first |
| --- | --- | --- | --- | --- |
| **Optimization modes** | `backend/src/services/shoppingPlanOptimizer.ts`, `backend/src/routes/planner.ts`, `backend/src/types/index.ts` (`PlanWeights`/`PlanCandidate`), `src/services/plannerService.ts` (thin POST wrapper), `src/components/planner/PlanResultsView.tsx` (4-tab picker), `src/components/cart/AutoOptimizeSheet.tsx` (single-card, before/after, undo) | Brute-force subset framework, `planTrip` integration, `AutoOptimizeSheet`'s stage machine | Any non-cost/time/distance/stop dimension; unification between `PlanResultsView`'s tabs and `AutoOptimizeSheet`'s single card (two separate "pick a plan" UIs today) | `ALL_STORES` missing Harris Teeter (§0); `evaluateSubset`'s hardcoded cheapest-only item selection (§0) |
| **Substitution** | `src/services/substitutionService.ts`, called from `SearchScreen.tsx` (×4), `CompareScreen.tsx:70`, **`CartScreen.tsx:161`** | All ranking logic (cheaper-first/organic-first via `PersonalizationProfile`) | A real "store reported unavailable" trigger — today it only fires from a product-detail view | **`CartScreen.tsx:161` passes `allProducts: []`** to `ProductDetail` — substitution is dead on this path, confirmed bug |
| **Budget** | `src/services/budgetService.ts`, `User.weeklyBudget` (`src/models/types.ts`), `ProfileScreen.tsx`'s `BudgetRow`, `advisorService.ts`'s `budget` insight | The whole standing-budget warning path | Cadence field, per-trip ephemeral override, **any budget parameter on `buildShoppingPlan` at all** | `buildShoppingPlan` takes `(items, zipcode, weights)` — zero budget awareness today; a budget-constrained plan can't be requested from the backend as it stands |
| **Nutrition data** | `backend/src/routes/productImage.ts` (`lookupOpenFoodFacts`, `OpenFoodFactsProduct` — 4 fields typed), `src/services/productImageService.ts` | The entire existing OFF search call (§0.3 — confirmed live) | Any nutrition field on `ApiProduct`; any parsing of `nutriments` | Widen `OpenFoodFactsProduct` + extract a minimal field set server-side (§0.3) — do not pass the raw payload through |
| **Purchase memory / inventory** | `src/services/purchaseHistoryService.ts` (`recordPurchases`, `getPantryReminders`), `personalizationService.ts`, triggered from `RouteScreen.tsx`'s pickup checklist | `getPantryReminders`' interval math entirely; the AsyncStorage pattern | Dismissal memory (anywhere in the app); a `quantity` field on `PurchaseRecord`; a category-default cold-start prior | None blocking — both are additive changes |
| **Occasion detection** | *(nothing yet)* — closest analog is `cartSuggestionService.ts`'s `PAIRINGS` table | The pattern (fixed rule table + `AdvisorCard` render target), not any code | Everything | — |
| **Voice** | *(nothing yet)*. `RouteMap.tsx`'s `WebView`+`postMessage` bridge is the closest *pattern* precedent in this app for "talk to a native capability," but it's a map renderer, not reusable code | The bridge-architecture precedent only | Everything — confirmed no `expo-speech`, no speech-recognition package, no backend LLM SDK anywhere | — |
| **Camera / quality assessment** | *(nothing yet)* | Nothing | Everything — confirmed no `expo-camera` | — |
| **Meal planner** | *(new Generator)*, but the **downstream pipeline is real and already proven**: `PlannerScreen.tsx` + `plannerAmbiguityService.ts` + `AmbiguityCard.tsx` already solve "resolve an ambiguous item name before searching" for manually-typed lists — an AI-generated ingredient list ("rice") has the *exact same* ambiguity problem, and can be run through this existing step unmodified | Ambiguity resolution, search, planner, route — the entire chain past "produce an ingredient list" | Only the ingredient-list generation step itself | — |
| **Store reliability** | `StoreLocation` (`backend/src/types/index.ts` / `src/models/types.ts`) | Nothing — confirmed zero hours/closed/holiday fields anywhere, and the optimizer's own header comment says this is a deliberate non-goal today | Everything, plus `PlanResultsView.tsx:95`'s existing copy disclosing the absence needs updating once this ships | — |

---

## 2. Implementation sequence

### Phase 0 — AI foundation + trust infrastructure

No user-visible feature ships in this phase. Everything after it depends
on this existing.

| Item | Files affected | Complexity | Depends on | Acceptance criteria |
| --- | --- | --- | --- | --- |
| Intent contract design | new: `src/types/intent.ts` (or add to `src/models/types.ts`) | S | — | A closed `IntentType` union + `Intent{type, confidence, parameters}` shape exists and is imported by nothing yet (contract-first) |
| Deterministic trigger dispatcher | `src/services/advisorService.ts` (extend `pickTop()`'s candidate-collection call sites to accept new kinds without new plumbing) | S | Intent contract | A new insight kind can be added by (a) one `AdvisorInsightKind` union member, (b) one `KIND_META` entry, (c) one candidate-push in the relevant `get*Insight` function — no other file touches |
| LLM classifier boundary (skeleton only, no real model call yet) | new: `backend/src/services/intentRouterService.ts` (stub returning a hardcoded low-confidence "unknown" intent) | S | Intent contract | Route exists, returns the contract shape, does nothing real — proves the boundary compiles end to end before any AI spend |
| Single advisor queue (dismissal memory) | new: `src/services/dismissalStore.ts` (AsyncStorage, mirrors `purchaseHistoryService.ts`'s pattern); `advisorService.ts`'s `pickTop()` filters against it | M | — | Dismissing a `pantry` reminder for product X suppresses it for a configurable cooldown (test: dismiss, re-run `getHomeInsight` with identical inputs, assert `null` or a different insight) |
| Forward-compatibility rules | `src/models/types.ts` / `backend/src/types/index.ts` (`PlanCandidateId` handling), mobile's `PlanResultsView.tsx`/`AutoOptimizeSheet.tsx` | S | — | Mobile renders gracefully (skips, doesn't crash) if the backend ever returns a `PlanCandidateId` not in its known list — write this as an actual test with a fabricated unknown id |
| Store hours/reliability foundation | `backend/src/types/index.ts` + `src/models/types.ts` (`StoreLocation` gets optional `hours?`), `shoppingPlanOptimizer.ts` (filter closed stores out of `byStore` before routing), `PlanResultsView.tsx:95` (remove/update the now-stale disclosure copy) | M | A real hours data source per store adapter (locators already return `StoreLocation` — extend each locator to attach hours where the underlying API/site provides them; start with whichever store's locator already has the easiest access, likely Kroger's documented API) | A store with `hours` data marking it closed right now is never present in any `PlanCandidate.storeAssignments`; a store with no hours data behaves exactly as today (never silently assumed open OR closed) |
| Open Food Facts nutrition spike | *(no code — already done, §0.3)* | — | — | Done. Result: confirmed present, informs Phase 1 scoping |
| Permissions/privacy UX planning | new: a short in-repo note (`docs/permissions_and_privacy.md` or a section here) covering mic + camera permission copy and what's sent server-side | S | — | Written, reviewed — not a blocker for Phase 0's code items, but must exist before Phase 3 starts, not during it |

### Phase 1 — Existing system leverage

| Item | Files affected | Complexity | Depends on | Acceptance criteria |
| --- | --- | --- | --- | --- |
| Fix `ALL_STORES` in the optimizer | `backend/src/services/shoppingPlanOptimizer.ts:38` | S | — | A shopping plan including a Harris Teeter–only item now returns a valid subset plan instead of silently dropping it (today it would land in `unresolvedItems` even though search finds it) |
| Fix Cart substitution dead path | `src/screens/CartScreen.tsx:161` | S | — | Change `allProducts: []` to a real pool — cheapest correct fix: pass the current cart's own `items.map(i => i.product)` plus (if available) the last search's `products` from `useSearchStore`, so substitution has *something* to compare against instead of nothing |
| Optimization mode cleanup (UI) | `src/components/planner/PlanResultsView.tsx`, `src/components/cart/AutoOptimizeSheet.tsx` | M | Phase 0's forward-compat rule | One shared mode-selector component replaces the two independent "pick a plan" UIs; five modes surfaced (`balanced` default-selected, `cheapest`, `fastest`, `fewest-stops`, plus a **disabled/hidden** `healthiest` slot wired but not yet enabled — turned on in Phase 2) |
| Budget constraint threading | `backend/src/services/shoppingPlanOptimizer.ts` (`buildShoppingPlan` gains an optional `budgetTarget?: number` param), `backend/src/types/index.ts` (`ShoppingPlanRequest`), `src/services/plannerService.ts`, `src/services/budgetService.ts` (add cadence field), `AutoOptimizeSheet.tsx` (surface "these substitutions save $X to hit your target" when over) | M | — | Requesting a plan with `budgetTarget: 100` when the cheapest covering plan is $120 returns a plan (still `cheapest`, unchanged selection logic) **plus** a computed delta the mobile client can render as "over by $20" — no new selection strategy needed yet, just surfacing the existing `cheapest.totalCost` against a target |
| Nutrition field extraction | `backend/src/routes/productImage.ts` (widen `OpenFoodFactsProduct`, extract `caloriesPer100g`, `proteinG`, `fatG`, `carbsG`, `fiberG`, `sugarG`, `sodiumMg`, `nutriScore` — reject/ignore the rest of the payload), `backend/src/types/index.ts` (`ApiProduct` gains optional `nutrition?: NutritionAttributes`) | M | §0.3 confirmed | A search result for a product Open Food Facts has data for now carries a populated `nutrition` object; a product OFF has no match for carries `nutrition: undefined` — nothing downstream may assume it's always present |
| Purchase history: quantity + dismissal wiring | `src/services/purchaseHistoryService.ts` (`PurchaseRecord.quantity`), `RouteScreen.tsx` (pass `item.quantity` at record time), `advisorService.ts` (route `pantry`/future `low-stock` kind through Phase 0's dismissal store) | S–M | Phase 0's dismissal store | A dismissed pantry reminder does not reappear on the next app open with unchanged data; new purchase records include a real quantity (old records without one are treated as `quantity: 1`, never crash) |

**Note on "generic weighting engine" language**: none of the above
introduces one. `buildShoppingPlan` gains one new *optional* parameter
(`budgetTarget`), read only to compute a delta against the plan already
selected by the existing hardcoded sort. This is deliberate — Phase 1
proves out real usage of the current architecture before Phase 2 decides
whether `evaluateSubset`'s item-selection actually needs to become
mode-aware (§0.2), which is a materially bigger change than anything
else in this phase.

### Phase 2 — Data intelligence layer

| Item | Storage/DB changes | API changes | Frontend changes | Fallback when data missing |
| --- | --- | --- | --- | --- |
| **Canonical product model** | New backend-side table/map: `canonicalId → {headNoun, baseUnit, baseUnitQuantity, variantFlags}`, populated lazily as products are seen (not a batch import) | `searchService.ts`'s response gains an optional `canonicalId` per product | None required immediately — this is plumbing for the next three rows | A product with no canonical match yet behaves exactly as an unmatched product does today (own listing, no cross-store grouping change) |
| **Nutrition attributes** | *(uses Phase 1's extraction, no new storage — cached alongside the existing image-lookup cache key)* | *(already shipped in Phase 1)* | Product detail screen may show a one-line nutrition summary if present — no new screen | Absent → simply don't render the summary line; never show "0" or a guessed value |
| **Healthiest optimization mode — ship the honest v1 first (§0.2)** | none new | `PlanCandidateId` gains `'healthiest'`; `selectCandidates()` gains a `totalNutritionScore` field on `SubsetPlan` computed from the **already-selected cheapest-per-item** products, sorted like `cheapest`/`fastest`/`fewestStops` | Enable the disabled slot from Phase 1's mode selector; label it precisely — not "the healthiest possible plan," something like "Healthiest of the cost-efficient options" | A covering set where no item has nutrition data → `totalNutritionScore` undefined for all candidates → mode selector hides/disables `healthiest` rather than returning an arbitrary tie-break |
| **Healthiest optimization mode — v2 (separate, larger task, explicitly not bundled with v1)** | none new | `evaluateSubset()`'s item-selection becomes mode-aware (a `pickStrategy` param, cheapest by default, nutrition-score-within-a-price-ceiling for healthiest — same premium-ceiling pattern `substitutionService.ts` already uses) | none beyond v1 | Falls back to v1's behavior for any item with no nutrition data, per-item |
| **Inventory estimate** | Derived only — computed from `purchaseHistoryService`'s existing log at read time; a small static category-default table (milk ~7 days, eggs ~14, etc.) ships as a code constant, not a DB table | none (client-only) | `advisorService.ts` gains a `low-stock` (or richer `pantry`) insight kind reading the new estimate | New account / no purchase history → category-default tier only, confidence marked lower, never a bare guess presented as fact |
| **Occasion detection** | New code constant: an `OCCASION_TAGS`/`OCCASION_COMPANIONS` table, same shape as `cartSuggestionService.ts`'s `PAIRINGS` | none | `advisorService.ts` gains an `occasion` insight kind | List doesn't match ≥2 tagged items → no candidate produced (silence, per the existing confidence-gate convention) |

### Phase 3 — AI interaction surfaces

Hard rule for both features in this phase, restated because it's the
whole point of doing them last: **AI never executes an action directly.**

```
voice/photo input
      → Perception  (device-native STT, or camera capture)
      → Intent extraction  (LLM, closed vocabulary, backend)
      → Deterministic service call  (existing searchService/plannerService/etc.)
      → Verified result  (the real data that call returned)
      → Response generation  (template-filled from the verified result;
                               LLM paraphrasing only permitted if a
                               post-generation check confirms every
                               number/name in the reply matches the
                               verified result — reject and re-template
                               if not)
```

| Item | Files affected | AI provider architecture | API boundary | Security/privacy | Hallucination prevention |
| --- | --- | --- | --- | --- | --- |
| **Voice assistant** | new: `backend/src/routes/voiceIntent.ts`, `backend/src/services/intentRouterService.ts` (replaces Phase 0's stub with a real LLM call), `src/hooks/useVoiceAssistant.ts`, `src/components/refresh`-style mic entry point on the search bar | Small/fast LLM for intent classification only (closed action vocabulary — this is a classification task, not open generation); device-native STT (`expo-speech-recognition`/native module) and `expo-speech` for TTS, not a hosted ASR, per the accessibility + cost reasoning already in `ai_grocery_assistant_design.md` §3.3 | `POST /api/voice/intent { transcript, sessionContext }` → `{ intent, confidence, parameters }` only — the route never returns a "reply," only a resolved intent; **reply text is generated client-side or in a second, separate call after the real service call returns**, never before | Transcript sent server-side is grocery-domain text only — no account credentials, no payment data ever enters this path; log retention policy for transcripts needs an explicit decision before ship (recommend: not retained beyond the session) | Closed intent vocabulary (LLM can only select among enumerated actions); reply-template-or-verify rule above; if intent confidence is below threshold, respond with the bounded clarification from `architecture_review.md` §5, never attempt open dialogue |
| **Camera quality assessment** | new: `backend/src/routes/visionQuality.ts`, `backend/src/services/visionQualityService.ts`, `src/components/QualityCheckButton.tsx`, `expo-camera` dependency added | One multimodal (vision-capable) LLM call per scan — larger model tier than voice's intent classifier, justified because this is infrequent/user-initiated, not per-search | `POST /api/vision/quality-assess { image, productNameHint? }` → `{ verdict: 'good'|'caution'|'avoid', explanation, detectedExpirationDate? }` | Photos are grocery items, not sent to any store account; no photo persisted server-side past the request (process and discard) | Hedged-language system prompt enforced (`ai_grocery_assistant_design.md` §2.3) + a fixed test-image suite checked against expected hedge wording before every deploy touching this prompt; verdict is advisory-only — never disables "add to cart" |

### Phase 4 — Generative intelligence

**Meal planner pipeline — exact sequence, exact reuse:**

```
User: "Make me beef and broccoli with rice"
        |
        v
POST /api/meal-plan/generate { request: "beef and broccoli with rice", dietaryGoal? }
  → NEW backend service, LLM call, ONE JOB: return ingredient names + rough
    quantities. It does not call performSearch, does not know a price
    exists, does not know a store exists.
        |
        v
{ generatedIngredients: [{ name: "broccoli", quantity: "2 heads" }, ...] }
  rendered as an EDITABLE list — same list-editing UI PlannerScreen.tsx
  already has for a pasted list, not a new review screen
        |
        v
User edits (remove/adjust an item) → confirms
        |
        v
Ingredients become ordinary PlannerListItem[] — IDENTICAL shape to what
  a human pastes into PlannerScreen today
        |
        v
EXISTING plannerAmbiguityService.ts resolves ambiguity ("rice" → which
  kind) — the exact same step a manually-typed list already goes through,
  unmodified
        |
        v
EXISTING buildShoppingPlan (backend) — real search, real prices, real
  store subsets, real routing
        |
        v
EXISTING AutoOptimizeSheet / PlanResultsView rendering
```

The only new code in this entire pipeline is the box that turns a dish
name into ingredient names — everything below that line already exists
and already works for manually-typed lists. If a future implementer
finds themselves writing price, store, or availability logic inside the
meal-planner service, that's the signal something was built in the wrong
place.

| Item | Files affected | Complexity | Depends on |
| --- | --- | --- | --- |
| Meal planner ingredient generation | new: `backend/src/routes/mealPlan.ts`, `backend/src/services/mealPlanService.ts`; mobile reuses `PlannerScreen.tsx`'s existing list-editing UI, just pre-populated | M | Phase 3's LLM infra pattern (reused, not new) |
| Nutrition assistant (deterministic math + LLM phrasing) | new: `backend/src/services/nutritionAnalysisService.ts` — **sums** are plain arithmetic over Phase 2's `nutrition` fields; LLM is called only to phrase the gap explanation on numbers already computed | M | Phase 2's nutrition attributes |
| Grocery list nutritional deficiency checking | same service as above, different entry point — a list-level rollup, not a new feature | S (once the above exists) | Nutrition assistant |
| Food waste prevention | `advisorService.ts` gains a `low-stock`-triggered meal-idea nudge (LLM, 2-3 short suggestions, same bounded pattern as everywhere else) | S–M | Phase 2's inventory estimate |

---

## 3. Dependency graph

```
Healthiest Mode (v1, honest/shallow)
  requires: Nutrition attributes (Phase 1/2)
    requires: Open Food Facts field extraction (Phase 1) [CONFIRMED READY]
  requires: PlanCandidateId extension + selectCandidates sort branch (Phase 2)
    requires: Forward-compatibility rule (Phase 0)

Healthiest Mode (v2, real per-item selection)
  requires: Healthiest Mode v1 shipped and evaluated
  requires: evaluateSubset() item-selection made mode-aware (bigger backend change)
    requires: same substitution-style premium-ceiling pattern (substitutionService.ts)

Nutrition Assistant
  requires: Nutrition attributes (Phase 1/2)
  requires: LLM backend infra (Phase 3's intent-router pattern, reused)
  requires: Voice OR text entry point to ask the question (Phase 3)

Meal Planner
  requires: LLM backend infra (Phase 3, reused)
  requires: plannerAmbiguityService.ts (EXISTS TODAY — no new work)
  requires: buildShoppingPlan (EXISTS TODAY — no new work)

Food Waste Prevention
  requires: Inventory estimate (Phase 2)
  requires: Meal-idea generation (small LLM call, same infra as Meal Planner)

Voice Assistant
  requires: Intent contract + dispatcher boundary (Phase 0)
  requires: closed-vocabulary intent router (Phase 3, new)
  requires: every domain action it can trigger already existing (it always does — voice adds no domain logic)

Camera Quality Assessment
  requires: nothing else in this graph — independent, can ship in parallel with Voice

Store Reliability ("never recommend a closed store")
  requires: hours data per store adapter (Phase 0)
  requires: filter step inside shoppingPlanOptimizer.ts (Phase 0)
  blocks: nothing else, but should ship before any feature that makes the
    app recommend stores more assertively (i.e., before Phase 2 onward)

Budget-aware optimization
  requires: budgetTarget threading (Phase 1) — DONE cheaply, no new selection strategy
  a true "auto-substitute to hit target" version requires the same
    evaluateSubset() rework as Healthiest v2 (substitute cheaper items,
    not just report a delta) — not scheduled in this roadmap's 5 phases,
    flagged as a real Phase 4+ follow-up
```

---

## 4. API contracts

```ts
// Intent — the shape every voice/text input resolves to before anything executes
interface Intent {
  intent:
    | 'search' | 'addToCart' | 'removeFromCart' | 'setStoreMode'
    | 'compareOptions' | 'optimizeCart' | 'openPlanner' | 'setBudgetTarget'
    | 'mealPlan' | 'nutritionQuestion' | 'unknown';
  confidence: number;                 // 0-1; below threshold → 'unknown', bounded clarification
  parameters: Record<string, string | number | undefined>; // e.g. { query: 'bananas' }
}

// Optimization request — extends today's ShoppingPlanRequest, doesn't replace it
interface OptimizationRequest {
  mode: 'balanced' | 'cheapest' | 'fastest' | 'fewest-stops' | 'healthiest'; // PlanCandidateId, extended
  constraints?: {
    budget?: { amount: number; type: 'standing' | 'per-trip' }; // per-trip is ephemeral, never persisted
    nutritionGoal?: 'general' | 'high-protein' | 'low-sugar';   // informs healthiest-mode item scoring in v2 only
  };
}

// Nutrition summary — always derived from real per-product `nutrition` fields, never estimated
interface NutritionSummary {
  products: { productId: string; nutrition?: NutritionAttributes }[]; // absent nutrition is a real, expected state
  totals: { calories?: number; proteinG?: number; fatG?: number; carbsG?: number };
  deficiencies: { nutrient: string; note: string }[]; // phrased by LLM, numbers computed before this array exists
  confidence: 'high' | 'partial' | 'low'; // reflects how many products in the list had real nutrition data
}

// Meal planner — the LLM's ENTIRE output surface; nothing else is generated by AI in this flow
interface MealPlanRequest { userRequest: string; dietaryGoal?: string }
interface MealPlanResponse {
  generatedIngredients: { name: string; quantity: string }[]; // no price, no store, no product id — none exist yet
}

// Voice — the full round trip, showing where "verified" sits between intent and reply
interface VoiceTurnResult {
  transcript: string;
  intent: Intent;
  verifiedResult: unknown;   // the ACTUAL return value of the real service call (e.g. a SearchResponse)
  response: string;          // template-filled from verifiedResult, never generated before it exists
}
```

---

## 5. First 10 implementation tasks

Ranked by dependency importance and risk reduction — explicitly not by
which feature is most exciting to build.

| # | Task | Why first | Files changed | Expected output |
| --- | --- | --- | --- | --- |
| 1 | Fix `shoppingPlanOptimizer.ts` `ALL_STORES` to include Harris Teeter | Zero-dependency, real correctness bug; every later optimization-mode task inherits this if unfixed | `backend/src/services/shoppingPlanOptimizer.ts` | Harris Teeter items are considered in plan generation |
| 2 | Fix `CartScreen.tsx:161` substitution dead path | Same — zero-dependency existing bug, blocks nothing but silently breaks a feature already shipped | `src/screens/CartScreen.tsx` | Substitution suggestions appear when reached from Cart, not just Search/Compare |
| 3 | Ship the dismissal-memory store | Every single new insight kind in every later phase depends on this existing first, or Phase 2+ ships straight into "annoying" territory | new `src/services/dismissalStore.ts`; `src/services/advisorService.ts` | Dismissing any insight suppresses it for a cooldown, verified by test |
| 4 | Widen `OpenFoodFactsProduct` + extract nutrition fields | Confirmed-ready (§0.3), unlocks Healthiest mode, Nutrition Assistant, and deficiency-checking — the single highest-leverage cheap task in this whole roadmap | `backend/src/routes/productImage.ts`, `backend/src/types/index.ts` | `ApiProduct.nutrition` populated for OFF-matched products |
| 5 | Add `hours?` to `StoreLocation` + closed-store filter in the optimizer | Correctness/trust foundation — should exist before anything makes the app recommend stores more assertively (every later phase does) | `backend/src/types/index.ts`, `shoppingPlanOptimizer.ts`, one locator as the pilot data source | A closed store is never in a returned `PlanCandidate` |
| 6 | Intent contract + LLM-router stub (no real model call) | Proves the AI boundary end to end at zero AI cost before any real spend; every Phase 3/4 feature imports this contract | new `src/types/intent.ts` or addition to `src/models/types.ts`; new `backend/src/services/intentRouterService.ts` (stub) | Contract compiles, stub returns a fixed low-confidence `unknown` intent |
| 7 | Forward-compatibility handling for `PlanCandidateId` | Must exist before task 9 (mode-selector unification) or any new mode ships unsafely | `src/components/planner/PlanResultsView.tsx`, `src/components/cart/AutoOptimizeSheet.tsx` | Unrecognized candidate id → skipped, not a crash (write the test with a fabricated id) |
| 8 | `budgetTarget` param on `buildShoppingPlan` (report-only, no new selection) | Cheapest possible version of Budget Guardian; proves the request/response contract before any auto-substitution logic is attempted | `backend/src/services/shoppingPlanOptimizer.ts`, `backend/src/types/index.ts`, `src/services/plannerService.ts` | Response includes a computed over/under-target delta |
| 9 | Unify the mode selector (`PlanResultsView` + `AutoOptimizeSheet` → one component) | Collapses two UIs into one before a 5th mode (`healthiest`) has to be added to both independently | `src/components/planner/PlanResultsView.tsx`, `src/components/cart/AutoOptimizeSheet.tsx`, new shared component | One component, both call sites; `healthiest` slot present but disabled |
| 10 | `PurchaseRecord.quantity` field | Small, additive, unlocks the inventory-estimate work immediately after without a data migration blocking it later | `src/services/purchaseHistoryService.ts`, `src/screens/RouteScreen.tsx` | New records carry real quantity; old records default to 1, never crash |

---

## 6. "Do not build yet" list

Every one of these would violate the architecture even though each is
individually easy to imagine building early:

- A standalone AI chat screen (nutrition Q&A is a mode of the one
  assistant entry point, never a second chat surface)
- A nutrition dashboard (macro/calorie charts, trend history)
- A budget dashboard (spend charts, category breakdowns)
- A dedicated "Meal Planner" tab (it's an intent that ends on the
  existing List screen)
- A "My Fridge" / inventory browsing screen
- Optimization weight sliders or a weight-tuning settings screen (the
  mode selector is five labels, not a control panel)
- A quality-check history/gallery of past camera scans
- A separate "Assistant" tab in the bottom nav (voice/text is a
  cross-screen entry point, not a destination)
- A per-feature notification/inbox screen (everything goes through the
  one Advisor queue)
- A "choose your budget type" screen (weekly/paycheck/per-trip is one
  standing amount + one ephemeral override, never a type picker)
- `evaluateSubset()`'s full mode-aware item-selection rework (Healthiest
  v2) before v1 has shipped and been evaluated against real usage —
  building the expensive version first, before confirming the cheap
  version is even unsatisfying, is the specific unnecessary-complexity
  trap this roadmap is structured to avoid

---

## 7. Recommended first coding sprint

Realistic for one developer, roughly a week, no new dependencies, no AI
spend yet — everything is Phase 0/1 tasks 1-5 and 10 from §5, in this
exact order (each step is independently shippable, so stopping partway
through still leaves the app better than before):

1. **`backend/src/services/shoppingPlanOptimizer.ts`** — add
   `'Harris Teeter'` to `ALL_STORES` (line 38). Run the existing
   `shoppingPlanOptimizer.test.ts` suite; add one new test case with a
   Harris Teeter–only item and assert it resolves instead of landing in
   `unresolvedItems`.
2. **`src/screens/CartScreen.tsx`** — line 161, replace `allProducts: []`
   with the current cart's own product list (`items.map(i => i.product)`).
   Manually verify in the app: add an item, open it from the Cart's
   advisor card, confirm a substitution can now appear.
3. **`backend/src/types/index.ts`** and **`src/models/types.ts`** — add
   `hours?: WeeklyHours` to `StoreLocation` (start with the type only,
   no data source wired yet — this unblocks parallel work on task 4
   without waiting for a real hours feed).
4. **`backend/src/routes/productImage.ts`** — widen `OpenFoodFactsProduct`
   to include `nutriments`/`ingredients_text`/`nutriscore_grade`; add a
   small extraction function producing the minimal `NutritionAttributes`
   shape from §4; attach it to the response as `nutrition?`. Verify with
   one manual search for a product you already confirmed has Open Food
   Facts coverage (e.g. "organic whole milk," per §0.3's live test).
5. **`src/services/purchaseHistoryService.ts`** and
   **`src/screens/RouteScreen.tsx`** — add `quantity` to `PurchaseRecord`;
   pass `item.quantity` at the `recordPurchases` call site; default
   missing `quantity` to `1` when reading old records.
6. **New file `src/services/dismissalStore.ts`** — AsyncStorage-backed,
   mirrors `purchaseHistoryService.ts`'s key-naming convention; wire it
   into `advisorService.ts`'s `getHomeInsight`/`getCartInsight` as a
   filter step before `pickTop()`.

**What success looks like at the end of this sprint**: no new screens, no
new dependencies, nothing AI-related runs yet — but four real bugs/gaps
are fixed (Harris Teeter missing from planning, dead substitution path,
no dismissal memory, no nutrition data flowing despite already paying for
it over the wire), and the two riskiest downstream features in this whole
roadmap (Healthiest mode, dismissal-memory-dependent insight kinds) now
have their prerequisite groundwork in place before a single line of new
AI infrastructure gets written.
