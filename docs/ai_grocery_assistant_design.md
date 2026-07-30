# CartIQ as an AI Grocery Assistant — Design Document

## 0. The design law this whole doc follows

CartIQ already has the exact philosophy you're asking for, built and
working in three places today — this doc's job is to generalize it, not
invent it:

- **`advisorService.ts`** is, in its own words, "the single ranking engine
  every intelligent card in the app draws from." Every surface (Home, Cart,
  Comparison) builds a list of candidate insights and `pickTop()` returns
  **the single highest-priority one, or `null`.** Never a list, never a
  dashboard. Silence is a valid, common outcome — most insight kinds have a
  real numeric confidence bar (e.g. `worth-the-stop` needs `knownSavings >=
  $5`, `pantry` needs `daysSince >= typicalIntervalDays * 0.9`) and simply
  produce nothing below it, rather than showing a weak suggestion.
- **`AdvisorCard.tsx`** renders every one of those insights identically:
  icon, title, one optional detail line, one action button. No
  kind-specific UI branching. Adding a 7th insight kind costs one entry in
  a lookup table, not a new screen.
- **`AutoOptimizeSheet.tsx`** is the same law applied to a bigger decision:
  one recommendation, a before/after comparison, "Apply" or "Keep Current,"
  and a built-in **undo**. It also refuses to show a marginal win as if it
  were a real one (`already-optimal` state below a `$0.50` threshold).

Every new capability below — shopping-list nudges, pantry/inventory
awareness, voice, camera — is designed as **one more candidate insight
kind feeding this same single ranked queue**, and every new "do this?"
action follows the same before/after-plus-undo shape. That single decision
is what keeps "deep intelligence, simple interface" true as features are
added, rather than becoming a slogan that erodes by feature #4.

### 0.1 The one piece of shared infrastructure every feature below needs first

None of `advisorService`'s current insight kinds persist a dismissal —
`priority` is explicitly "relative ordering within one `pickTop()` call
only, never persisted." That's fine at 7 kinds fighting for attention on
one call; it will not stay fine once shopping-list nudges, pantry/inventory
reminders, and voice-surfaced suggestions all feed the same queue and a
shopper taps "Ignore" on one. Before building anything in §1–§6, add:

```ts
// New: dismissalStore.ts (AsyncStorage, mirrors purchaseHistoryService's pattern)
interface Dismissal { insightKind: AdvisorInsightKind; subjectKey: string; dismissedAt: number; cooldownDays: number; }
```

`pickTop()` filters out any candidate whose `(kind, subjectKey)` has an
active dismissal before ranking. `subjectKey` is `normalizedName` for a
pantry/inventory nudge, an occasion id for a shopping-list nudge, nothing
(kind-level) for a one-off like `budget`. This is the actual mechanism
behind "avoid annoying suggestions" — a global one-slot queue plus
per-suggestion memory, not a per-feature frequency cap that each new
feature would otherwise have to reinvent.

---

## 1. AI Shopping List Intelligence

### 1.1 What's genuinely new

Nothing today clusters *multiple list items into a shared context* —
`cartSuggestionService.ts` only does item-pair lookups (`eggs → bacon`,
`cereal → milk`, 10 hardcoded pairings) and stops at 2 suggestions. Cake +
chips + pizza together implying "party" is a different kind of signal:
overlapping occasion tags across several items, not one item's fixed
companions.

### 1.2 Architecture

**MVP — deterministic, extends the existing rule-table pattern:**

```ts
// occasionSignals.ts — same shape/spirit as cartSuggestionService's PAIRINGS
const OCCASION_TAGS: Record<string, string[]> = {
  cake: ['party', 'birthday'], chips: ['party', 'snack'], pizza: ['party', 'casual-meal'],
  soda: ['party'], candles: ['birthday'], charcoal: ['bbq'], burger_buns: ['bbq'],
  // ...
};
const OCCASION_COMPANIONS: Record<string, string[]> = {
  party: ['drinks', 'plates', 'napkins', 'ice', 'dips'],
  bbq: ['charcoal', 'buns', 'condiments'],
};

function detectOccasion(listItemNames: string[]): { occasion: string; matchCount: number } | null
```

