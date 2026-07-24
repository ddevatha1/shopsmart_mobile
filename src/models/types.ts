/**
 * Mirrors shopsmart_web/src/types/index.ts field-for-field. All product
 * normalization/business logic (relevance ranking, food filtering, per-store
 * price handling) happens server-side in /api/search — these are pure
 * data-transfer types, same as on the web.
 */

export const STORE_NAMES = ["Trader Joe's", 'Sprouts', 'Kroger', 'Aldi', 'Albertsons'] as const;
export type StoreName = (typeof STORE_NAMES)[number];

/** Stores with no live product data source yet (see backend's
 * albertsonsLiveScraper.ts for why) — mirrors backend/src/services/
 * searchService.ts's own UNAVAILABLE_STORES exactly, so the UI can label
 * these clearly instead of letting a shopper pick one and just see zero
 * results with no explanation. */
export const UNAVAILABLE_STORES: ReadonlySet<StoreName> = new Set(['Albertsons']);

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

// ── Smart Shopping Planner — mirrors shopsmart_web/src/types/index.ts ──────

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

export type PlanCandidateId = 'balanced' | 'cheapest' | 'fastest' | 'fewest-stops';

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
}

export interface ShoppingPlanRequest {
  items: PlannerListItem[];
  zipcode: string;
}

export interface ShoppingPlanResponse {
  candidates: PlanCandidate[];
  recommendedId: PlanCandidateId;
  unresolvedItems: PlanLineItem[];
}
