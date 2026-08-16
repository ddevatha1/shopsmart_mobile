/** One day's open/close time, 24-hour local time as "HH:mm" (e.g.
 * "08:00"/"22:00") — always the store's own local time, never UTC, since
 * that's what a shopper standing outside the store actually needs.
 * `open`/`close` are optional because a source can confirm a day is
 * closed (`closed: true`) without giving times at all, or can give a
 * partial reading; `closed: true` is the only thing that means "known
 * closed all day" — its absence (even with `open`/`close` also absent)
 * still means "no data," never "closed" (see storeReliabilityService.ts,
 * which is the only place any of this is interpreted). */
export interface DayHours {
  open?: string;
  close?: string;
  closed?: boolean;
}

/** Regular weekly hours only — no holiday-exception calendar. Holiday
 * closures are a real gap, but a small fraction of "never recommend a
 * closed store"'s value for a much larger ongoing data-maintenance cost;
 * deliberately deferred rather than attempted half-way here. A day key
 * ENTIRELY ABSENT from this object means "no data for this day" (unknown)
 * — never "closed." Only an explicit `DayHours.closed: true` on a
 * *present* entry means "known closed." Nothing may assume the opposite
 * of either. */
export type WeeklyHours = Partial<Record<
  'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday',
  DayHours
>>;

/** The specific physical store a product listing came from — standardized
 * across all four store adapters (see krogerLiveScraper.ts,
 * traderJoesLiveScraper.ts, sproutsLiveScraper.ts, aldiLiveScraper.ts for how
 * each one obtains this). `latitude`/`longitude` are omitted when a store's
 * own API only provides an address — routes/trip.ts geocodes it before
 * route-planning in that case, rather than failing the stop outright. */
export interface StoreLocation {
  name: string;
  storeId?: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  latitude?: number;
  longitude?: number;
  /** Which real, retailer-native source resolved this location (e.g.
   * 'kroger-api', 'aldi-instacart', 'sprouts-locator', 'traderjoes-sitemap')
   * — every locator sets this, so it's always traceable which adapter
   * produced a given address instead of the app just trusting it blindly. */
  source: string;
  /** Adapter-specific extras (e.g. a raw facility/location id) that don't
   * belong in the shared shape but are useful for debugging a specific
   * retailer's data. Never required by any caller. */
  metadata?: Record<string, unknown>;
  /** Populated only by locators with a real hours data source (currently
   * just krogerLocator.ts — see its `mapKrogerHours`); every other
   * locator still leaves this `undefined`, which is indistinguishable
   * from "we asked and got no data" and must be treated the same way:
   * unknown, never closed. Consumed by storeReliabilityService.ts's
   * `isStoreOpenNow`/`isKnownClosed`, and by shoppingPlanOptimizer.ts's
   * `excludeKnownClosedStores`, which removes a product from planning
   * consideration ONLY when its store is confirmed closed right now —
   * an unknown or open store is left completely unaffected. */
  hours?: WeeklyHours;
}

/** A minimal, extracted subset of an Open Food Facts product's real
 * `nutriments` object (see routes/productImage.ts's `extractNutrition`) —
 * never the raw ~40KB-per-product OFF payload. Per-100g basis, matching
 * OFF's own `_100g` fields (hence the field-name suffix on every one of
 * them, not just calories) — serving size varies by product and isn't
 * reliably present, so per-100g is the one basis comparable across
 * products. All the numeric fields are optional: a real product
 * frequently has partial data (e.g. sodium but no fiber) — **absence
 * must never be read as zero, and must never itself become a ranking
 * signal** (a product with `proteinGPer100g: undefined` is not "0g
 * protein" — it's "we don't know," which a mode like Healthiest must
 * treat as missing data, not as the worst possible score).
 *
 * `source` and `completeness` are the one required, always-present part
 * of this shape (whenever a `NutritionAttributes` object exists at all —
 * `ApiProduct.nutrition` itself stays optional for "no data found") —
 * `completeness` is `'complete'` only when every one of the seven numeric
 * fields below is present; any real-world partial match (the overwhelming
 * common case) is `'partial'`, which a consumer must treat as a weaker
 * signal than a fully complete match, not an equally-trustworthy one. */
