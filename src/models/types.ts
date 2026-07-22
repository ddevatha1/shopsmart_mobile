/**
 * Mirrors shopsmart_web/src/types/index.ts field-for-field. All product
 * normalization/business logic (relevance ranking, food filtering, per-store
 * price handling) happens server-side in /api/search — these are pure
 * data-transfer types, same as on the web.
 */

export const STORE_NAMES = ["Trader Joe's", 'Sprouts', 'Kroger', 'Aldi'] as const;
export type StoreName = (typeof STORE_NAMES)[number];

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
