# CartIQ AI Architecture — Master Design

This is the top-level architecture that everything in `docs/
ai_grocery_assistant_design.md` (feature-level algorithms: shopping-list
intelligence, quality assessment, voice, memory, inventory, optimization)
and `docs/client_assisted_data_engine.md` (data/adapter layer: store
adapters, canonical product matching, trust scoring) plugs into. Those two
docs answer "how does feature X work." This doc answers "why does the
whole system not turn into 20 features bolted side by side" — which is the
actual hard problem once the feature list reaches A–I plus problems 1–12.

No implementation code below, by design — this is the shape of the
system, not its code.

---

## 1. High-level architecture

Five layers, strictly ordered — a layer only ever calls the layer below
it, never the other way, and user-visible surface area is deliberately
concentrated in the top and bottom layers, not the middle three:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. INTERACTION LAYER                                         │
│    Tabs (Shop/List/Route/Profile), search bar, camera capture,│
│    the universal voice/text entry point.                     │
│    Contains ZERO intelligence — forwards raw input down,      │
│    renders whatever layer 5 hands it back, nothing else.      │
└───────────────────────────┬───────────────────────────────────┘
                             │ raw input (text / voice / photo / tap)
┌───────────────────────────▼───────────────────────────────────┐
│ 2. INTENT & ORCHESTRATION LAYER                                │
│    The Intent Router + the Generators (meal planner, occasion  │
│    detector, nutrition analyzer, budget-constraint resolver).  │
│    Turns "what the user/system wants" into a call against      │
│    layer 3 — never answers from its own knowledge.             │
└───────────────────────────┬───────────────────────────────────┘
                             │ structured calls (search(), buildList(), optimize()...)
┌───────────────────────────▼───────────────────────────────────┐
│ 3. DOMAIN & EXECUTION LAYER                                    │
│    Everything CartIQ already does: price comparison, store  │
│    adapters, shopping list/cart, route optimization, purchase  │
│    history, product comparison — PLUS the new domain facts:    │
│    canonical product + nutrition attributes, store hours/      │
│    closures. This is the only layer allowed to know real       │
│    prices, real routes, real inventory facts.                  │
└───────────────────────────┬───────────────────────────────────┘
                             │ candidate results / candidate insights
┌───────────────────────────▼───────────────────────────────────┐
│ 4. TRUST & ARBITRATION LAYER                                   │
│    Confidence scoring, the single ranked-suggestion queue,     │
│    dismissal memory. Decides IF anything reaches the user, and │
│    which ONE thing, out of everything layers 2-3 produced.     │
└───────────────────────────┬───────────────────────────────────┘
                             │ at most one insight / one recommendation
