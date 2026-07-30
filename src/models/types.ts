/**
 * Mirrors CartIQ_web/src/types/index.ts field-for-field. All product
 * normalization/business logic (relevance ranking, food filtering, per-store
 * price handling) happens server-side in /api/search — these are pure
 * data-transfer types, same as on the web.
 */

export const STORE_NAMES = ["Trader Joe's", 'Sprouts', 'Kroger', 'Aldi', 'Albertsons', 'Harris Teeter'] as const;
export type StoreName = (typeof STORE_NAMES)[number];

/** Stores with no live product data source yet (see backend's
 * albertsonsLiveScraper.ts for why) — mirrors backend/src/services/
 * searchService.ts's own UNAVAILABLE_STORES exactly, so the UI can label
 * these clearly instead of letting a shopper pick one and just see zero
 * results with no explanation. */
export const UNAVAILABLE_STORES: ReadonlySet<StoreName> = new Set(['Albertsons']);

/** One day's open/close time, 24-hour local time as "HH:mm" — mirrors the
 * backend's DayHours field-for-field. `closed: true` means "confirmed
 * closed all day"; its absence (even with `open`/`close` also absent)
 * means "no data," never "closed." */
export interface DayHours {
  open?: string;
  close?: string;
  closed?: boolean;
}

/** Regular weekly hours only, no holiday exceptions — mirrors the
 * backend's WeeklyHours. A day key entirely absent means "no data,"
 * never "closed" — only an explicit `DayHours.closed: true` on a present
 * entry means that. Backend-only consumer for now (see
 * backend/src/services/storeReliabilityService.ts); nothing on this
 * client reads `hours` yet. */
export type WeeklyHours = Partial<Record<
  'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday',
  DayHours
>>;

/** The specific physical store a product listing came from — mirrors the
 * backend's StoreLocation (backend/src/types/index.ts). `latitude`/
 * `longitude` may be absent if a store's own API only provided an address. */
export interface StoreLocation {
  name: string;
  storeId?: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  latitude?: number;
  longitude?: number;
  /** Which real, retailer-native source resolved this location. Optional on
   * the frontend (unlike the backend, which always sets it) so older
   * persisted cart data from before this field existed still type-checks. */
  source?: string;
  metadata?: Record<string, unknown>;
  /** Populated only when the backend's locator has a real hours source
   * (currently just Kroger — see backend's krogerLocator.ts). Nothing on
   * this client reads it yet; the filtering it enables (never recommend a
   * known-closed store) happens entirely server-side, before a plan is
   * ever returned (see backend's storeReliabilityService.ts). */
  hours?: WeeklyHours;
}

/** Mirrors the backend's NutritionAttributes (backend/src/types/index.ts)
 * field-for-field — a minimal, extracted subset of a real Open Food
 * Facts product's `nutriments`, per-100g basis. All numeric fields are
 * optional: a real product frequently has partial data — absence must
 * never be read as zero, and never used as a ranking signal on its own.
 * `source`/`completeness` are the one required part of this shape
 * whenever it exists at all (`ApiProduct.nutrition` itself stays
 * optional for "no data found"). First real consumer on this client:
 * assistantDispatcher.ts's nutrition_question handling (see
 * models/intent.ts's `NutritionResult`) — surfaced verbatim, never
 * renamed/flattened/estimated. */
export interface NutritionAttributes {
  caloriesPer100g?: number;
  proteinGPer100g?: number;
  carbsGPer100g?: number;
  fatGPer100g?: number;
  fiberGPer100g?: number;
  sugarGPer100g?: number;
  sodiumMgPer100g?: number;
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
  isLiveData?: boolean;
  size: string;
  upc?: string;
  certifications?: string[];
  pricePerUnit?: string;
  store: StoreName;
  storeProductUrl?: string;
  location?: StoreLocation;
  inStock?: boolean;
  pickupAvailable?: boolean;
  deliveryAvailable?: boolean;
  inStoreAvailable?: boolean;
  category?: string;
  aisle?: string;
  /** Set by the backend's relevance classifier: 'direct' when the query
   * names the product itself, 'related' when the query only appears as an
   * ingredient/flavor/component. Missing on old cached data — treat as
   * 'direct' rather than hiding it. */
  matchType?: 'direct' | 'related';
  /** Mirrors the backend's ApiProduct.canonicalId (see
   * backend/src/services/canonicalProductService.ts). `undefined` means
   * canonical matching didn't have enough signal for this product's
   * name/size — not an error. First real consumer on this client:
   * purchaseHistoryService.ts persists it per purchase, and
   * inventoryEstimationService.ts uses it to group repeat purchases of
   * the same underlying product across brand/variant differences. */
  canonicalId?: string;
  /** Mirrors the backend's ApiProduct.nutrition — set by /api/search's
   * enrichment step (see backend/src/services/searchService.ts's
   * enrichDirectMatchesWithNutrition) for a capped, budgeted subset of
   * direct-match products. `undefined` means no Open Food Facts match
   * was found, never "zero nutrition." */
  nutrition?: NutritionAttributes;
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
  /** Optional, shopper-set weekly grocery budget — entirely optional, used
   * only to subtly surface budget standing in the Cart's Advisor card
   * (see budgetService/advisorService). Absent for most accounts. */
  weeklyBudget?: number;
}