export interface NutritionAttributes {
  caloriesPer100g?: number;
  proteinGPer100g?: number;
  carbsGPer100g?: number;
  fatGPer100g?: number;
  fiberGPer100g?: number;
  sugarGPer100g?: number;
  sodiumMgPer100g?: number;
  /** Open Food Facts' own A-E letter grade, when they've computed one. */
  nutriScore?: 'a' | 'b' | 'c' | 'd' | 'e';
  source: 'open_food_facts';
  completeness: 'complete' | 'partial';
}

export interface ApiProduct {
  id: string;
  name: string;
  brand: string;
  price: number;
  originalPrice?: number;
  discountPercent?: number;
  image_url?: string;
  rating: number;
  reviewCount?: number;
  isLiveData?: boolean;   // true when price comes from the live store scraper
  size: string;
  upc?: string;
  certifications?: string[];
  pricePerUnit?: string;
  store: "Trader Joe's" | 'Sprouts' | 'Kroger' | 'Aldi' | 'Albertsons' | 'Harris Teeter' | 'Tom Thumb' | 'Whole Foods Market' | 'Publix';
  storeProductUrl?: string;
  location?: StoreLocation;
  inStock?: boolean;
  pickupAvailable?: boolean;
  deliveryAvailable?: boolean;
  inStoreAvailable?: boolean;
  category?: string;
  aisle?: string;
  /** Set by /api/search's relevance classifier: 'direct' when the query
   * names the product itself, 'related' when the query only appears as an
   * ingredient/flavor/component (see routes/search.ts's classifyMatch). */
  matchType?: 'direct' | 'related';
  /** Not yet populated by /api/search — today this only flows through
   * /api/product-image's response (see routes/productImage.ts). Wiring it
   * into search results is a separate, later change; the field exists now
   * so callers can start reading it optionally without a breaking change
   * later. */
  nutrition?: NutritionAttributes;
  /** A stable cross-store product identity (see
   * services/canonicalProductService.ts), populated by /api/search for
   * every product it can confidently identify. `undefined` means
   * canonical matching didn't have enough signal for this product's
   * name/size — not an error, and every existing caller already treats
   * this field as optional (search/ranking/planner behavior is entirely
   * unaffected by its presence or absence). This is the foundation
   * future cross-store equivalence and nutrition-aware optimization
   * (Healthiest mode) will consume — nothing consumes it yet. */
  canonicalId?: string;
}

export interface CartItem {
  product: ApiProduct;
  quantity: number;
}

export interface User {
  id: string;
  name: string;
  email: string;
  zipcode: string;
  searchHistory: string[];
  weeklyBudget?: number;
}

export interface SearchRequest {
  query: string;
  zipcode: string;
  /** The shopper's real GPS fix, when the app has it — lets store selection
   * rank by their actual position instead of only the ZIP's geocoded
   * centroid (see services/locators/krogerLocator.ts). Optional; omitted
   * entirely falls back to zip-centroid resolution, same as before. */
  latitude?: number;
  longitude?: number;
}

export interface StoreStatus {
  store: ApiProduct['store'];
  /** 'unavailable' is distinct from 'error': it means this store has no
   * live data source at all right now (see albertsonsLiveScraper.ts) — an
   * expected, permanent-for-now state, not something that broke. The UI
   * should show it calmly ("temporarily unavailable"), not as a red error. */
  status: 'pending' | 'loading' | 'success' | 'error' | 'unavailable';
  count?: number;
  error?: string;
}

/** Set on the response only when the query pipeline (see
 * services/queryCorrection.ts) found a typo/spelling correction worth
 * surfacing — omitted entirely for an already-correct or unrecognized
 * query, never present with a 'none' level. */
export interface QueryCorrectionInfo {
  original: string;
  corrected: string;
  confidence: number;
  level: 'moderate' | 'high';
}