For each item in the current list, look up its occasion tags; if ≥2 items
(`MIN_OCCASION_SIGNAL_ITEMS = 2`) share a tag, that's a candidate. This is
cheap, on-device, needs no network call, and — critically — it fails
*safely*: an unmatched list produces nothing, never a wrong guess.

**Phase 2 — LLM-enriched, for lists that don't match any hand-curated
occasion:** send the current list (item names only, no PII) to a small/fast
LLM with a fixed prompt asking for at most one occasion label + up to 5
companion suggestions, **or explicitly "none."** The LLM's output is
treated exactly like a rule-table hit — it still has to clear the same
`MIN_OCCASION_SIGNAL_ITEMS`-equivalent confidence gate before becoming a
candidate for `pickTop()`. This bounds the LLM to *proposing*, never to
directly deciding what the user sees, matching how `docs/
client_assisted_data_engine.md` §4.2 already scoped LLM involvement in
store-schema learning — same bounded-blast-radius principle, reused.

### 1.3 What the AI considers (inputs, ranked by how much signal they carry)

1. **Current list contents** — the occasion signal itself (§1.2).
2. **Past purchases** (`purchaseHistoryService`) — did this shopper buy
   party supplies together before? If so, raise confidence/priority; if a
   past "party" list never included napkins, don't suggest napkins for
   *this* shopper even if the generic table says to.
3. **Household patterns** — today there's no household-size field on
   `User` (§10 of the research: only `zipcode`, `searchHistory`,
   `weeklyBudget`). Treat "household patterns" as *derived* from purchase
   volume/frequency (§5), not a settings-screen field to fill in — this
   keeps faith with "minimal user effort."
4. **Season/date** — cheap deterministic check (July 4th week → bbq tags
   get a priority boost; late-Nov → holiday tags), no model needed.