/** Account record as persisted by AuthRepository — mirrors AuthModal.tsx's
 * saveAccount(), which strips `id` before persisting (a fresh id is minted
 * on every sign-in, matching `u_${Date.now()}` on the web). */
export type AccountRecord = Omit<User, 'id'>;

export type StoreSearchStatus = 'pending' | 'loading' | 'success' | 'error';

export interface StoreStatus {
  store: StoreName;
  status: StoreSearchStatus;
  count?: number;
  error?: string;
}

/** Set on the response only when the query pipeline (see
 * backend/src/services/queryCorrection.ts) found a typo/spelling correction
 * worth surfacing — omitted entirely for an already-correct or unrecognized
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
}

// ── Route planning — mirrors backend/src/types/index.ts field-for-field ────

export interface TripOrigin {
  latitude?: number;
  longitude?: number;
  zipcode?: string;
}

export interface TripStop {
  location: StoreLocation;
  legDurationMinutes: number;
  legDistanceMiles: number;
  cumulativeEtaMinutes: number;
  nextManeuver?: string;
}

export interface TripPlan {
  origin: { latitude: number; longitude: number };
  totalDurationMinutes: number;
  totalDistanceMiles: number;
  routeGeometry: { type: 'LineString'; coordinates: [number, number][] };
  stops: TripStop[];
  /** Stops the backend received but could not resolve coordinates for (no
   * lat/lng from the store, and its address didn't geocode either) — named
   * explicitly rather than silently missing from `stops`. */
  unresolvedStops?: StoreLocation[];
}

/** One physical store's worth of a shopper's cart — the frontend-only
 * grouping step (see utils/groupCartByStore.ts) between "cart" and "trip
 * request." Not sent to the backend as-is; `items` stays on-device for
 * rendering the pick-up checklist, only `location` is sent as a stop. */
export interface StoreGroup {
  location: StoreLocation;
  items: CartItem[];
}

// ── Smart Shopping Planner — mirrors CartIQ_web/src/types/index.ts ──────

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

/** Mirrors the backend's NutritionScore (backend/src/types/index.ts) —
 * deliberately backend-computed only; nothing on this client derives or
 * recomputes it. `score` omitted (never 0) when nothing was evaluable. */
export interface NutritionScore {
  score?: number;
  confidence: 'high' | 'partial' | 'low';
  productsEvaluated: number;
  productsMissingNutrition: number;
}

/** `'healthiest'` (Phase 2.2) is v1 only — see the backend's own
 * PlanCandidateId comment. Existing UI (PlanResultsView.tsx) already
 * renders whichever candidates it's given by `label`, with no hardcoded
 * switch over specific ids, so this addition needed no UI changes. */
export type PlanCandidateId = 'balanced' | 'cheapest' | 'fastest' | 'fewest-stops' | 'healthiest';

/** Mirrors the backend's BudgetAnalysis (backend/src/types/index.ts) — a
 * plain arithmetic comparison of a candidate's `totalCost` against the
 * shopper's `budgetTarget`, never a recommendation. `difference = target -
 * actual`: positive means under budget, negative means over, zero exact. */
