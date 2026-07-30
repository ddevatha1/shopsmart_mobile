import type { SearchResponse, StoreLocation, TripOrigin, TripPlan, VisionQualityResult } from '../models/types';

/**
 * Talks to this app's own `backend/` (an Express server, independent of
 * CartIQ_web) rather than a same-origin relative path — mobile has no
 * "same origin" to be relative to. Override via the `EXPO_PUBLIC_API_BASE_URL`
 * env var (Expo inlines `EXPO_PUBLIC_*` vars at BUNDLE time, not runtime —
 * it must be set in the shell/`.env` *before* `expo start`/a production
 * build, not after):
 *   EXPO_PUBLIC_API_BASE_URL=http://192.168.68.65:3001 npx expo start
 *
 * iOS Build / App Store Readiness — the fallback below is intentionally
 * `__DEV__`-only. It used to be an unconditional default, which meant an
 * Xcode Archive/Release build with `EXPO_PUBLIC_API_BASE_URL` unset would
 * silently ship pointed at one developer's personal home-network IP over
 * plain HTTP — meaningless (and unreachable) for every real installed
 * copy of the app, and only reachable at all today because of this app's
 * `NSAllowsLocalNetworking` ATS exception (see the generated Info.plist),
 * which itself only exists to support this dev-time LAN workflow. A real
 * release build now fails loudly (see `resolveBaseUrl`) instead of
 * silently pointing nowhere real — but this app has no deployed
 * production backend yet at all; that's a real infrastructure gap this
 * file cannot fix on its own (see the iOS build report's own "blockers"
 * section).
 */
export class ApiError extends Error {}

const DEV_ONLY_DEFAULT_BASE_URL = 'http://192.168.68.65:3001';

// RFC 2606 reserved TLD — guaranteed to never resolve. Used only as an
// unmistakable "this was never configured" sentinel for a misconfigured
// release build; every existing call site already handles a failed
// `fetch()` (network error / non-2xx) as a real, user-facing error state
// (ApiError, or a caught-and-degraded null for the best-effort warm-up
// call) — this deliberately does NOT throw at construction time, which
// would crash the whole app at launch instead of failing gracefully the
// first time a real request is attempted, exactly like any other
// "backend unreachable" case this app already handles.
const UNCONFIGURED_BASE_URL = 'https://backend-not-configured.invalid';

function resolveBaseUrl(explicit?: string): string {
  if (explicit) return explicit;
  const fromEnv = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (fromEnv) return fromEnv;
  // `typeof` (never a bare reference) — `__DEV__` is a React Native/Metro
  // global that plain `ts-jest` (this project's test runner; no Metro/
  // Babel transform involved) never defines at all, so a bare reference
  // would throw a ReferenceError and break every test that transitively
  // imports this module, rather than just falling through correctly.
  if (typeof __DEV__ !== 'undefined' && __DEV__) return DEV_ONLY_DEFAULT_BASE_URL;
  console.error(
    '[apiClient] EXPO_PUBLIC_API_BASE_URL is not set in this release build. ' +
    'Every network call will fail until this is set to your deployed backend\'s ' +
    'real HTTPS URL before bundling/archiving.',
  );
  return UNCONFIGURED_BASE_URL;
}

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

/** Guards against the same class of problem `isValidTripPlan` guards
 * against below — a malformed/partial `/api/search` response (stale
 * process, proxy error page, backend bug) trusted blindly via a cast would
 * let `undefined` prices/names/stores flow straight into product cards.
 * Only checks the required fields on `ApiProduct`/`StoreStatus` (per
 * models/types.ts) — optional fields are intentionally left unchecked. */
function isValidApiProduct(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.brand === 'string' &&
    isFiniteNumber(v.price) &&
    isFiniteNumber(v.rating) &&
    typeof v.size === 'string' &&
    typeof v.store === 'string'
  );
}

function isValidStoreStatus(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.store === 'string' && typeof v.status === 'string';
}

function isValidVisionQualityResult(value: unknown): value is VisionQualityResult {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    (v.verdict === 'good' || v.verdict === 'caution' || v.verdict === 'avoid') &&
    typeof v.explanation === 'string'
  );
}

function isValidSearchResponse(value: unknown): value is SearchResponse {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.products) || !v.products.every(isValidApiProduct)) return false;
  if (!Array.isArray(v.storeStatuses) || !v.storeStatuses.every(isValidStoreStatus)) return false;
  return true;
}