export interface SearchResponse {
  products: ApiProduct[];
  storeStatuses: StoreStatus[];
  correction?: QueryCorrectionInfo;
  /** Present on a progressive search response (see
   * services/searchService.ts's startProgressiveSearch/getSearchSnapshot)
   * — the client polls `GET /api/search/:searchId` with this to pick up
   * whichever stores were still 'pending' here as they finish. */
  searchId?: string;
}

// ── Route planning ────────────────────────────────────────────────────────

/** Where the trip starts — real GPS coordinates when available, otherwise
 * a ZIP code the backend geocodes to a center point. Never a fabricated
 * default location. */
export interface TripOrigin {
  latitude?: number;
  longitude?: number;
  zipcode?: string;
}

export interface TripRequest {
  origin: TripOrigin;
  /** One entry per physical store the cart needs to visit — the caller
   * (frontend) is expected to have already grouped cart items by
   * StoreLocation; the backend also defensively de-duplicates by address
   * in case it hasn't. */
  stops: StoreLocation[];
}

export interface TripStop {
  location: StoreLocation;
  /** Driving time/distance for the leg arriving at this stop — from the
   * origin for the first stop, from the previous stop otherwise. Always
   * computed by the routing engine, never estimated. */
  legDurationMinutes: number;
  legDistanceMiles: number;
  /** Minutes from trip start until arrival at this stop. */
  cumulativeEtaMinutes: number;
  /** The first driving instruction of this leg (e.g. "Turn left onto Main
   * St"), when the routing engine's step data includes a readable street
   * name — omitted rather than shown as a placeholder otherwise. */
  nextManeuver?: string;
}

export interface TripPlan {
  /** The resolved starting point — echoed back so the frontend always has
   * a concrete coordinate to render as the trip's start, whether it came
   * from real GPS or a geocoded ZIP-code fallback. */
  origin: { latitude: number; longitude: number };
  totalDurationMinutes: number;
  totalDistanceMiles: number;
  /** [longitude, latitude] pairs tracing the full driving route, in visit
   * order — GeoJSON LineString coordinate order, straight from the routing
   * engine (never a straight-line approximation between stops). */
  routeGeometry: { type: 'LineString'; coordinates: [number, number][] };
  /** In optimized visit order — never simply cart order. */
  stops: TripStop[];
  /** Stops the caller sent that could NOT be routed to — their store had no
   * usable coordinates and no geocoder result for its address either. Named
   * explicitly rather than silently dropped from `stops`, so the frontend
   * can tell the shopper exactly which store (and therefore which cart
   * items) couldn't be included, instead of the trip just quietly having
   * one fewer stop than the cart implied. */
  unresolvedStops?: StoreLocation[];
}

// ── Smart Shopping Planner — mirrors ShopAI_web/src/types/index.ts ──────

export interface PlannerListItem {
  id: string;
  rawText: string;
  taxonomyEntryId?: string;
  subtypeId?: string | null;
}

export interface AmbiguityOption {
  subtypeId: string;
  label: string;
}

export interface AmbiguityPrompt {
  taxonomyEntryId: string;
  itemLabel: string;
  listItemIds: string[];
  options: AmbiguityOption[];
  rememberedDefault?: string;
}

/** Relative weights the optimizer balances when scoring the "Balanced"
 * candidate — cost/time/distance/fewerStops only. `freshness`/`reliability`
 * are deliberately not modeled: no real per-store data source exists for
 * either anywhere in this app. */
export interface PlanWeights {
  cost: number;
  time: number;
  distance: number;
  fewerStops: number;
}

export interface PlanLineItem {
  listItemId: string;
  rawText: string;
  product: ApiProduct | null;
  notFound: boolean;
  alternativeSuggestion?: ApiProduct;
}

export interface PlanStoreAssignment {
  store: ApiProduct['store'];
  location: StoreLocation;
  items: PlanLineItem[];
  subtotal: number;
}

/** Deterministic, backend-only nutrition scoring for a set of already-
 * selected products (see services/nutritionScoringService.ts) — never an
 * estimate for a product with no data. `score` is omitted entirely when
 * nothing evaluable was found, never defaulted to 0 (0 would read as
 * "worst possible," which is a fabricated signal, not a real one).
 * `confidence` reflects how much of the underlying data was actually
 * present, so a consumer can weight a 'partial' result differently from
 * a 'high' one instead of treating every score as equally trustworthy. */
