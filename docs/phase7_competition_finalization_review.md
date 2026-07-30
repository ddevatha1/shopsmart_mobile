# Phase 7 — Competition Finalization Review

**Status: review only. No code has been changed to produce this document.**

This reviews CartIQ as it stands after Phase 6.1. Every finding below
was checked against the current code — including one specific,
previously-unnoticed bug (§3C) that materially undercuts this app's own
best demo moment. **No code is touched until this review is approved.**

---

## 1. What a Judge Notices in the First 30 Seconds

Different competitions reward different things in that first glance —
worth answering per venue rather than generically:

- **Apple App Store–style competition** (design/craft-judged): notices
  visual polish and native feel first — animations, transitions, whether
  it "feels like a real app." CartIQ's motion system
  (`AnimatedPressable`, staggered card entrances, `SearchProgress`'s
  animated loading state) already reads as genuinely polished here. Risk:
  this audience is the least forgiving of the one real bug found in §3C —
  a "wow" feature that's actually there but invisible reads as *worse*
  than not having it, because it looks like an oversight, not a limit.
- **Hackathon judges**: want the core loop proven live, fast, in a tight
  time box. They forgive rough edges but not confusion about "did that
  actually work." CartIQ's strength here is that the core loop
  (sentence → real multi-store plan) is genuinely real and fast — the
  risk is entirely in whether the presenter can reach it and show
  products in under ~15 seconds, which is exactly what §3C threatens.
- **Samsung-style app challenge** (real-world utility emphasis): cares
  about "does this solve a real problem for real people." Grocery
  savings is an easy, legible problem to state; the danger here isn't
  the pitch, it's if the demo can't visibly *prove* the savings fast.
- **AI/product innovation competition**: this is the one venue that will
  actively probe "is this really AI or a wrapper," and it's the venue
  where CartIQ's least-visible asset — the `dispatchIntent` safety
  boundary, evidence-only explanations, confirmation-gated cart actions —
  is the single strongest, most differentiated thing in the app. Most
  competing "AI shopping" entries in this category are a chat UI over an
  API call with no visible safety story. CartIQ can be *shown*
  refusing an unconfirmed action and explain why in one sentence — this
  review's strongest recommendation (§4, P1) is making that story
  visible without needing a judge to ask for it.

**Common thread across all four:** the first 30 seconds are currently
spent on Home (search-first, one prioritized intelligence card, a
prominent Assistant CTA — all real, all shipped as of 6.1). That part is
in good shape. The risk isn't the first 30 seconds; it's what happens in
the *next* 15, the moment a judge actually asks for a plan.

---

## 2. The Strongest Demo Story

**"Help me save money this week" is still the right opener** — it's the
one sentence that reaches every real capability in this app in one
request: clarification, optimization, real products, savings, and
explanation. The question this review actually needed to answer is
narrower: **does the current flow deliver on that promise visibly, or
does it just compute it?**

**Verdict: the intelligence is real; the visibility has one specific,
fixable gap.** Walking the exact flow end to end against the current
code:

1. Conversational understanding — real, works today (clarification
   questions, quick-reply chips).
2. Budget awareness — real, but honestly conditional: it only visibly
   appears if the shopper stated one this turn or has a real
   `defaultBudgetTarget` preference already saved. No preference, no
   stated amount → no budget line, which is correct (never invented),
   but worth knowing before scripting a demo.
3. Multi-store optimization — real, shown in the stats row (stores
   selected).
4. **Real products — computed, but not actually visible without extra
   taps.** See below; this is the one real finding of this review.
5. Savings explanation — real, shown in the stats row and (on a second
   real request) the Magic Moment banner.
6. Why each product/store was chosen — real (`WhyThisPlanCard`,
   per-product badges), and rendered automatically, not behind a toggle.
