import type { SearchResponse, StoreLocation, TripOrigin, TripPlan } from '../models/types';

/**
 * Talks to this app's own `backend/` (an Express server, independent of
 * shopsmart_web) rather than a same-origin relative path — mobile has no
 * "same origin" to be relative to. Defaults match the standard per-platform
 * loopback addresses for that server running on the host machine:
 *   - Android emulator: 10.0.2.2 (the emulator's alias for host loopback)
 *   - iOS Simulator / web: localhost works directly
 *   - Physical device on the same network: use your machine's LAN IP
 * Override via app.json's `expo.extra.apiBaseUrl`, or the
 * EXPO_PUBLIC_API_BASE_URL env var (Expo inlines EXPO_PUBLIC_* at build time):
 *   EXPO_PUBLIC_API_BASE_URL=http://192.168.1.23:3001 npx expo start
 */
export class ApiError extends Error {}

const DEFAULT_BASE_URL = 'http://localhost:3001';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStoreLocation(value: unknown): value is StoreLocation {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === 'string' &&
    typeof v.address === 'string' &&
    typeof v.city === 'string' &&
    typeof v.state === 'string' &&
    typeof v.zip === 'string'
  );
}

function isResolvedStoreLocation(value: unknown): value is StoreLocation & { latitude: number; longitude: number } {
  return isStoreLocation(value) && isFiniteNumber((value as StoreLocation).latitude) && isFiniteNumber((value as StoreLocation).longitude);
}

/**
 * TypeScript's `TripPlan` type is a compile-time-only promise — it gives
 * zero protection against a malformed/incomplete network response (a stale
 * server process, a proxy error page, a backend bug). Every field the map
 * and route UI trust without a null check (`trip.origin.latitude`,
 * `stop.location.latitude`, ...) is verified for real here, at the one
 * place a bad response can still be told apart from a good one. A response
 * that fails this check is treated as a genuine error — surfaced to the
 * shopper via ApiError — never silently patched with `?.` or a fabricated
 * default coordinate.
 */
function isValidTripPlan(value: unknown): value is TripPlan {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!v.origin || typeof v.origin !== 'object') return false;
  const origin = v.origin as Record<string, unknown>;
  if (!isFiniteNumber(origin.latitude) || !isFiniteNumber(origin.longitude)) return false;
  if (!isFiniteNumber(v.totalDurationMinutes) || !isFiniteNumber(v.totalDistanceMiles)) return false;
  if (!v.routeGeometry || typeof v.routeGeometry !== 'object') return false;
  if (!Array.isArray((v.routeGeometry as Record<string, unknown>).coordinates)) return false;
  if (!Array.isArray(v.stops)) return false;
  if (
    !v.stops.every((stop: unknown) => {
      if (!stop || typeof stop !== 'object') return false;
      const s = stop as Record<string, unknown>;
      return (
        isResolvedStoreLocation(s.location) &&
        isFiniteNumber(s.legDurationMinutes) &&
        isFiniteNumber(s.legDistanceMiles) &&
        isFiniteNumber(s.cumulativeEtaMinutes)
      );
    })
  ) {
    return false;
  }
  if (v.unresolvedStops !== undefined && !(Array.isArray(v.unresolvedStops) && v.unresolvedStops.every(isStoreLocation))) {
    return false;
  }
  return true;
}

export class ApiClient {
  readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? process.env.EXPO_PUBLIC_API_BASE_URL ?? DEFAULT_BASE_URL;
  }

  async search(query: string, zipcode: string): Promise<SearchResponse> {
    const res = await fetch(`${this.baseUrl}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, zipcode }),
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new ApiError(body?.error ?? `Server returned ${res.status}`);
    }

    return body as SearchResponse;
  }

  /** Fallback product photo lookup — see backend/src/routes/productImage.ts
   * for how the match is found and verified. `store`/`storeProductUrl`, when
   * known, let the backend try an exact same-site product-page scrape
   * before falling back to a fuzzy Open Food Facts search. Returns null
   * (not a throw) on any failure; the caller falls back to the category
   * placeholder icon. */
  async resolveProductImage(
    productName: string,
    store?: string,
    storeProductUrl?: string,
    // A store-page scrape launches a real browser server-side, so it needs
    // more headroom than the plain Open Food Facts fuzzy search does.
    timeoutMs = storeProductUrl ? 10000 : 5000,
  ): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const params = new URLSearchParams({ name: productName });
      if (store) params.set('store', store);
      if (storeProductUrl) params.set('storeProductUrl', storeProductUrl);
      const res = await fetch(`${this.baseUrl}/api/product-image?${params.toString()}`, {
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { imageUrl: string | null };
      return body.imageUrl;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Real, engine-computed multi-stop route — see
   * backend/src/services/tripPlanner.ts. Throws ApiError on failure (e.g.
   * no coordinates could be resolved for any stop); the Route screen shows
   * that message rather than falling back to an estimate. */
  async planTrip(origin: TripOrigin, stops: StoreLocation[]): Promise<TripPlan> {
    const res = await fetch(`${this.baseUrl}/api/trip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin, stops }),
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new ApiError(body?.error ?? `Server returned ${res.status}`);
    }

    if (!isValidTripPlan(body)) {
      console.error('[apiClient] /api/trip returned a malformed TripPlan:', JSON.stringify(body));
      throw new ApiError('The route service returned an incomplete trip plan. Please try again.');
    }

    return body;
  }
}

export const apiClient = new ApiClient();