export interface NutritionScore {
  score?: number;
  confidence: 'high' | 'partial' | 'low';
  /** How many selected products this score considered, whether or not
   * each one actually had usable nutrition data. */
  productsEvaluated: number;
  /** Of `productsEvaluated`, how many had no usable nutrition signal at
   * all (no `nutrition` field, or a `nutrition` object with nothing this
   * scorer can read) — never treated as contributing a score of 0. */
  productsMissingNutrition: number;
}

/** `'healthiest'` is v1 only: it ranks the SAME already-generated,
 * cheapest-per-store subset plans by aggregate nutrition score — it does
 * not change which product is selected per item the way a true
 * nutrition-aware selection strategy eventually would (see
 * shoppingPlanOptimizer.ts's header comment). Older clients that don't
 * recognize this id must not crash — nothing in this app does an
 * exhaustive switch over `PlanCandidateId` today (see
 * PlanResultsView.tsx, which renders whatever candidates it's given by
 * label, not by a hardcoded id list), so this is additive by
 * construction, not just by convention. */
export type PlanCandidateId = 'balanced' | 'cheapest' | 'fastest' | 'fewest-stops' | 'healthiest';

export interface PlanCandidate {
  id: PlanCandidateId;
  label: string;
  storeAssignments: PlanStoreAssignment[];
  totalCost: number;
  estimatedGasCost: number;
  estimatedSavings: number;
  totalDriveMinutes: number;
  totalDriveMiles: number;
  storeCount: number;
  itemsFound: number;
  itemsTotal: number;
  tripPlan: TripPlan;
  /** Only ever populated on the `'healthiest'` candidate — the other
   * modes don't need it, so it's left off them to keep the response
   * lean. Not yet read anywhere on the mobile client; see
   * src/models/types.ts's mirror for the same "type exists, nothing
   * consumes it yet" note `nutrition?`/`canonicalId?` already carry on
   * `ApiProduct`. */
  nutritionScore?: NutritionScore;
  /** Set on every candidate whenever the request carried a usable (positive,
   * finite) `constraints.budgetTarget` — unlike `nutritionScore`, this isn't
   * limited to one candidate, since every candidate already has its own
   * `totalCost` to compare against the same target. Omitted entirely (on
   * every candidate) when no valid target was given — never a fabricated
   * comparison against a missing or nonsensical target. See
   * services/budgetAnalysisService.ts. */
  budgetAnalysis?: BudgetAnalysis;
}

export interface ShoppingPlanRequest {
  items: PlannerListItem[];
  zipcode: string;
  /** Optional shopper-set spending target for this plan (see
   * services/budgetAnalysisService.ts) — omitted entirely means "no
   * target," never a default of 0. Nested under `constraints` rather than
   * a top-level field so future planning constraints (e.g. max stops) have
   * an obvious place to land without another breaking-shaped request. */
  constraints?: {
    budgetTarget?: number;
  };
}

/** How a plan's total cost compares to the shopper's `budgetTarget` (see
 * services/budgetAnalysisService.ts) — a plain arithmetic comparison, never
 * a recommendation or a substitution. `difference = target - actual`:
 * positive means under budget, negative means over, zero means exact.
 * `target` mirrors whatever `constraints.budgetTarget` was, kept here too
 * so a consumer doesn't need to thread the original request alongside the
 * response just to label the comparison. */
export interface BudgetAnalysis {
  target?: number;
  actual: number;
  difference: number;
  status: 'under' | 'at_target' | 'over';
}

export interface ShoppingPlanResponse {
  candidates: PlanCandidate[];
  recommendedId: PlanCandidateId;
  unresolvedItems: PlanLineItem[];
}

// ── Assistant Boundary Foundation (Phase 3.0) ───────────────────────────────
// Mirrors src/models/intent.ts field-for-field — the one shape every future
// voice/text/LLM input must resolve to before this app executes anything.
// See intentRouterService.ts, this sprint's only consumer; nothing else
// imports this yet (contract-first, matching every other mirrored type in
// this file).