7. Historical improvement or personalization — **personalization can
   appear on the very first request** (e.g., "matches your preferred
   store," if one was set at onboarding); **historical improvement**
   specifically requires a second real request, because
   `compareSessionToHistory` correctly refuses to fabricate a comparison
   against no prior data.

**The one real problem, found by reading the code, not assumed:**
`PlanStoreSection.tsx` still initializes `const [expanded, setExpanded] =
useState(false)`. Both real plan-rendering paths — `PlannerScreen`'s own
"Create My Plan" button (via `PlanResultsView`) and the Assistant's
"help me save money"/"create my plan" flow (via `ShoppingSessionPlanCard`)
— render each store as a **collapsed row (name, item count, subtotal)**
by default. Phase 6 Part 1 made `ShoppingSessionPlanCard`'s own
`showProducts` default to `true`, but that only controls whether the
store-section list mounts at all — each individual store section inside
it is still collapsed on its own. **A shopper (or judge) who says "help
me save money this week" today sees store names and a subtotal, not a
single product image, until they tap into each store row.** The
capability is fully real; the default value hiding it is one boolean in
one file.

This is the single highest-leverage finding in this entire review — see
§4, P0-1.

---

## 3. Competition Weakness Audit

### A. First-launch experience

A new signed-up shopper sees: the Welcome screen (one sentence, one
button, an optional store picker), then Home — search-first, no
intelligence cards yet (correctly, since there's no data), the
"Help me save money this week" CTA immediately visible, and (once, on
first Home view) a hint pointing at the Assistant's other capabilities.
This is honest and reasonably clear. **Gap:** nothing on first launch
states the actual differentiator in one sentence — "compare grocery
prices, instantly" (the hero headline) describes price comparison, which
every competitor also does; it doesn't hint at multi-store optimization,
explainability, or the assistant at all. A judge who never taps anything
would leave thinking this is a price-comparison app. Low-risk copy fix,
not a redesign — see §4, P1.

### B. Homepage hierarchy

Search is still unambiguously primary (full-width hero, first). The
Assistant CTA is now prominent (Phase 6.1). "Create My Plan" itself has
**no equivalent prominent entry on Home at all** — it's one tap inside
`QuickActionsRow`'s "Smart Planner" tile, same visual weight as it's had
since Phase 5.4, unchanged by 6.1's Assistant-focused promotion. Given
this review's Part C finding is specifically about the Planner's own
flow, that tile deserves a second look, but not a competing
full-width CTA — Home already has one hero action (search) and one
promoted secondary action (Assistant); a third loud element would undo
6.1's own decluttering work. Spatial arrangement is otherwise
competition-quality: one hero, one CTA, at most one intelligence card,
never more.

### C. Shopping plan experience — the product-visibility gap

Addressed in depth in §2. To answer the specific UX question asked:

- **Grouped by store or by item?** Both, serving different moments —
  this app already has the exact right primitive
  (`PlanItemProductGrid`) to do either with zero new rendering code,
  since it already just renders whatever `PlanLineItem[]` it's handed.
  Store-grouping (existing) answers "where do I go and what do I buy
  there" — keep it for trip logistics. An item-first flat grid (new
  *usage* of the same component, not a new component) answers "did you
  find something real for everything I asked for" — this is the one
  that should be visible immediately, since it's the fastest way to
  prove "real products" in a demo.
- **Expand/collapse?** Keep it for the store breakdown (trip logistics
  detail, correctly progressive) — just default it open, don't remove
  it.
- **Image-first cards?** Already true — `ProductCard` leads with a
  full-width product image. No change needed.
- **Quick add / alternatives?** Both already exist and don't need
  changes: `ProductCard`'s direct tap-to-add (same as Search/Compare),
  and `PlanItemProductGrid`'s real `alternativeSuggestion` rendering for
  unresolved items.

**No new product-rendering system is needed anywhere in this
recommendation** — every fix in §4's P0/P1 for this section is a default
value or a new call to a component that already exists.

### D. Explainability

Both explanation surfaces (`WhyThisPlanCard`, `ProductCard`'s
`whyChosenBadges`/`ProductDetailScreen`'s block) already received a
visibility pass in Phase 6.1 (hero border, bolder title, colored chips)
and consistent "Why CartIQ chose this" branding at both grains. This
is in good shape — the remaining risk isn't visibility, it's that §3C's
bug means a judge may never scroll far enough to see the product-level
badges at all if they never expand a store section. Fixing §3C is also,
indirectly, an explainability fix.

### E. Assistant experience

Functionally strong (real clarification, real plans, real explanations,
`IntelligenceStatusCard`'s "CartIQ knows" moment, a consistent
animated loading state as of 6.1). **Still reads as a well-built chat
screen, not a flagship AI product**, for one concrete, fixable reason:
nothing about it communicates the safety story that makes it different.
A judge who hasn't read this app's architecture docs has no way to
notice, from the UI alone, that this assistant is structurally
incapable of touching their cart without asking — the single most
defensible "this is not just a GPT wrapper" claim in the whole app is
currently invisible in the product itself. A small, honest, persistent
line near the input ("Nothing is added to your cart without your
confirmation") would make that legible passively, without needing a
presenter to narrate it or force a refusal live. Secondary, smaller
gap: the header just says "Assistant" — plain, unbranded, the only
screen in the app that doesn't say "CartIQ" anywhere on it.

### F. Demo reliability

No new dead buttons or broken flows found beyond what Phase 6.1 already
fixed. Two small items:

- `QuickActionsRow`'s "Smart Planner" tile subtitle ("Paste your list,
  get the best route") undersells what a judge is about to see — it
  reads as a route-planning tool, not "an optimized, explained,
  multi-store plan with real products," which is the actual pitch.
  Low-risk copy fix.
- "Create My Plan" (Planner's button) and "create my plan" (an
  Assistant trigger phrase) are two different real flows that produce
  visually near-identical results (once §3C is fixed) — this is fine
  and not confusing in itself, but worth knowing so a demo script
  doesn't imply they're the same button.

---

## 4. Prioritized Roadmap

### P0 — must implement before competition

| # | Recommendation | Why it matters | Reuses | Backend change | Risk |
|---|---|---|---|---|---|
| P0-1 | Default `PlanStoreSection`'s `expanded` state to `true` | Directly fixes §2/§3C — the single biggest gap between "this app is smart" and "a judge can see it," in both the Planner and Assistant flows at once | The existing `PlanStoreSection`/`PlanItemProductGrid` components, unchanged otherwise | No | None — a default-value change, not new logic |
| P0-2 | Add an item-first "everything in your plan" product grid at the top of the results (`PlanResultsView`, `ShoppingSessionPlanCard`), above the store-by-store breakdown, reusing `PlanItemProductGrid` fed the active candidate's full item list instead of one store's | Gets a judge to real product cards in the first glance, before any tap; answers §3C's "grouped by item" question directly | `PlanItemProductGrid` (existing component, new call site/input only) | No | Low — purely additive; store breakdown stays for trip logistics, nothing removed |

### P1 — high-value polish

| # | Recommendation | Why it matters | Reuses | Backend change | Risk |
|---|---|---|---|---|---|
| P1-1 | A small, persistent, honest line near the Assistant's input ("Nothing is added to your cart without your confirmation") | Makes this app's strongest, least-visible differentiator (§3E) legible without narration | Pure copy/UI; states a fact already true of `dispatchIntent` | No | None |
| P1-2 | Home hero copy: mention optimization/explainability, not just price comparison (§3A) | A judge who only reads the hero shouldn't come away thinking this is a plain price-comparison app | Copy only | No | None |
| P1-3 | `QuickActionsRow`'s "Smart Planner" subtitle rewrite to reflect the real output (optimized, explained, real products) (§3F) | Sets correct expectations before the tap | Copy only | No | None |
| P1-4 | Brand the Assistant header ("CartIQ Assistant," not "Assistant") (§3E) | Every other screen in the app says "CartIQ" somewhere; this is the one that doesn't | Copy only | No | None |

### P2 — future ideas, not this phase

| # | Idea | Why deferred |
|---|---|---|
| P2-1 | A dedicated "Create My Plan" promotion on Home comparable to the Assistant's CTA | Home already has one hero + one promoted CTA by deliberate 6.1 design; a third loud element risks re-clutter. Worth revisiting only if P0/P1 alone don't move the Planner's own visibility enough |
| P2-2 | Voice MVP, seeded demo accounts, server-side push — all previously reviewed and deferred (Phase 6) | Still real effort, still unverifiable in this environment, still outside this phase's constraints; nothing new changes that conclusion here |

---

## Constraints checked against every recommendation above

No autonomous shopping, no confirmation-safety bypass, no fake/demo
data, no LLM-generated recommendations, and no backend changes anywhere
in P0/P1 — every item is a mobile-side default value, a new call to an
existing component, or copy. This review recommends **zero new
features** — the goal throughout was making already-real capabilities
visible, per the brief.

**Waiting for approval before writing any code.**
