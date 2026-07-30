# Phase 6 — Real-World Grocery Intelligence Review

**Status: review only. No code has been changed to produce this document.**

This reviews CartIQ as it stands after Phase 5.5: a deterministic,
safety-gated Assistant Boundary reachable from Home's `QuickActionsRow`;
a real multi-store optimizer with routing, budget, and nutrition
scoring; a shared `PlanItemProductGrid` rendering real products
everywhere a plan appears; `ShopperPreferences` memory; evidence-gated
explanations at both plan grain (`explainRecommendation`) and product
grain (`explainProductSelection`); persisted `ShoppingSessionHistory`
with a real comparative "Magic Moment" callout; and a homepage
`HomeInsightsStrip` that surfaces real suggestions and a real prior
savings figure before anyone asks. The intelligence is real, evidence-
gated, and now reasonably visible. The question this document answers:
**what's the next highest-impact layer, and where does the existing
architecture already quietly support it vs. actually need something
new?**

Every recommendation below was checked against the current code, not
assumed. Two findings shaped this review more than anything else:

- **There is no push-notification infrastructure at all** — no
  `expo-notifications`, no server-side user/token registry, no
  scheduler. Anything that sounds like "the app nudges you outside the
  app" is a bigger infra lift than it sounds like, and is called out
  explicitly wherever it comes up below.
- **"Purchased" is only ever known when a shopper completes a trip
  through CartIQ's own Route/pickup checklist** — there is no
  receipt/checkout integration. Every purchase-history-derived signal
  (`purchaseHistoryService`, `inventoryEstimationService`,
  `personalizationService`) only ever sees the fraction of a shopper's
  real grocery life that happened to go through this app's own Route
  feature. This is a real ceiling on "daily companion" ambitions, not a
  bug to fix in Phase 6 — it should be stated honestly in-product
  ("estimated," never "we know"), exactly as `inventoryEstimationService`
  already does.

---

## 1. Daily Grocery Companion Experience

**What "daily companion" can honestly mean today:** an in-app surface a
shopper checks out of habit, not a system that reaches them outside the
app. A real push-notification companion needs three things this app
does not have: a permission/consent flow, a client-side scheduling or
server-side push mechanism, and (for anything server-triggered) a
persistent per-user record and token registry on the backend — today's
backend is a stateless API with no such store. Building that is a real
infrastructure project, not a Phase 6-sized feature.

What *is* honestly buildable without new infrastructure:

- **Client-scheduled local reminders.** `expo-notifications` supports
  purely local, device-scheduled notifications with no server
  involvement. On each app open, the app already has (or can cheaply
  compute) real signals — `getPantryReminders`, `estimateAllInventory` —
  and could schedule a local notification for "a few days from now" using
  those same real numbers, canceling/rescheduling on every subsequent
  open. This is a real capability upgrade (the app can now speak first),
  but it is new native surface area: a permission prompt, a
  disclosure ("why are you notifying me"), and doing so only for signals
  that already clear the existing `'likely_low'` + non-`'low'`-confidence
  bar `assistantSuggestionService.ts` already enforces — never a new,
  looser bar just to have something to say.
- **One coherent "Today" surface, not two parallel ones.** `AdvisorCard`
  (Home/Cart/Compare, single-best-insight) and `HomeInsightsStrip`
  (Phase 5.5, multi-chip) currently both render on Home from overlapping
  data. Phase 5.5's own review flagged this as "a natural candidate for
  a later cleanup pass." Phase 6 is that later pass: either fold
  `AdvisorCard`'s Home slot into the strip, or keep them but give the
  strip unambiguous visual priority — either way, a shopper opening the
  app should see ONE "here's what I know" moment, not two.
- **A quiet in-app signal, not a push notification.** A small badge/dot
  on the Assistant's `QuickActionTile` when `getShoppingSuggestions`
  or `getPantryReminders` has something real to say — visible the moment
  the app is open, on any screen that renders the row, with zero new
  permissions. This is the safe middle step between "static tile" and
  "the app pings you at 6pm."

**Explicit ceiling:** nothing here should ever claim certainty about
what's actually in a shopper's kitchen. Every companion surface must
keep using `inventoryEstimationService`'s existing, honest vocabulary
(`'likely_low'`, `'unknown'` — never `'out of stock'` asserted as fact).