/** Closed vocabulary by design — NOT an open string. Whatever eventually
 * classifies free-form input must select from this fixed, enumerated set;
 * it can never invent a new action name, and this app must never execute
 * an intent type it doesn't already have real, hand-written logic for. */
export type IntentType =
  | 'search'
  | 'add_to_cart'
  | 'remove_from_cart'
  | 'compare_options'
  | 'optimize_cart'
  | 'open_planner'
  | 'set_budget_target'
  | 'meal_plan'
  | 'nutrition_question'
  | 'start_shopping_session'
  | 'update_preferences'
  | 'unknown';

/** `confidence` is a plain 0-1 number, not tied to any particular
 * classifier's internals — today's rule-based `resolveIntent` and any
 * future LLM classifier both produce this exact same shape. `parameters`
 * is deliberately a flat, scalar-only bag — no nested objects/arrays —
 * so every future intent handler can trust any value it reads is a plain
 * string/number/boolean or simply absent. */
export interface Intent {
  type: IntentType;
  confidence: number;
  parameters: Record<string, string | number | boolean | undefined>;
}

// ── Assistant Transport (Phase 3.3) ─────────────────────────────────────────
// Mirrors src/services/assistantRepository.ts's request shape field-for-
// field — see routes/assistant.ts, the one consumer. This endpoint ONLY
// classifies (see that route's own header comment) — `context` is
// accepted and validated but not yet read by resolveIntent itself.

export interface AssistantIntentRequest {
  text: string;
  context?: {
    currentScreen?: string;
  };
}

export interface AssistantIntentResponse {
  intent: Intent;
}

// ── Meal Planner v1 (Phase 5.0) ─────────────────────────────────────────────
// Mirrors src/models/types.ts field-for-field. See services/mealPlanService.ts
// — deterministic, curated-template generation only, no AI, no prices.

export type MealType = 'breakfast' | 'dinner';

export interface MealPlanMeal {
  id: string;
  name: string;
  mealType: MealType;
  ingredients: string[];
}

export interface MealPlanGenerationRequest {
  mealCount: number;
  mealType: MealType;
  /** Real, on-device pantry signal (see services/inventoryEstimationService.ts
   * on the mobile client) — advisory only. Items here that aren't already
   * needed by the generated meals get folded into `groceryItems` and named
   * explicitly in `pantryAdditions`, never silently. */
  lowStockItems?: string[];
}

export interface MealPlanGenerationResult {
  meals: MealPlanMeal[];
  groceryItems: string[];
  pantryAdditions: string[];
}

// ── AI Product Quality Scanner (Feature 1) + Optional Expiration Tracking
// (Feature 2) ────────────────────────────────────────────────────────────
// A single vision+LLM call covers both: the shopper never takes a second
// photo to "also check the expiration date" — see
// services/visionQualityService.ts for the safety rules (hedged language
// only, never a "safe/unsafe" claim) and why both features share one
// request.

export type ProductQualityVerdict = 'good' | 'caution' | 'avoid';

export interface VisionQualityRequest {
  /** Base64-encoded JPEG, no data URL prefix — the mobile client strips
   * it before sending (see productQualityService.ts). */
  image: string;
  /** A real, already-known product/item name (e.g. from the Route
   * checklist item this scan was launched from) — never invented if
   * absent. Helps the model focus ("this is supposed to be a tomato")
   * without being trusted as ground truth over what the photo shows. */
  productNameHint?: string;
}

export interface VisionQualityResult {
  verdict: ProductQualityVerdict;
  /** Short, action-oriented, hedged ("appears", "may indicate", "visible
   * signs suggest") — never an unsafe/safe claim. See the system prompt
   * in visionQualityService.ts for the enforced wording rules. */
  explanation: string;
  /** Only set when an expiration date was genuinely visible in the photo
   * — never guessed, never asked for. A free-form short string (e.g.
   * "Aug 5" or "2026-08-05") exactly as the model read it off the
   * packaging; the mobile client stores it verbatim, no date-parsing
   * assumed here. */
  detectedExpirationDate?: string;
}