5. **Preferences** — `plannerPreferenceService`'s remembered
   ambiguity choices (e.g. "this shopper always means the family-size
   option") apply directly to *which* companion product gets suggested,
   not just whether to suggest.

### 1.4 Surfacing — exactly the existing card, one new insight kind

```
"Looks like you're preparing for a party. Add drinks and plates?"
[Add all]  [Ignore]
```

New `AdvisorInsightKind: 'occasion'`; priority formula
`50 + min(20, matchCount * 5)` (same shape as every other kind's priority
math) — it competes for the *same single slot* as a pantry reminder or a
budget warning, and loses to a higher-priority one exactly as designed in
§0. "Ignore" writes a dismissal (§0.1) keyed by the occasion id, not just
this render.

---

## 2. AI Grocery Quality Assessment

### 2.1 Scope discipline

The brief is explicit: no dashboards, no stats. One photo in, one verdict
+ one action out — literally the two example outputs given are the whole
UI:

```
"Looks good. The bananas appear ripe and should be used within a few days."
"Consider choosing another one. These visible spots suggest it may be past peak freshness."
```

### 2.2 Architecture

Camera and any vision model are **fully new** to this app — confirmed
absent from `package.json` (no `expo-camera`, no vision/OCR package).

```
User taps camera icon (on a product card, or a standalone "Check quality" entry)
        |
        v
expo-camera capture (new dependency) → single JPEG, client-side resize/compress
        |
        v
POST /api/vision/quality-assess  { image, productNameHint? }
        |
        v
Backend: one multimodal vision-LLM call, asked to do BOTH freshness
  assessment AND expiration-label OCR in the same request — a modern
  vision-capable LLM handles both in one round trip, so this does not
  need a separate dedicated OCR pipeline the way receipt-OCR does in
  the data-engine doc (that use case is high-volume/latency-sensitive;
  this one is a single user-initiated photo, so simplicity wins)
        |
        v
{ verdict: 'good'|'caution'|'avoid', explanation: string,
  detectedExpirationDate?: string, daysUntilExpiration?: number }
        |
        v
One AdvisorCard-shaped result: icon + verdict sentence + (if expiration
  detected and soon) a second short line. No numeric "quality score,"
  no ingredient breakdown, no history of past scans on screen.
```

### 2.3 The one hard rule for this feature's prompt design

The example outputs are already hedged, not diagnostic — "**appears**
ripe," "**suggests** it may be past peak," never "this is/is not safe to
eat." That hedging is a requirement, not a style choice: a grocery app
telling someone with certainty that food is safe or unsafe is a real
liability surface (food safety, allergies, mold vs. cosmetic blemish). The
backend prompt must enforce: always qualify with "appears/looks/may,"
never assert a food-safety fact, and always end on an action ("use within
a few days" / "consider choosing another one"), never a bare judgment.
This is a system-prompt-level constraint that needs a test suite (a fixed
set of sample images with expected hedge-language checks), not just a
one-time prompt draft.

### 2.4 On-device vs. server

- **On-device**: capture, client-side compress/resize before upload (keeps
  the request small and fast — matters on the cellular connections most
  grocery-store photos will be taken over), the single result card.
- **Server-side**: the vision-LLM call itself. Keeping it server-side (not
  on-device inference) is the right call today because on-device
  vision-language models capable of both freshness judgment *and* label
  OCR in one pass aren't yet something Expo/RN can ship without a much
  heavier native ML dependency — server-side keeps the mobile app light,
  matching the "minimal screens, minimal complexity" mandate, at the cost
  of a per-scan network round trip and hosted-inference cost (flagged in
  §13).

---

## 3. Universal Voice Grocery Assistant

### 3.1 Why this is architecturally different from §1/§2

Voice isn't one more insight card — it's an alternate front door to
**everything the app can already do.** The design goal is therefore: build
one small intent router in front of the *existing* services
(`searchService`/`useSearchStore`, `useCartStore`, `plannerService`,
`comparisonService`), never a parallel "voice version" of grocery logic.

### 3.2 Pipeline

```
Push-to-talk button (mic icon, always reachable — this is the one voice-
specific UI element; everything else voice does reuses existing screens)
        |
        v
Speech-to-text
        |
        v
Transcript + last N turns of conversation state → intent router
        |
        v
Router maps to ONE of a fixed, closed set of app actions + extracted slots:
  search(query) | addToCart(productRef) | setStorePreference(mode)
  | compareOptions(criteria: 'cheapest'|'closest'|'quality')
  | openPlanner() | optimizeCart() | answerQuestion(topic)
        |
        v
Router EXECUTES the action by calling the existing client service
  (e.g. useSearchStore().search(query)) — the router never invents
  product/price data itself, it only decides which existing function to
  call and with what arguments
        |
        v
A short spoken reply string is generated from the ACTUAL result
  (e.g. "ALDI has the lowest price. Add it to your list?") — never from
  the LLM's own "memory" of prices, always from the real search/cart
  response that already ran
        |
        v
Text-to-speech speaks the reply; the same result also renders normally
  on-screen (voice never hides state from the visible UI — an elderly
  user who prefers to glance at the screen instead of listening gets the
  identical information)
```

### 3.3 Speech recognition — recommendation and why

**Recommend device-native STT first** (iOS `Speech` framework / Android
`SpeechRecognizer`, via a small native module or a community Expo
package), not a hosted ASR API, for three concrete reasons: (1) zero
per-utterance cost, which matters a lot once voice is a primary
interaction mode rather than an occasional action; (2) lower latency — no
network round trip before the intent router even starts; (3) both
platforms' built-in recognizers are already tuned for accessibility use
cases (they're the same engines powering each OS's own accessibility
voice features), which directly serves the "elderly users" goal without
CartIQ having to solve speech-recognition-for-elderly-users itself.
Fall back to a hosted ASR (e.g. for a language/accent the device
recognizer handles poorly) only if real usage data shows a gap — don't
build the hosted path speculatively.

**Text-to-speech**: `expo-speech` (new dependency, but a first-party Expo
module, not a native-module integration project) — on-device, no server
round trip for output.

### 3.4 Intent detection

The action space above is **closed and small** — this is a classification
+ slot-extraction task, not open-ended reasoning, so a small/fast LLM (not
the same tier of model as §2's vision assessment) is enough, and it's the
same "LLM proposes a structured decision inside a fixed vocabulary, code
executes it" pattern used for occasion detection (§1.2) and store-schema
alias suggestion (`docs/client_assisted_data_engine.md` §4.2) — a
consistent, auditable rule for every LLM touchpoint in this app: **the
model chooses among options the code defines; it never generates
free-form actions.**

Worked example, matching the brief exactly:

```
User: "I need bananas"
  → router: search(query="bananas") → existing search pipeline runs
  → reply built from real results: "I found bananas. Do you want the
    cheapest option, closest store, or best quality?"
User: "Cheapest"
  → router, using conversational memory (§3.5) to resolve "cheapest"
    against the pending bananas search: compareOptions(criteria='cheapest')
    → sorts the ALREADY-FETCHED results by price (no new search)
  → reply: "ALDI has the lowest price. Add it to your list?"
User: "Yes"
  → router: addToCart(productRef=<the ALDI banana result from this turn>)
```

### 3.5 Conversational memory

Scoped **deliberately small** — a short-lived, client-side session object
(a few turns, cleared when the mic session ends or after an idle timeout),
not a persistent chat history and not the whole `searchHistory` log:

```ts
interface VoiceSession {
  turns: { transcript: string; intent: string; slots: Record<string, unknown> }[]; // capped, e.g. last 6
  pendingResult?: { type: 'search'; query: string; results: ApiProduct[] }; // what "cheapest" resolves against
}
```

Sent to the backend intent router each turn as bounded context (not the
full app state) — the router needs "what was the user just talking about"
to resolve "cheapest"/"the first one"/"add it," not the shopper's entire
history.

---

## 4. Intelligent Shopping Memory

### 4.1 This is ~90% already built

`purchaseHistoryService.getPantryReminders()` already does exactly the
brief's example: groups purchases by product, computes each product's
`typicalIntervalDays` from real purchase gaps, and only surfaces "you
usually buy this around now" when `daysSince >= typicalIntervalDays *
0.9` — i.e. the "only recommend when confidence is high" requirement is
already a real numeric gate, not an aspiration. It already feeds
`getHomeInsight` as the `pantry` insight kind, rendered through the same
one-card `AdvisorCard`.

### 4.2 The actual delta

1. **Dismissal memory** (§0.1) — today a dismissed pantry reminder just
   reappears next time the conditions hold, since nothing persists past a
   single `pickTop()` call. This is the single most important fix for
   "avoid annoying users" here specifically, because pantry reminders are
   the highest-frequency insight kind (they fire on ordinary repurchase
   cadence, not a rare event like a big discount).
2. **List-similarity signal** — today's logic is purely per-product
   interval; it doesn't yet check "does the *current* list already
   resemble a past eggs+milk+bread trip, minus eggs?" as the brief's
   example frames it. Add a cheap Jaccard-similarity check between the
   current list and past *trips* (not just past per-product intervals):
   if the current list overlaps ≥60% with a past trip's item set and the
   missing items are individually near their own `typicalIntervalDays`,
   raise that reminder's priority — this makes the nudge feel like it
   understood "you're doing your usual grocery run," not just "you
   individually tend to buy eggs every 9 days."
3. **Season** — same cheap deterministic adjustment as §1.3 item 4;
   `typicalIntervalDays` for genuinely seasonal items (e.g. sunscreen,
   hot cocoa) is a single average across the whole year today, which
   under/overestimates outside their season. Low priority — most grocery
   staples aren't seasonal enough for this to matter yet.

---

## 5. AI Household Inventory / Online Fridge

### 5.1 Non-negotiable constraint from the brief

No manual entry, ever — this rules out any UI where a user types "5 eggs
left." Everything here has to be *inferred*, and has to fail toward
silence (no confident estimate) rather than a guessed number presented as
fact.

### 5.2 What has to be added to make this real (not just a rename of §4)

`PurchaseRecord` today (`purchaseHistoryService.ts`) has no `quantity`
field — each unit purchased pushes one record. That's enough for "when did
you last buy milk" (§4) but not "how much milk do you probably have left
right now," which needs a quantity and a consumption-rate model:

```ts
interface PurchaseRecord {           // extend, don't replace
  normalizedName: string; displayName: string; store: StoreName;
  brand: string; isOrganic: boolean; price: number; timestamp: number;
  quantity: number;                   // NEW — from cart item's existing quantity field
}

interface InventoryEstimate {         // NEW — always computed, never stored as user input
  normalizedName: string;
  estimatedRemaining: 'plenty' | 'running-low' | 'likely-out' | 'unknown';
  confidence: number;
  basis: 'personal-history' | 'category-default';
}
```

**Depletion model, two tiers so a brand-new account isn't stuck at
`'unknown'` forever:**
1. **Category default prior** — a small static table of typical
   consumption windows per grocery category (milk ~7 days, eggs ~14 days,
   bread ~7 days, yogurt ~10 days — reusable, coarse, seeded once, not
   per-user data). Used from day one.
2. **Personal blend, once enough signal exists** — reusing the exact
   `MIN_PURCHASES_FOR_SIGNAL = 3` gate `personalizationService.ts` already
   uses elsewhere in this codebase: once a product has ≥3 purchase
   records, blend toward the shopper's own observed
   `typicalIntervalDays`/quantity pattern instead of the category default.
   Same "don't guess with too little data" discipline already established,
   applied to a new signal.

`estimatedRemaining` is a **coarse three-state label, not a number** — the
brief's own examples never say "you have 2 eggs left," they say "may be
running low" and "you usually finish milk in about a week." Presenting a
precise count the system cannot actually know (no one is weighing the
fridge) would be false precision; a three-state label matches what the
underlying signal can actually support.

### 5.3 Surfacing

Same rule as everywhere else — one more `AdvisorInsightKind` (`'low-stock'`
or reuse `'pantry'` with a richer detail line once §5.2 exists), competing
in the same single-slot queue, same dismissal memory. No new screen, no
"my fridge" tab — the brief is explicit that this should be invisible
infrastructure, not a feature the user has to go operate.

---

## 6. Grocery Optimization Engine

### 6.1 This is also mostly already built, server-side

`plannerService`'s `/api/planner` backend already optimizes across cost,
drive time/distance, and stop count, and already returns **four
precomputed whole-plan candidates** (`balanced`/`cheapest`/`fastest`/
`fewest-stops`) with one flagged `recommendedId`. `PlanResultsView.tsx`
already lets a shopper pick among them via tabs, and `AutoOptimizeSheet.tsx`
already collapses this into the exact "one recommendation card" shape the
brief asks for:

```
"Best option:
Shop Kroger + ALDI
Save $8 and add 5 minutes."
```

is a direct restatement of what `AutoOptimizeSheet`'s `result` stage
already renders (before/after store count + cost, with the drive-time
delta available from the same `TripPlan` it already carries).

### 6.2 The real delta: two new scoring dimensions, and a data-honesty blocker

The brief's "Best quality"/"Healthiest" modes need scoring dimensions that
don't exist in `PlanWeights` (`cost`, `time`, `distance`, `fewerStops`
only) or anywhere in `ApiProduct` today:

- **Quality dimension** — the obvious source is `product.rating`, but this
  needs a real caveat surfaced in `docs/client_assisted_data_engine.md`'s
  research: some stores' ratings are **synthetic** (deterministic-hash
  generated, not real customer data), while others (Kroger) have real
  `ratingsAndReviews` data sitting unused in the API response. **Do not
  ship a "Best quality" mode before fixing this** — ranking stores by a
  mix of real and fabricated numbers, unmarked, is exactly the kind of
  data-honesty gap this codebase has otherwise been careful to avoid
  (`storeStatuses` marks `'unavailable'` honestly instead of faking zero
  results as an error, `AutoOptimizeSheet` refuses to claim savings it
  can't verify). Sequencing: wire in real ratings where the API already
  provides them, and either exclude or clearly flag stores with only
  synthetic ratings from quality-based ranking, before exposing this mode.
- **Health dimension** — no nutrition field exists on `ApiProduct` at all.
  `certifications` (free-text, e.g. "Organic," "Non-GMO") is the one real,
  non-fabricated signal available today and is a reasonable v1 proxy
  (count of recognized healthy certifications). For a real health score,
  `productImageService`'s existing Open Food Facts integration is the
  natural first-party source to extend — Open Food Facts already provides
  Nutri-Score/nutrition data for many UPCs, and this app already has a
  working client for it for a different purpose (image resolution),
  meaning this is "extend an existing dependency," not "add a new one."

### 6.3 UI unification

Collapse `PlanResultsView`'s four tabs and the brief's requested
"Cheapest / Fastest / Healthiest / Best quality" into **one shared mode
selector component**, reused by the Planner flow and by `AutoOptimizeSheet`
— today they're two separate UIs expressing the same underlying concept
(pick a `PlanCandidateId`-shaped priority). No new controls, no weight
sliders — exactly the brief's "avoid complex optimization controls."

---

## Additional features

### A. Food Waste Reduction

**Sequencing note**: this depends on §5 (inventory/depletion estimates)
existing first — you cannot credibly say "your spinach may go bad soon"
without an estimate of when it was bought and how fast it typically gets
used, which is exactly what §5.2's `InventoryEstimate` produces. Once that
exists: when `estimatedRemaining` crosses into `'likely-out'` territory
*and* the product is a known-perishable category, surface one insight —
"Your spinach may go bad soon. Here are quick meal ideas" — where "meal
ideas" is a short LLM-generated list (2-3 items, same bounded/hedged
pattern as §2.3, never a recipe database to browse). This is explicitly a
Phase-4-tier feature (§8) because it's compounding on top of two other new
systems (inventory + camera), not a standalone build.

### B. Smart Substitutions

**Already built**, more than any other "additional feature" here.
`substitutionService.findSubstitution` already ranks by cheaper-first or
organic-first depending on the shopper's derived `organicAffinity`, with
real minimum-savings/premium-ceiling gates. **The actual gap**: it's
currently scoped to *candidates from the same search response* only —
extend the trigger to fire specifically when a store reports a product
unavailable (not just "shopper is viewing a product detail page"), which
is the brief's literal scenario ("Your preferred milk is unavailable").
Low effort, high value — this is a trigger-wiring change, not new ranking
logic.

### C. Budget Guardian

**Also mostly already built** — `budgetService.getBudgetStatus` +
`advisorService`'s `budget` insight kind already warn at `'approaching'`
(≥80%) and `'over'` (>100%) against `User.weeklyBudget`. The brief's
example is a **different, more specific ask**: a per-trip target
("Keep this trip under $100," not a standing weekly budget) with an
active auto-substitution suggestion to close the gap, not just a warning.
Two additions: (1) an optional per-session budget-target override the
shopper can state once (via text or voice — "keep this under $100" is a
natural `setBudgetTarget(amount)` voice intent per §3.4's closed action
set); (2) reuse `AutoOptimizeSheet`'s existing optimizer, but call it with
an explicit target-cost constraint rather than "minimize cost
unconditionally," so the response is "these substitutions save $22"
(concrete swaps) rather than a bare warning.

### D. Adaptive Shopping Mode

**This is §6.3** — the brief's "Cheapest / Fastest / Healthiest / Best
quality" four-way picker is the same UI unification already designed
there. Listed separately in the brief, but there is no reason to build it
twice.

---

## 7. Global "avoid annoying suggestions" architecture (cross-cutting)

Restating §0.1 as the one architectural rule every feature above answers
to, because it's the actual mechanism behind the brief's repeated "do not
annoy the user" requirement across sections 1/4/5:

1. **One slot, system-wide.** Every insight kind — existing and new —
   competes in a single `pickTop()` call per surface. Never two cards.
2. **Numeric confidence gates, not "does this seem reasonable."** Every
   kind above has (or is designed with) a concrete threshold before it's
   even a candidate — matching the existing kinds' pattern exactly
   (`knownSavings >= $5`, `daysSince >= typicalIntervalDays * 0.9`,
   `matchCount >= 2` for occasions, blended confidence for inventory).
3. **Dismissal has memory** (§0.1's `dismissalStore`) — "Ignore" means
   ignore, with a cooldown, not "ask again next render."
4. **Silence is success, not a bug to fix.** `well-optimized` (priority
   10, cart already good) and `already-optimal` (`AutoOptimizeSheet`) are
   existing proof this codebase already treats "nothing to suggest" as a
   correct, deliberate outcome — every new kind should be comfortable
   producing nothing most of the time.

---

## 8. Technical Architecture

### 8.1 On-device (React Native / Expo)

- Existing UI shell, screens, `zustand` stores — unchanged in kind, extended
  with: a mic button (voice, §3), a camera-capture entry point (§2), a
  shared mode-selector component (§6.3).
- **New client dependencies**: `expo-camera` (§2), `expo-speech` (TTS,
  §3.3), a device-native STT bridge (native module or community package,
  §3.3).
- **New client-side services**: `dismissalStore.ts` (§0.1),
  `occasionDetectionService.ts` (§1.2, MVP tier — pure on-device rule
  table, no network), inventory estimation logic (§5.2's category-default
  tier can run entirely on-device against the local `purchaseHistoryService`
  log — no reason to round-trip to a server for a transform over data
  that's already local-only AsyncStorage).
- **Stays on-device, deliberately**: all purchase history, personalization
  profile, planner preferences, and (new) inventory estimates. None of
  this is server-synced today (confirmed: `AsyncStorage`, single-device,
  keyed by email but not backed by any server table) — this doc doesn't
  change that. Flagged as a real limitation in §9, not silently fixed
  here, since fixing it is a separate, bigger architectural decision (a
  server-side user-data store) outside this doc's scope.

### 8.2 Server-side (backend)

- Existing: `searchService`, `/api/planner`, store adapters — unchanged.
- **New endpoints**: `POST /api/vision/quality-assess` (§2),
  `POST /api/voice/intent` (§3.4's router — transcript + bounded
  conversation context in, structured intent+slots+spoken-reply out),
  optionally `POST /api/speech/transcribe` only if/when the hosted-ASR
  fallback from §3.3 is actually needed.
- **New backend services**: `intentRouterService.ts` (§3.4, calls into the
  existing `searchService`/`plannerService` — never duplicates their
  logic), `occasionEnrichmentService.ts` (§1.2 Phase 2 LLM tier),
  `visionQualityService.ts` (§2.2).

### 8.3 AI models required, and why each tier is sized the way it is

| Capability | Model tier | Why this tier |
| --- | --- | --- |
| Voice intent classification (§3.4) | Small/fast LLM | Closed, small action vocabulary — classification + slot extraction, not open reasoning |
| Occasion detection enrichment (§1.2 Phase 2) | Small/fast LLM | Same shape as above: propose a label from a short list, gated by code |
| Produce/package quality assessment + label OCR (§2.2) | Multimodal (vision-capable) LLM, larger tier | Genuine visual reasoning task; also the one place a bigger model is worth the cost, since it's user-initiated and infrequent, not per-search |
| Speech-to-text (§3.3) | Device-native OS recognizer (not an LLM at all) | Free, fast, offline-capable, accessibility-tuned already |
| Text-to-speech (§3.3) | Device-native (`expo-speech`) | Same reasoning as STT |
| Meal-idea suggestions (Food Waste, Additional-A) | Small/fast LLM | Short, bounded, low-stakes generation |

---

## 9. Feature Prioritization & Roadmap

| Feature | User impact | Difficulty | Cost | Uniqueness | Depends on |
| --- | --- | --- | --- | --- | --- |
| Adaptive Shopping Mode (§6.3/D) | High | Low | Low | Medium | nothing new |
| Smart Substitutions trigger fix (B) | High | Low | Low | Low | nothing new |
| Shopping Memory dismissal + list-similarity (§4) | High | Low | Low | Medium | §0.1 |
| Budget Guardian per-trip target (C) | Medium-High | Medium | Low | Medium | nothing new |
| AI Shopping List occasion detection, MVP (§1.2 tier 1) | Medium-High | Medium | Low | High | §0.1 |
| Household Inventory / depletion model (§5) | High (foundational) | Medium-High | Medium | High | §4's memory work |
| Universal Voice Assistant (§3) | High | High | Medium-High (ongoing) | High | existing search/cart/planner services |
| Grocery Quality Assessment (§2) | High | High | Medium-High (per-scan) | High | none, but ship the hedged-language test suite with it |
| Food Waste Reduction (Additional-A) | Medium-High | Medium | Low-Medium | High | §5 (and benefits from §2) |
| "Healthiest"/"Best quality" modes (§6.2) | Medium | Medium | Low | Medium | fixing the synthetic-rating gap; extending Open Food Facts |
| Occasion detection LLM enrichment (§1.2 tier 2) | Low-Medium | Low | Low (bounded calls) | Medium | tier-1 MVP already shipped |

### Phased plan

**Phase 1 — Extend what already works (client + existing backend only, no
new AI infra, no new native deps).** Adaptive Shopping Mode UI unification,
Smart Substitution trigger wiring, Shopping Memory dismissal memory + list-
similarity, Budget Guardian per-trip target. Every one of these is a
targeted extension of code that already exists and already works; this
phase is deliberately front-loaded because it's the cheapest way to make
the app *feel* dramatically smarter before any new AI-model cost is taken
on.

**Phase 2 — New deterministic intelligence, still no heavy AI infra.**
Occasion detection MVP (rule-based), Household Inventory depletion model
(category-default tier, then personal-blend tier). This phase builds the
data foundation (`InventoryEstimate`) that Phase 4's Food Waste feature and
Phase 3's voice/quality answers both get smarter from having.

**Phase 3 — Flagship AI-native surfaces (new native deps, new hosted-AI
cost).** Universal Voice Assistant (device-native STT first), AI Grocery
Quality Assessment. Sequenced after Phases 1-2 specifically so voice
answers and quality nudges can already draw on real inventory/occasion
signal instead of shipping as shallow demos.

**Phase 4 — Compounding capabilities.** Food Waste Reduction (needs §5 +
benefits from §2's camera pipeline), occasion-detection LLM enrichment for
lists the Phase-2 rule table misses, "Healthiest"/"Best quality"
optimization modes (gated on the rating-data honesty fix and the Open Food
Facts extension).

---

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| **Food-safety-adjacent liability** (quality assessment telling someone food is/isn't fine) | Hard-enforced hedged language (§2.3), a real test suite of sample images checked against expected hedge wording before ship, never a bare safety claim |
| **Ranking stores by partly-synthetic rating data** (§6.2) | Do not ship "Best quality" mode until real-vs-synthetic ratings are distinguished; exclude synthetic-only stores from quality ranking in the meantime |
| **Suggestion fatigue eroding trust in the whole advisor system** | §7's single-slot-plus-dismissal-memory architecture is the actual fix, not a UI polish item — build it before shipping any of the new insight kinds, not after |
| **Voice/vision hosted-AI cost scaling with usage** | Deliberately tiered model sizing (§8.3) — cheap classification model for the high-frequency voice-intent path, reserving the expensive multimodal model for the low-frequency, high-value quality-check path |
| **Elderly-accessibility voice UX is a real usability project, not just an API integration** | Device-native STT (tuned for accessibility already) reduces but doesn't eliminate this; budget real usability testing with the target demographic before treating voice as done |
| **Purchase history is single-device, local-only** (AsyncStorage, no server sync) | Inventory/memory features (§4, §5) inherit this limitation — a shopper's estimate resets on a new device/reinstall; flagged, not solved, in this doc; solving it is a separate backend-user-data-store decision |
| **LLM scope creep** | Every LLM touchpoint in this design (occasion detection, voice intent, meal ideas) is constrained to choosing among options the code defines, never generating or executing a free-form action — enforce this as a review checklist item for every new AI feature, not just a design-time intention |