---

## 2. Stronger Onboarding

`OnboardingScreen.tsx` is deliberately a single welcome screen, and its
own header comment argues explicitly against a step-by-step wizard —
"teach only what's needed right now," deferred to `ContextualHint`
banners shown in context. **A multi-step wizard would reverse a
deliberate, documented design decision with no new evidence it's
failing**, so this review does not recommend one. What it does find:

- **The Assistant is invisible unless you already know it's there.**
  It's reachable only via a `QuickActionTile` equal in visual weight to
  "Smart Planner." A shopper who never taps it never discovers meal
  planning, restock suggestions, savings sessions, or preference
  memory — the majority of what makes this app different. The existing
  `HintKey` union already has a defined-but-unused `'search-suggestions'`
  slot; a same-mechanism hint on first Home view, pointing at the
  Assistant tile, would use the exact existing pattern (`ContextualHint`,
  shown once, permanently dismissed) rather than a new one.
- **Preferences are never asked, only stated.** `ShopperPreferences`
  are, correctly, only ever set from an explicit statement to the
  Assistant ("remember I prefer Aldi") — never inferred. But that also
  means a brand-new account's `HomeInsightsStrip`, suggestions, and
  product-level "matches your preferred store" reasoning all stay silent
  until a shopper happens to say something first. A single, optional,
  skippable, explicit question at sign-up — "Do you have a preferred
  store?" — writing directly into the existing
  `shopperPreferenceService.addPreferredStore` is not an inference; it's
  the same explicit-statement capture the Assistant already does, just
  offered once, earlier, in a real UI control instead of requiring a
  shopper to type a sentence to discover it's possible at all.

**Explicit non-goal:** no dietary/household/budget questionnaire at
sign-up. Those remain assistant-only, explicit-statement-only, per
Phase 5.2's own rule — a form full of preference questions at sign-up
is a wizard by another name, and a store preference is uniquely
low-risk (it's used for read-only reasoning, never budget/optimizer
input) in a way the others are not.

---

## 3. Competition Demo Flow

Phase 5.5 already closed most of the structural gap here (Magic
Moment banner, homepage strip, shared plan visualization). What's left
is narrower and mostly about **discoverability speed and cold-start
reality**, not new features:

- **The single best feature requires history that a live demo won't
  have.** "CartIQ found you a better plan" only renders with a real
  `historyComparison` — which only exists after a second completed
  session. A judge trying a fresh install cold will never see it. The
  zero-build fix: script the live demo as two requests ("build me a
  grocery plan," then a second, slightly different one) rather than
  one — this needs no code, just a demo script, and it's the option
  this review recommends.
- **A labeled, opt-in "Try a Demo" seed path is a legitimate but
  higher-care option**, and worth naming precisely because it borders
  the "fake personalization" line this phase must not cross: it is only
  acceptable if it is a distinct, clearly-labeled sample-data path a
  judge explicitly opts into (never silently seeded into a real
  shopper's own account, never presented as if it were real personal
  history). If Phase 6 doesn't have appetite for that framing exactly
  right, skip it — the demo-script option above costs nothing and has
  no safety surface at all.
- **Entry-point promotion.** Tying into §2's onboarding finding: for a
  demo specifically, the Assistant's equal-weight tile means a presenter
  has to explain where to tap before the actual "wow" starts. Nothing
  architectural needs to change — just visual priority (larger, or
  first, or the thing the homepage strip's chips deep-link into, which
  Phase 5.5 already wired).

---

## 4. Product Card Intelligence

`ProductCard.tsx` today shows a store-logo badge, an organic badge,
price/discount/unit-price, a Best-Value ribbon (comparison view only),
rating, size, and fulfillment chips — real data, no inference. Phase
5.5 added "Why CartIQ chose this" to `ProductDetailScreen`, one tap
deeper. The gap: nothing on the card itself, in a Search/Compare/
Planner grid, hints that this app tracks anything about a product
beyond its current listing.

Two additions are honestly supportable with zero new data sources:

- **A price-trend glyph**, sourced directly from
  `priceHistoryService.getStats` (already computed, already gates on
  ≥2 real observations before returning anything) — a small up/down
  arrow on the card, the same `trend` field `PriceHistoryBlock` already
  renders on the detail screen, one level shallower.
- **A "bought before" mark**, sourced directly from
  `purchaseHistoryService.isProductPurchased` — a boolean, already
  computed, already real.

**Explicitly not recommended:** putting `cartSuggestionService`'s
"usually bought with" pairings on the card grid itself (it's a
post-add, Cart-context feature; showing it pre-add on every card in a
search grid is clutter without a clear "why now"), and — this is the
one worth stating plainly against temptation — **never using any of
this to re-rank or re-sort a result grid.** Every signal above stays a
read-only badge. Re-ordering results by an inferred "recommended for
you" score would touch the optimizer/ranking boundary this app has
never crossed, and is explicitly out of scope.

---

## 5. Evidence-Based Proactive Recommendations

The reasoning discipline is already right — every existing suggestion
source (`getPantryReminders`, `estimateAllInventory`,
`getShoppingSuggestions`, `compareSessionToHistory`,
`getBestValueSummary`) cites a real field or a real stored statement,
never an inference. What's missing isn't more signals; it's a second
channel for the ones that already exist. §1 covers the delivery
mechanism (local scheduled notifications, an in-app badge). This
section is the guardrail: **Phase 6 must not loosen the evidence bar to
have more to say.** Concretely, ruled out for this phase:

- Inferring anything from `householdSize` (still no real per-person
  consumption data — same conclusion Phase 5.5's own review reached).
- Inferring dietary need, mood, or occasion beyond what
  `occasionService`'s existing deterministic calendar/date logic already
  computes.
- Any suggestion whose `reason` can't be traced to one real field —
  the exact test every suggestion service in this app already has to
  pass; Phase 6 adds delivery, not a new tier of "softer" inference to
  fill a notification calendar.

---

## 6. Voice Assistant Future Integration

`voiceService.ts`/`voiceAssistantService.ts` are fully built and
completely unwired — confirmed zero UI references anywhere outside
their own tests. Three independent existing docs
(`assistant_phase5_roadmap.md`, `architecture_review.md`,
`assistant_ai_integration_review.md`) already flag this as a known,
real, not-yet-built gap, including the mic/permission-and-disclosure
UX. This review agrees with their placement decision — the mic belongs
inside `AssistantScreen`'s own input row, not a homepage mic (a
homepage mic would ambiguously suggest voice *search*, a different,
unbuilt feature).

What's actually new work, sized honestly:

- **A mic button + permission/consent flow** — real, new native
  surface area (a first-time "why we need your microphone" moment,
  platform permission prompts), not "just wire it up."
- **A real provider registered through the existing seam**
  (`setSpeechRecognitionProvider`) — the abstraction doesn't need
  redesigning, it needs an actual implementation. The lowest-risk choice
  is a platform built-in/on-device recognizer (no third-party API cost,
  no additional data leaves the device) over a paid cloud STT API.
- **Text-only responses first, TTS deferred.** Every existing doc that
  touches voice output agrees responses must stay template-based, never
  LLM-generated — reuse the exact same `formatAssistantResponse` text
  already on screen. Speaking that text back (real TTS) is a legitimate
  second slice, not required for the first.

**Recommendation for Phase 6 specifically:** treat this as a scoped
"voice MVP" — mic button, on-device STT only, feeding the existing
`runVoiceAssistantTurn` → `send()` pipeline, text response only — and
treat full bidirectional voice (TTS, cross-platform provider parity) as
a follow-on. The permission/consent UX is the part most worth getting
right before any of the rest; it's also the part every other
audit has independently flagged and none has built.

---

## Explicitly Not Recommended

Restated against this phase's own temptations, not as a generic list:

- **Autonomous shopping.** A pantry reminder or a local notification
  (§1) must never auto-add anything to a cart. `dispatchIntent`'s
  confirmation-gated `add_to_cart` remains the only path, unchanged.
- **Automatic purchases.** No checkout/payment integration exists or
  is proposed anywhere in this review; a Route/pickup completion
  remains a shopper's own real-world action, never something this app
  triggers.
- **Hidden AI inference.** Every new signal in §1/§5/§6 must trace to a
  real field, a real stored preference, or an explicit statement — the
  same bar Phase 5.2 onward already enforces. Nothing here proposes
  softening it under demo pressure.
- **Fake personalization.** §3's "Try a Demo" idea is the one place
  this risk is real; it is only acceptable as an explicitly-labeled,
  opt-in sample path, never silent seed data on a real account. If in
  doubt, skip it — the zero-build demo-script alternative costs nothing.
- **LLM-generated product choices.** Every product anywhere in this
  review — card badges, substitutions, pairings, suggestions — continues
  to come from real search/optimizer/hand-curated data, never a
  generated or invented name.

---

## Ranked Candidate Features

Difficulty and Safety Risk: lower is better. Competition Impact, User
Value, and Architecture Reuse: higher is better.

| # | Feature | Competition Impact | User Value | Difficulty | Architecture Reuse | Safety Risk |
|---|---|---|---|---|---|---|
| 1 | First-Home hint pointing at the Assistant tile (§2) | Medium | High | Low | High (`ContextualHint`, existing key) | None |
| 2 | Optional preferred-store question at sign-up (§2) | Low | High | Low | High (`shopperPreferenceService`) | None |
| 3 | Demo-script for Magic Moment, no code (§3) | High | — | None | — | None |
| 4 | Consolidate `AdvisorCard` into `HomeInsightsStrip` (§1) | Medium | Medium | Low | High (pure refactor) | None |
| 5 | In-app "signals available" badge on Assistant tile (§1) | Medium | Medium | Low | High (existing suggestion sources) | None |
| 6 | Price-trend glyph on `ProductCard` (§4) | Medium | Medium | Low | High (`priceHistoryService`) | None |
| 7 | "Bought before" badge on `ProductCard` (§4) | Low | Medium | Low | High (`isProductPurchased`) | None |
| 8 | Local scheduled pantry notifications (§1) | High | High | Medium | Medium (needs `expo-notifications` + permission UX) | Medium (new permission, consent copy must be right) |
| 9 | Voice MVP — mic + on-device STT, text response (§6) | High | Medium | Medium–High | Medium (voice service already built; UI/permission is new) | Medium (new native permission, no cloud dependency) |
| 10 | Labeled "Try a Demo" seeded sample account (§3) | High | Low (judges only) | Medium | Medium | Medium (must never blur into real personalization) |
| 11 | Full voice — TTS + provider parity across platforms | Medium | Medium | High | Medium | Medium |
| 12 | Server-side push infra (persistent users + token registry + scheduler) | Low (invisible unless #8 already shipped) | High (long-run) | High | Low (no such backend layer exists today) | Medium |

---

## Recommended Focused Phase 6 Scope

**Ship, in this order:** #3 (demo script — do this regardless of
anything else, it's free), #1, #2, #4, #5, #6, #7. All seven are Low
difficulty, High architecture reuse, and effectively zero safety risk —
together they make the app visibly smarter on Day 1 of a new account,
close the "invisible assistant" onboarding gap, and give judges a
scripted path to the app's best moment, without touching the safety
boundary, the optimizer, or any new permission.

**Stretch, only if time allows:** #8 (local pantry notifications) or #9
(voice MVP) — pick **one**, not both; each is a real new permission
surface with its own consent-copy work, and this phase should get one
right rather than two half-finished. Given this app's own past docs
have flagged voice as the longer-standing, more competition-visible gap,
#9 is the marginally stronger pick if forced to choose — but #8 is more
directly "daily companion," so the choice should follow whichever of
those two framings Phase 6 actually wants to lead with.

**Explicitly deferred, not this phase:** #10 (needs careful, separate
sign-off on the demo-account framing before any code), #11 (depends on
#9 landing first), #12 (a real infrastructure project — persistent
server-side users, push token registry, a scheduler — that doesn't fit
inside a feature-sized phase and should be scoped on its own if the
product direction ever needs a true outside-the-app companion).

**Unchanged, as in every prior phase:** `dispatchIntent` remains the
only Intent execution gateway; no autonomous cart mutation; no
LLM-generated products, prices, or preferences; no inferred preferences;
no fabricated explanations; the existing cart confirmation flow is
untouched by anything in this review.
