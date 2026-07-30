# Competition Readiness Review

**Status: review only. No code has been changed to produce this document.**

This reviews CartIQ as it stands after Phases 3.0–6: a deterministic,
safety-gated Assistant Boundary with an optional (off-by-default) LLM
escalation tier; a real multi-store price/route optimizer; evidence-only
explanations at both plan and product grain; persisted session history
with a real comparative savings callout; a homepage that surfaces real
intelligence before being asked; a pantry check-in surface; and a
targeted, non-wizard onboarding fix. The question this document answers
is narrow: **can a judge understand why this is different within 30
seconds, and what, specifically, is standing in the way of that today?**

Every claim below was checked against the current code, not assumed.

---

## 1. Current Competition Strengths

**vs. traditional grocery list apps** (AnyList, OurGroceries, a plain
notes app): those manage a checklist. CartIQ does too, but a
checklist is the floor here, not the ceiling — nothing in that category
compares prices across retailers, plans a real multi-stop route, or
explains why an item is on the list at all.

**vs. price comparison apps** (Flipp, Basket, retailer circulars):
those show a price. CartIQ shows a price **and** plans the actual
trip around it — real driving time/distance via `tripPlanner.ts`, a
real budget check, and a real explanation of why one plan beat another.
Almost none of that category plans the trip, only the price.