export interface WarmupStoreResult {
  store: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface WarmupResult {
  startedAt: number;
  completedAt: number;
  totalMs: number;
  zipcode?: string;
  stores: WarmupStoreResult[];
}

export class ApiClient {
  readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = resolveBaseUrl(baseUrl);
  }

  /** Triggers the backend's app-startup warm-up (see backend/src/services/
   * warmupService.ts) — moves Kroger/Aldi/Sprouts/Trader Joe's session and
   * store-location initialization out of the first real search. Never
   * throws: a failed or unreachable warm-up just means the backend falls
   * back to its normal lazy first-search initialization, so callers treat
   * this as best-effort and never gate search on it. */
  async warmup(zipcode?: string): Promise<WarmupResult | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/warmup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zipcode }),
      });
      if (!res.ok) return null;
      return (await res.json()) as WarmupResult;
    } catch {
      return null;
    }
  }

  async search(
    query: string,
    zipcode: string,
    options?: { noCorrect?: boolean; latitude?: number; longitude?: number },
  ): Promise<SearchResponse> {
    const url = `${this.baseUrl}/api/search`;
    const requestBody = {
      query,
      zipcode,
      noCorrect: options?.noCorrect,
      latitude: options?.latitude,
      longitude: options?.longitude,
    };

    // Production debugging (TestFlight/release — see this file's header
    // comment on the `__DEV__`-gated base URL) — deliberately console-only,
    // never rendered in the UI: nothing here is sensitive (no API keys
    // ever reach the mobile app; those live server-side only), and this
    // is the one thing a tester can actually retrieve without a debugger
    // attached — plug the device into a Mac and open Xcode's
    // Window ▸ Devices and Simulators ▸ (device) ▸ Open Console, or
    // Console.app directly, filtered to the app's process name, and every
    // line below shows up exactly as logged here.
    console.log(`[apiClient] → POST ${url}`, JSON.stringify(requestBody));

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
    } catch (err) {
      // The request never reached (or never got a response from) the
      // backend at all — DNS failure, no route to host, ATS block, no
      // internet, timeout, etc. This is the exact failure mode of a
      // TestFlight build with no real backend URL configured: `fetch`
      // throws here, before any status code or response body exists.
      // Distinguishing this from a real backend error (below) is the
      // whole point of this try/catch — the previous code let this
      // exception propagate as a bare, undiagnosable "Network request
      // failed" with no indication of which URL was even being tried.
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[apiClient] ✗ POST ${url} — request failed before reaching the backend:`, detail);
      throw new ApiError(`Could not reach ${url}. Check your network connection and the app's backend configuration. (${detail})`);
    }

    const body = await res.json().catch(() => ({}));
    console.log(`[apiClient] ← POST ${url} — HTTP ${res.status}`, JSON.stringify(body).slice(0, 500));

    if (!res.ok) {
      console.error(`[apiClient] ✗ POST ${url} — backend responded with an error:`, res.status, JSON.stringify(body));
      throw new ApiError(body?.error ?? `Server returned ${res.status}`);
    }

    if (!isValidSearchResponse(body)) {
      console.error('[apiClient] /api/search returned a malformed SearchResponse:', JSON.stringify(body));
      throw new ApiError('The search service returned an unexpected response. Please try again.');
    }

    return body;
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

  /** AI Product Quality Scanner (Feature 1) + optional expiration-date
   * detection (Feature 2) — see backend/src/routes/visionQuality.ts.
   * `imageBase64` has no data-URL prefix (the caller — see
   * productQualityService.ts — already captures a compressed JPEG via
   * expo-camera). Throws ApiError when the feature is unconfigured, the
   * call fails, or the model's response couldn't be trusted — never a
   * fabricated verdict returned to the caller. */
  async assessProductQuality(imageBase64: string, productNameHint?: string): Promise<VisionQualityResult> {
    const res = await fetch(`${this.baseUrl}/api/vision/quality-assess`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageBase64, productNameHint }),
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new ApiError(body?.error ?? `Server returned ${res.status}`);
    }

    if (!isValidVisionQualityResult(body)) {
      console.error('[apiClient] /api/vision/quality-assess returned a malformed VisionQualityResult:', JSON.stringify(body));
      throw new ApiError('Could not get a reliable quality check for this photo. Please try again.');
    }

    return body;
  }
}

export const apiClient = new ApiClient();