┌───────────────────────────▼───────────────────────────────────┐
│ 5. PRESENTATION LAYER                                          │
│    Three reusable shapes only: the advisor card, the           │
│    before/after-plus-undo action sheet, the mode selector.     │
│    Every feature renders through one of these three — never a  │
│    bespoke screen.                                             │
└─────────────────────────────────────────────────────────────────┘
```

The load-bearing property of this diagram: **layers 2 and 3 can grow
arbitrarily (new generators, new domain facts, new adapters) without
layers 1, 4, or 5 changing at all.** That's what makes "deep intelligence,
simple interface" a structural guarantee instead of a discipline someone
has to remember to apply on every new feature.

---

## 2. Core intelligence layers

Naming these as capabilities, distinct from the data-flow diagram above:

1. **Perception** — turns analog input into structured signal: speech →
   transcript, photo → visual assessment + OCR'd text, list text → tokenized
   items. Nothing here interprets *intent*, it only extracts *content*.
2. **Understanding** — the Intent Router. Takes perceived content (or an
   internally-generated trigger — a cart change, a location update, a
   clock tick) and resolves it to one of a **closed, enumerated set of
   actions** the system actually knows how to perform. This is the layer
   that enforces "use existing systems, never hallucinate" — the router's
   only job is picking *which* real function to call and *what* arguments
   to call it with; it is structurally incapable of answering a question
   itself.
3. **Domain knowledge** — the facts: canonical products + nutrition
   attributes, prices, store capabilities + hours, purchase history,
   personalization/inventory estimates. Every other layer reasons over
   this layer's facts; none of them are allowed to maintain a competing
   copy of the truth.
4. **Generation** — takes a resolved intent plus domain facts and produces
   a *candidate* (a shopping list, a re-optimized plan, a substitution, a
   nutrition summary). Generation output is always in a shape the domain
   layer already understands (a list of product queries, a set of
   constraint weights) — a generator is a **producer of ordinary inputs**
   to the existing systems, never a second implementation of them.
5. **Trust & arbitration** — confidence scoring + the single ranked queue
   + dismissal memory. The only layer with veto power over whether the
   user sees anything at all.
6. **Presentation** — the three reusable shapes (§1, layer 5). Deliberately
   the smallest, most stable layer in the system.

---

## 3. How features connect

None of problems 1–12 or capabilities A–I are independent builds. Each is
a specific path through the five layers above, mostly reusing the same
few primitives. The point of this table is that **the marginal cost of
each new capability should be "one more Generator" or "one more domain
fact," not "one more architecture."**

| Capability | Perception | Understanding | Domain facts touched | Generation | What's genuinely new vs. reused |
| --- | --- | --- | --- | --- | --- |
| Cheapest/best place to buy (1) | — | search intent | prices, store adapters | — | fully existing |
| What to buy (2) / Auto shopping lists (9) | text | occasion/list intent | purchase history | occasion detector | new Generator only |
| Product quality (3) | camera/OCR | quality-check intent | — | vision assessment | new Perception + Generation |
| Product healthiness (4) / Nutrition (11) | — | nutrition-question intent | **nutrition attributes (new domain fact)** | nutrition analyzer | needs domain fact added first |
| Remembering common purchases (5) | — | (internal trigger) | purchase history, inventory estimate | — | mostly existing (`getPantryReminders`) |
| Food waste prevention (6) | — | (internal trigger) | inventory estimate | meal-idea generator | depends on (5)'s inventory extension |
| Budget adherence (7) | — | budget-intent / constraint | **budget-as-constraint object (new)** | optimizer (existing, parameterized) | new constraint object, existing optimizer |
| Meal planning (8, H) | text | meal-plan intent | nutrition attributes, prices | meal planner | new Generator, output is an ordinary list |
| Voice interaction (10, G) | speech | *is* the router's front door | all of the above | — | new Perception + Interaction; zero new domain logic |
| Trip optimization by goal (12, E) | — | optimize-intent w/ mode | prices, routes, nutrition, ratings | optimizer (existing, extended) | new scoring dimensions only |
| Store reliability (I) | — | (constraint check inside every store/route decision) | **store hours/closures (new domain fact)** | — | new domain fact, filters existing generation |

Three worked connections, because the table alone hides the most important
part — that a new capability is *shallow* if it's designed correctly:

**Meal Planner (H).** Perception: none (typed/spoken meal idea).
Understanding: `mealPlan` intent, slots = {dish, dietary goal}. Generation:
the meal-planner Generator turns "beef and broccoli with rice" into an
ingredient+quantity list — and then **stops**. That list is handed to the
exact same pipeline a manually-typed list already goes through: search →
cart → the existing planner/optimizer → route. CartIQ's actual
differentiator ("also finds the cheapest way to buy the ingredients") is
not new code — it's this Generator being thin enough to fall straight
through to systems that already exist. If the meal planner ever needs its
own price logic, that's the signal something was designed wrong.

**Voice as main entry point (G).** Voice does not get its own copy of
search, cart, or optimization — it is a second Perception path into the
*same* Understanding layer every tap-driven action already goes through.
"Build my weekly groceries," "analyze my grocery list," and "add
ingredients for chicken biryani" are three different intents resolving to
three different Generators (repurchase-prediction, nutrition analyzer,
meal planner) — the router's job is only to tell those apart, never to
answer any of them directly from model knowledge. This is also why F (the
"nutrition chatbot") is not a separate thing — it's one intent family the
same router already has to support.

**Budget (C).** A budget is not a screen, a dashboard, or even really a
"feature" — it's a constraint object (`{type: weekly | paycheck | per-
trip, amount}`) that the existing optimizer and Advisor layer already know
how to consume, because `budgetService`'s over/approaching logic already
exists. Adding paycheck-based and one-trip budget types is a change to
*what can populate the constraint object* and *when the Advisor layer
checks it*, not a new subsystem.

---

## 4. Shared infrastructure

Everything above only stays coherent if these pieces are built **once**,
shared by every capability, and never quietly re-implemented per feature:

- **The single ranked-suggestion queue + dismissal memory** (Trust layer).
  Every insight kind — existing and new (occasion, low-stock, budget,
  quality-check nudge, nutrition-gap nudge) — is one more candidate into
  one `pickTop()`-style call, one dismissal store. This is the single
  most important shared piece in the whole system, because it's the only
  thing standing between "12 problems solved" and "12 things nagging the
  user."
- **One before/after-plus-undo action sheet.** Auto-optimize, budget-driven
  substitution, and meal-plan-to-cart all end at "here's the plan, apply
  or don't, undo if you change your mind" — one component, not one per
  feature.
- **One mode selector.** Cheapest / fastest / fewest-stores / healthiest /
  highest-protein / best-quality / balanced are seven labels on the same
  control, never seven settings screens or a weighting UI.
- **The Intent Router + closed action vocabulary.** Shared by voice, typed
  text, and internal system triggers alike — this is what lets "the
  assistant" and "the app" be the same system instead of two.
- **Canonical product + nutrition attribute model.** One product identity
  that price comparison, meal planning, and nutrition analysis all resolve
  against — never a second per-feature notion of "what product is this."
- **Store capability + hours/availability registry.** Extends the store-
  adapter model so "is this store open right now" is a fact every
  route/recommendation decision can check, not a per-feature lookup.
- **Purchase history + derived signals** (personalization profile,
  inventory estimate, repurchase intervals) — one substrate, read by
  shopping-list intelligence, memory, food-waste prevention, and budget
  personalization alike.
- **The budget-as-constraint object.** One shape, accepted by the
  optimizer and checked by the Advisor layer, regardless of which of the
  three budget types produced it.

If a new feature is about to introduce its own version of any bullet
above, that's the signal it's being designed as a silo, not as one more
path through the shared architecture.

---

## 5. What should NOT become separate features or screens

This is the enforcement mechanism for "the user should not manage the
AI" — every item below is a capability from the brief that is real and
worth building, deliberately expressed as *not* a destination:

- **No "Nutrition Chat" screen.** Nutrition Q&A is a conversation the
  universal assistant (G) already has to support — a second chat surface
  would fragment the one entry point the whole design depends on.
- **No "My Fridge" / inventory screen.** Household memory (B) stays
  invisible infrastructure feeding the Advisor queue — a screen to *look
  at* your inventory reintroduces the manual-management burden the brief
  explicitly rules out.
- **No standalone "Meal Planner" tab.** It's a text/voice intent that ends
  on the existing List screen with a normal, editable list — not a
  separate wizard with its own review/confirm flow.
- **No "Store Hours" screen.** Reliability (I) is a filter inside routing
  and store recommendation, surfaced only when it changes a decision
  ("Kroger closes in 20 minutes — Sprouts is open later"), never a
  browsable directory.
- **No budget dashboard/spend charts.** Budget (C) stays a single
  settable constraint plus the existing one-card Advisor warning — a
  history/analytics view is a dashboard, which the brief explicitly rules
  out.
- **No quality-check history/gallery.** Each camera scan (D) is one
  ephemeral card, answered and gone — not a saved log to browse later.
- **No dedicated "Assistant" tab in the bottom nav.** Voice/text (G) is a
  cross-screen entry point reachable from wherever the user already is
  (the existing search bar's natural extension), not a destination you
  navigate *to* — making it a tab would contradict "main entry point" by
  turning it into one more menu item competing with the others.
- **No per-feature notification/inbox list.** Every "the AI wants to tell
  you something" moment — across all A–I — resolves through the one
  Advisor slot. A separate notification center for, say, budget alerts
  while pantry reminders live somewhere else would recreate the exact
  multi-surface clutter §0/§4's shared queue exists to prevent.
- **No settings screen for optimization weights.** The mode selector (E)
  is seven labels, not seven sliders — if a user ever needs to *tune* a
  weight rather than *pick* a mode, that's a sign the wrong seven labels
  were chosen, not a case for exposing the underlying weights.

---

## 6. Phased roadmap

Sequenced by **dependency**, not just impact — several flagship
capabilities (Meal Planner, Nutrition Assistant, "healthiest"/"highest
protein" modes) are only trustworthy once earlier phases' domain facts
exist, so building them first would mean shipping a hollow version now and
redoing it later.

**Phase 0 — Shared infrastructure.** The single ranked queue + dismissal
memory, the one action sheet, the one mode selector, the Intent Router
skeleton (wired to existing search/cart/planner even before voice exists —
it should have real callers from day one), and the store hours/closures
fact extended into the store-adapter model with "never recommend a closed
store" enforced as a filter in routing. This phase ships **zero new
user-visible features** — it's the guarantee that everything after this
point composes instead of sprawling. Store reliability is pulled this
early deliberately: recommending a closed store is a trust failure, not a
missing nice-to-have, and it only gets more visible as later phases make
the app recommend stores more assertively.

**Phase 1 — Extend what already (mostly) works.** Cheapest/fastest/fewest-
stores/balanced modes through the new mode selector, substitution-trigger
fix, shopping-memory dismissal + list-similarity, and the budget object
generalized to weekly/paycheck/per-trip, feeding the existing optimizer.
No new AI model dependency yet — this phase is pure leverage on code that
already exists.

**Phase 2 — Domain facts that unlock everything downstream.** Occasion
detection (rule-based), the household inventory/depletion model, and —
the biggest lift in this phase — canonical product + nutrition attribute
data wired in (Open Food Facts extension). Nothing in Phase 3 or 4 that
touches "healthy," "protein," or "nutrition" is trustworthy before this
phase lands.

**Phase 3 — Voice as the primary interaction surface, and camera quality
assessment.** The Intent Router gets its real front door (device-native
speech in, `expo-speech` out) and starts resolving the fuller intent
vocabulary (search, add, optimize, "build my weekly groceries," basic
nutrition questions) against Phase 1-2's now-real domain facts. Camera-
based quality assessment ships alongside it as the other genuinely new
Perception surface, with hedged, non-diagnostic language enforced and
tested per `ai_grocery_assistant_design.md` §2.3.

**Phase 4 — Generative, compounding capabilities.** Meal Planner (full
idea → list → price comparison → optimization → route pipeline), full
Nutrition Assistant conversation depth (macro/micro gap analysis against
stated goals), "healthiest"/"highest-protein"/"best-quality" optimization
modes, and food-waste prevention (meal-idea suggestions triggered by the
Phase 2 inventory model). This phase is where the brief's most ambitious
asks land — deliberately last, because every one of them is a Generator
sitting on top of facts and infrastructure the earlier phases had to
build first for these to be trustworthy rather than impressive-looking
demos.