**vs. AI shopping assistants** (the broad current category of "ask an
AI to shop for you" products): most are a chat interface loosely
wrapped around a cart, with no visible boundary between "the model
said something" and "the app did something." CartIQ's
`dispatchIntent()` is a genuinely rare, **demonstrable** property in
this category: a closed-vocabulary `IntentType`, a confidence-gated
policy layer, and cart mutations that require an explicit confirmation
regardless of how confident the classifier was. A judge can be shown a
request being *refused* and told exactly why in one sentence — most
competitors in this category can only be shown a request *succeeding*.
The hybrid classifier tier (`backend/src/services/intentClassifierService.ts`)
is real, tested code, but ships **off by default** (`LLM_API_KEY` blank
in `.env.example`) — worth describing accurately as "a real, reviewed
LLM-escalation seam that doesn't need to be turned on for the
deterministic router to handle this app's own demo script," not as "an
LLM is currently classifying your requests."

**vs. grocery delivery apps** (Instacart and similar): those have a
structural conflict of interest — they profit from one retailer's
basket, not from finding you the cheapest one. CartIQ's core premise
(cross-retailer optimization) is one delivery apps have no reason to
ever build.

**The six requested differentiators, checked against real code:**

| Differentiator | Real? | Where |
|---|---|---|
| Multi-store optimization | **Yes** | `shoppingPlanOptimizer.ts` brute-forces store subsets; `tripPlanner.ts` computes a real route |
| Savings intelligence | **Yes, evidence-gated** | `shoppingHistoryInsightService.ts`'s comparison against a shopper's own real prior sessions; `HomeInsightsStrip`'s "Saved $X last trip" |
| Explainability | **Yes, at two grains** | `explainRecommendation` (plan) / `explainProductSelection` (product) — every reason carries `evidence` pointing at a real field |
| Safety-first AI architecture | **Yes** | `dispatchIntent()` sole gateway, `intentPolicy.ts` confidence gates, confirmation-required cart mutations |
| Conversational shopping | **Yes** | `AssistantScreen.tsx` → `start_shopping_session`, real clarification questions, real quick-reply chips |
| Personalization | **Real, but modest — don't overclaim** | `ShopperPreferences` (explicit statements only, never inferred), `IntelligenceStatusCard`, purchase-pattern pantry reminders. This is deterministic pattern-matching over real data, not machine-learned personalization — describe it that way to a judge, not as "the AI learns you." |

Nothing above is aspirational; every row is a currently-running code
path.

---

## 2. The 30-Second Demo Experience

**Screen that should open first: Home (`SearchScreen`), search-focused,
exactly as it does today.** Search is this app's honest floor — it's
what makes CartIQ legible in the first two seconds as "a grocery
price app," before asking a judge to trust anything more ambitious. Do
not open on the Assistant; a blank chat box with no context is a worse
first five seconds than a hero search bar with visible store names.

**What should be visible immediately:** the hero search card (unchanged
value prop line: "Compare grocery prices, instantly"), and — this is
the one change this review recommends (see §7, P0) — an unmistakable,
one-tap path into the Assistant's flagship flow. Today that path exists
(`QuickActionsRow`'s "Ask CartIQ" tile) but is visually equal-weight
with "Smart Planner," which undersells the single most differentiated
thing in the app.

**What should stay hidden until needed:** everything already hidden —
filter/sort controls, the by-store product grid (progressive
disclosure via `PlanStoreSection`'s collapsible header), price-history
sparklines, certifications. None of this needs to change; the existing
"teach only what's relevant" discipline is correct for a demo audience
too.

**The ideal 30-second path, mapped to what's real today:**

1. Judge opens the app → Home, search-first, real store names visible
   in the subtitle. *(already true)*
2. Judge taps into the Assistant (ideally one tap from Home — see §7)
   and types or taps a real prompt: **"Help me save money this week."**
3. Assistant asks at most one real follow-up (goal, or a list) —
   already fast, already deterministic. *(already true)*
4. A real plan renders: stats row (stores selected / estimated savings
   / items found) at a glance, real product cards expanded by default.
   *(already true, as of this phase's own Part 1 polish)*
5. Judge asks "why did you choose this?" — `WhyThisPlanCard` is
   already rendered automatically, no extra tap. *(already true)*
6. Judge runs the assistant a second time with a slightly different
   list — the "CartIQ found you a better plan" comparative banner
   appears, with a real percentage against the shopper's own real prior
   average. *(already true, but requires the SECOND request — see §5/§6)*

**The wow moment is step 6, not step 4.** Step 4 (a sentence becoming a
real, multi-store, priced plan) is impressive but is quickly converging
with what several "AI shopping" competitors will also show. Step 6 — a
real, personal, numeric "you're doing better than your own average" — is
the one thing this category rarely demonstrates honestly, because most
competitors don't have a real prior-session baseline to compare against.
CartIQ does, but only after a second real request — which is a
demo-script fact to plan around, not a code gap to close.

---

## 3. Homepage Review

**Is search still clearly primary?** Yes. The hero remains full-width,
first, and visually dominant — unchanged since Phase 5.4's redesign.

**Are Assistant and Planner visible enough?** Visible, but
under-weighted relative to their actual importance. Both sit in
`QuickActionsRow` as two equal, compact, same-size tiles. That was the
right call when Planner and Assistant were two roughly-equivalent
secondary features (Phase 5.4). It undersells the Assistant today, now
that it's the single flow that reaches every other differentiator in
this app (explanations, savings comparison, session memory). This is
the one homepage change this review recommends — see §7, P0.

**Is the screen visually balanced?** For a brand-new or signed-out
account, yes — hero, `QuickActionsRow`, and a clean empty state, nothing
more. **For a returning account with real history — the exact account a
demo would use to show off intelligence — it is not.** In that state,
Home stacks, in order: the hero, `HomeInsightsStrip` (chips),
`PantryCheckInCard`, `QuickActionsRow`, a one-time `ContextualHint`, and
`AdvisorCard` — up to **four independent bordered/tinted surfaces**
between the hero and the actual search results, each correctly
evidence-gated on its own, but with nothing arbitrating between them as
a group. Each of `HomeInsightsStrip`/`PantryCheckInCard`/`AdvisorCard`
follows the right rule in isolation ("render nothing without real
evidence") — the gap is that nothing decides "at most one of you shows
today," the way `AdvisorCard`'s own internal `pickTop` already does
*within* itself.

**Too many competing cards?** For a fresh/demo-seeded account with a
believable amount of real history (which is exactly the account a
judge would be shown): yes, this is real and worth fixing before
competition — not by merging the underlying services (Part 3 of the
prior phase already re-confirmed `advisorService`/`assistantSuggestionService`
should stay separate at the data layer), but by giving Home a single
visual "Today" priority order so these don't all fire onto the screen
at once. See §7, P0.

**Recommendation:** one layout change (P0, §7) — consolidate/prioritize
the passive intelligence surfaces so at most one or two show at a time,
in a stable order. Everything else on Home is working correctly and
should not be redesigned.

---

## 4. Shopping Plan Experience Review

Reviewed: `PlannerScreen.tsx`, `ShoppingSessionPlanCard.tsx`,
`PlanResultsView.tsx`, `PlanItemProductGrid.tsx`, `ProductCard.tsx`.

- **Can a user understand the complete plan quickly?** Yes. The stats
  row added this phase (stores selected / estimated savings / items
  found) puts the three numbers that matter in one glance, above the
  prose explanation rather than buried inside it.
- **Are products visible enough?** Yes — `showProducts` now defaults to
  `true` in `ShoppingSessionPlanCard`; a shopper sees real product
  cards without an extra tap. `PlanResultsView` (the Planner's own
  results screen) shows them by default too, grouped by store.
- **Is store grouping intuitive?** Yes — numbered badge, store name,
  item count, subtotal, collapsible chevron (`PlanStoreSection`) is a
  familiar, standard pattern; no changes needed.
- **Are savings obvious?** At the plan level, yes (stats row + the
  "Magic Moment" banner when real prior history exists). At the
  *product* level, less so — `ProductCard`'s `whyChosenBadges` are
  small, two-line-capped text under the price, easy to miss at a glance
  in a dense grid. Functionally correct, visually quiet — the same
  category of issue the Phase 5.5 review already flagged for
  `WhyThisPlanCard` before it was given more visual weight.
- **Are explanations discoverable?** Yes, and this is worth stating
  plainly: `WhyThisPlanCard` renders unconditionally (when real evidence
  exists) — not behind a toggle. A judge never has to know to ask for
  it.
- **Does it look like a competition-level product?** Mostly yes, after
  this phase's own polish. The remaining gap is proportion, not
  correctness: the plan's single strongest differentiator (the
  comparative savings banner) currently uses the same plain mint-box
  treatment as several lower-stakes banners in this app, so it doesn't
  visually announce itself as the moment it actually is. See §7, P1.

---

## 5. Missing "Magic Moment"

| Candidate | Built today? | Can be honestly demoed? |
|---|---|---|
| A. "Help me save money this week" → optimized multi-store trip | **Yes, fully** | Yes |
| B. "Why did CartIQ choose this?" → explainable recommendation | **Yes, fully** | Yes — but as a supporting beat, not an opener (see below) |
| C. "CartIQ saved me $X vs. my normal shopping" | **Yes, fully** (`historyComparison`) | Yes, but only from a second real request |
| D. Voice grocery planning | **No UI** (`voiceService`/`voiceAssistantService` exist, zero UI wiring) | **No — do not demo this** |
| E. The safety refusal moment (trying to force an unconfirmed cart add) | **Yes, fully** | Yes — a strong secondary beat |

**Chosen primary moment: A, immediately closed out by C** — one
coherent two-beat script, not two competing options. Run the sentence
once (a real, complete, multi-store priced trip appears in seconds);
run it again with a slightly different ask, and let the real
comparative "CartIQ found you a better plan — N% more than your
usual average" banner appear on its own. This is the same conclusion
the Phase 5.5 review reached before the comparison feature existed;
it's now actually built, and this review is simply confirming it's
ready to be the headline.

**B** (explanations) is real and should absolutely appear inside the
same demo — a judge asking "wait, why this store?" mid-script and
getting a specific, evidence-backed answer is a strong follow-up beat —
but it is not, on its own, a strong *opener*: "here's a checklist of
reasons" is less immediately legible than "here's your optimized trip."

**D** is explicitly ruled out — not because voice wouldn't be
impressive, but because this app cannot currently demonstrate it
honestly (no mic button, no permission flow, no wired provider). Per
this phase's own constraint ("do not add features that cannot be
honestly demonstrated"), voice stays out of the demo script entirely
until it's real.

**E** is a legitimate, low-cost secondary beat worth keeping in reserve
if a judge pushes on safety specifically, but doesn't need script time
by default.

---

## 6. Competition Weaknesses

**Critical — fix before competition:**

- **The flagship moment (§5) requires a second request, and a fresh
  install has no history to compare against.** Not a code defect —
  `compareSessionToHistory` correctly refuses to fabricate a comparison
  with no real prior data — but it means a judge trying the app cold,
  once, will never see it. Mitigation is a rehearsed two-request demo
  script (§7, P0) — zero code, but must actually happen.
- **Homepage card-stacking for exactly the account a demo would use**
  (§3). Undermines the "instant clarity" goal this whole review exists
  to protect, specifically for a shopper with enough real history to
  otherwise make a great demo.
- **The Assistant is still visually a peer of the Planner, not the
  headline.** The single biggest lever on "does a judge even reach the
  wow moment" is whether they open the Assistant at all in the first
  30 seconds.

**Nice-to-have:**

- Loading-state inconsistency: Search and Planner share the rich,
  animated `SearchProgress` (rotating status messages, pulsing icon);
  the Assistant's "Thinking…" state is a plain `ActivityIndicator`. Minor,
  but a judge moving between screens will notice the difference in
  polish.
- The Magic Moment banner's visual weight doesn't yet match its
  importance (§4).
- No visible "these are real, live prices" trust signal beyond the
  store logos themselves — minor, since real product photos/logos
  already do more credibility work here than most competitors bother
  with.

**Unnecessary for this phase:**

- Voice (§5) — real effort, unverifiable in this environment, no
  permission flow; correctly deferred already.
- A multi-step onboarding wizard — Phase 6's targeted, single-screen fix
  (a hint + an optional store picker) already closed the real gap;
  a wizard would reverse a deliberate design decision for no new reason.
- Any new AI-generated copy, scoring, or recommendation logic — out of
  scope by this phase's own constraints, and not needed: every
  weakness above is a presentation/sequencing problem, not a missing
  intelligence problem.

---

## 7. Implementation Roadmap

Every item below reuses existing architecture, touches no safety
boundary, and is presentation/sequencing only.

### P0 — must-have before competition

| # | Recommendation | Files | Why it matters | Complexity | Risk |
|---|---|---|---|---|---|
| P0-1 | Rehearse a two-request demo script (§5/§6) — no code | *(none — process only; optionally document in `docs/demo_script.md`)* | The flagship moment structurally requires a second request; this must be planned, not left to chance | None | None |
| P0-2 | One-tap path from Home into the Assistant's flagship flow — reuse the exact `initialPrompt` mechanism `HomeInsightsStrip` chips already use (`navigation.navigate('Assistant', { initialPrompt })`) for a prominent, always-visible "Help me save money this week" entry point, not just the equal-weight `QuickActionsRow` tile | `SearchScreen.tsx` (`QuickActionsRow`/hero area) | Shortens "time to the wow moment" to one tap; the whole demo script depends on a judge actually reaching the Assistant | Low — reuses an existing prop/pipeline verbatim | None — same pipeline already in production |
| P0-3 | Give Home's passive intelligence surfaces (`HomeInsightsStrip`, `PantryCheckInCard`, `AdvisorCard`) one shared visual priority order so at most one or two render at once, instead of every evidence-gated surface firing independently | `SearchScreen.tsx` | Directly fixes §3's card-stacking finding for the exact account a demo would use | Low–Medium — sequencing/visibility logic only, no service changes | None — no underlying service touched, `advisorService`/`assistantSuggestionService` stay separate per Phase 6 Part 3 |

### P1 — strong improvements

| # | Recommendation | Files | Why it matters | Complexity | Risk |
|---|---|---|---|---|---|
| P1-1 | Give the "Magic Moment" banner a distinct hero treatment (larger, bolder, its own accent) instead of the current plain mint box shared with other banners | `ShoppingSessionPlanCard.tsx` | The single best differentiator should look like one (§4) | Low — styling only | None |
| P1-2 | Reuse `SearchProgress` (or a shortened variant) for the Assistant's "thinking" state instead of a plain spinner | `AssistantScreen.tsx` | Visual consistency across the app's three "working" states reads as more finished | Low | None |
| P1-3 | A small, honest "real, live prices" trust line near store logos or the plan header, sourced only from real `isLiveData`/store fields — never claimed where not true | `ProductCard.tsx` or `PlanResultsView.tsx` | Judges (and real shoppers) are skeptical of AI-shopping claims by default; a small honest signal helps credibility | Low | Low — must stay strictly tied to real fields, never asserted universally |

### P2 — future ideas, not this phase

| # | Idea | Why deferred |
|---|---|---|
| P2-1 | Voice MVP (mic + on-device STT, text response) | Real native permission/dependency work, unverifiable here; §5/§6 already rule it out of the demo script for now |
| P2-2 | A clearly-labeled, opt-in "Try a Demo" seeded sample account | Needs careful, separate sign-off on framing so it never blurs into fake personalization on a real account |
| P2-3 | A deeper, unified "Today" module design (beyond P0-3's sequencing fix) | Only worth it if judging feedback specifically asks for it; P0-3 already resolves the material first-impression risk |

---

## Verdict

**CartIQ is competition-ready, conditional on P0.** The underlying
intelligence is real, evidence-gated, and — after Phases 5.5 and 6 —
genuinely visible rather than hidden in a chat log. Nothing in this
review found a capability gap; every finding here is about sequencing,
visual weight, or a script the presenter needs to rehearse, not missing
engineering. Ship the three P0 items (all presentation-only, all
low-risk, none touching the safety boundary) and rehearse the two-request
demo script, and the app is ready to make the argument this whole
review exists to protect: **a judge should be able to watch a sentence
become a real, explained, personally-comparative shopping trip inside
30 seconds — because, as of this phase, it actually can.**