export interface BudgetAnalysis {
  target?: number;
  actual: number;
  difference: number;
  status: 'under' | 'at_target' | 'over';
}

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
  /** Only ever populated on the `'healthiest'` candidate. Not read
   * anywhere on this client yet — same "type exists, nothing consumes it
   * yet" status as `ApiProduct.nutrition`/`canonicalId`. */
  nutritionScore?: NutritionScore;
  /** Set on every candidate when the request carried a usable
   * `constraints.budgetTarget` — see PlanResultsView.tsx for the one
   * place this is rendered (a single line, no dashboard). */
  budgetAnalysis?: BudgetAnalysis;
  itemsTotal: number;
  tripPlan: TripPlan;
}

export interface ShoppingPlanRequest {
  items: PlannerListItem[];
  zipcode: string;
  /** Optional shopper-set spending target — mirrors the backend's
   * ShoppingPlanRequest.constraints exactly (see
   * backend/src/types/index.ts). Omitted entirely means "no target." */
  constraints?: {
    budgetTarget?: number;
  };
}

export interface ShoppingPlanResponse {
  candidates: PlanCandidate[];
  recommendedId: PlanCandidateId;
  unresolvedItems: PlanLineItem[];
}

// ── Meal Planner v1 (Phase 5.0) ─────────────────────────────────────────────
// Mirrors backend/src/types/index.ts field-for-field. See
// backend/src/services/mealPlanService.ts — deterministic, curated-template
// generation only, no AI, no prices, no cart mutation.

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
  /** Real, on-device pantry signal (see services/inventoryEstimationService.ts)
   * — advisory only. Items here not already needed by the generated meals
   * get folded into `groceryItems` and named explicitly in
   * `pantryAdditions`, never silently. */
  lowStockItems?: string[];
}

export interface MealPlanGenerationResult {
  meals: MealPlanMeal[];
  groceryItems: string[];
  pantryAdditions: string[];
}

// ── Shopper Preference Memory (Phase 5.2) ───────────────────────────────────
// Local, on-device only (see repositories/shopperPreferenceRepository.ts) —
// no backend mirror exists for this shape, unlike every other type in this
// file: the backend has no knowledge of, or need for, this memory at all.

export type OptimizationPreference = 'cheapest' | 'healthiest' | 'fastest' | 'balanced';

/** Every field here is set ONLY from an explicit, real statement (see
 * services/shopperPreferenceService.ts's own rule) — never inferred from
 * purchase history, cart contents, or anything else. `dietaryPreferences`/
 * `householdSize` exist in the shape now (per this phase's own spec) but
 * have no natural-language path that sets them yet — see this phase's
 * report for why that's a deliberate limit, matching this codebase's own
 * "type exists, nothing consumes it yet" convention. */
export interface ShopperPreferences {
  preferredStores?: string[];
  avoidedStores?: string[];
  dietaryPreferences?: string[];
  householdSize?: number;
  defaultBudgetTarget?: number;
  optimizationPreference?: OptimizationPreference;
}

// ── Purchase-intelligence-derived suggestions (Phase 5.2) ───────────────────

/** How urgently a real suggestion is worth a shopper's attention (Phase
 * 5.3 Part 3) — a fixed mapping from `type`, never a computed/guessed
 * score: `restock` (something is genuinely running out) is `'urgent'`,
 * `frequent_purchase` (a real habit, not time-sensitive) is `'helpful'`,
 * `budget_tip` (a nice-to-know) is `'optional'`. See
 * assistantSuggestionService.ts's `PRIORITY_BY_TYPE`. */
export type SuggestionPriority = 'urgent' | 'helpful' | 'optional';

/** A real, data-backed suggestion — never a fabricated one. `reason` is
 * always built from real fields already computed by
 * inventoryEstimationService.ts / purchaseHistoryService.ts / a real
 * stored preference — see services/assistantSuggestionService.ts, this
 * type's only producer. */
export interface AssistantSuggestion {
  type: 'restock' | 'frequent_purchase' | 'budget_tip';
  itemName: string;
  reason: string;
  priority: SuggestionPriority;
}

// ── AI Product Quality Scanner (Feature 1) + Optional Expiration Tracking
// (Feature 2) ────────────────────────────────────────────────────────────
// Mirrors backend/src/types/index.ts field-for-field. See
// services/productQualityService.ts / backend's visionQualityService.ts.

export type ProductQualityVerdict = 'good' | 'caution' | 'avoid';

export interface VisionQualityResult {
  verdict: ProductQualityVerdict;
  explanation: string;
  detectedExpirationDate?: string;
}
