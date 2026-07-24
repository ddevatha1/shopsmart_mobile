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
  store: "Trader Joe's" | 'Sprouts' | 'Kroger' | 'Aldi' | 'Albertsons';
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
