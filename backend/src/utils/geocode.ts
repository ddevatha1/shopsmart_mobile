import { TtlCache } from './ttlCache.ts';
import { withTimeout } from './withTimeout.ts';

/**
 * Address → coordinates. Used two ways:
 *   - Aldi (aldiLiveScraper.ts) geocodes its resolved store address, since
 *     Aldi's own store-locator API returns an address but no lat/lng.
 *   - Kroger (krogerLiveScraper.ts) geocodes the shopper's ZIP code itself,
 *     as a reference point for ranking Kroger's returned candidate
 *     locations by actual distance rather than trusting API result order.
 *
 * Uses OpenStreetMap's Nominatim (nominatim.openstreetmap.org) — free, no
 * API key, same "free/open API + descriptive User-Agent" pattern already
 * used for product-image lookups (see routes/productImage.ts). Results are
 * cached indefinitely (well, 30 days, matching that same cache's TTL) since
 * neither a store's address nor a ZIP code's coordinates ever move.
 */

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const geocodeCache = new TtlCache<{ latitude: number; longitude: number } | null>(CACHE_TTL_MS);

const USER_AGENT = 'ShopSmartMobile/1.0 (grocery price comparison app)';
const FETCH_TIMEOUT_MS = 5000;

// ── Request queue ────────────────────────────────────────────────────────────
// Nominatim's usage policy caps public-instance traffic at ~1 request/sec —
// and with four store locators (Kroger, Aldi, Trader Joe's, and Trader
// Joe's own candidate-city fallback) all potentially geocoding during the
// same search, calling it directly and concurrently gets rate-limited
// (verified live: rapid concurrent calls started returning HTTP 429). Every
// geocode call in this app funnels through this single queue so, app-wide,
// only one request is in flight at a time with a minimum gap between them —
// not per-caller, since the callers don't know about each other.
const MIN_INTERVAL_MS = 1100;
let queueTail: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(async () => {
    const result = await task();
    await new Promise(r => setTimeout(r, MIN_INTERVAL_MS));
    return result;
  });
  // Swallow rejections in the chain itself (each caller still gets its own
  // rejection via `run`) so one failed lookup doesn't wedge the queue.
  queueTail = run.catch(() => undefined);
  return run;
}

interface NominatimResult {
  lat: string;
  lon: string;
  address?: { state?: string; city?: string; town?: string; village?: string };
}

export interface ZipGeocodeResult {
  latitude: number;
  longitude: number;
  /** Full US state name (e.g. "Texas"), as reported by Nominatim. */
  state?: string;
  city?: string;
}

const zipGeocodeCache = new TtlCache<ZipGeocodeResult | null>(CACHE_TTL_MS);

/** Like geocodeAddress, but also returns the state/city Nominatim resolved
 * the ZIP to — used by locators (e.g. Trader Joe's) that need to know which
 * state a shopper's ZIP falls in before narrowing candidate stores. */
export async function geocodeZip(zip: string): Promise<ZipGeocodeResult | null> {
  const cacheKey = zip.trim();
  const cached = zipGeocodeCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(`${zip}, USA`)}&format=json&addressdetails=1&limit=1`;

  try {
    const res = await enqueue(() =>
      withTimeout(fetch(url, { headers: { 'User-Agent': USER_AGENT } }), FETCH_TIMEOUT_MS, 'Nominatim ZIP geocoding'),
    );
    if (!res.ok) {
      // A transient failure (rate limit, server error) isn't cached as a
      // permanent "no result" — only a completed lookup is. Caching this
      // would otherwise poison the 30-day cache with a temporary outage.
      console.warn(`[Geocode] ZIP lookup for ${zip} got HTTP ${res.status} — not caching.`);
      return null;
    }
    const data = (await res.json()) as NominatimResult[];
    const first = data[0];
    const latitude = first ? parseFloat(first.lat) : NaN;
    const longitude = first ? parseFloat(first.lon) : NaN;
    const result: ZipGeocodeResult | null =
      first && Number.isFinite(latitude) && Number.isFinite(longitude)
        ? {
            latitude,
            longitude,
            state: first.address?.state,
            city: first.address?.city ?? first.address?.town ?? first.address?.village,
          }
        : null;
    zipGeocodeCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.warn(`[Geocode] ZIP lookup for ${zip} failed — not caching:`, err);
    return null;
  }
}

export async function geocodeAddress(
  fullAddress: string,
): Promise<{ latitude: number; longitude: number } | null> {
  const cacheKey = fullAddress.trim().toLowerCase();
  const cached = geocodeCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(fullAddress)}&format=json&limit=1`;

  try {
    const res = await enqueue(() =>
      withTimeout(fetch(url, { headers: { 'User-Agent': USER_AGENT } }), FETCH_TIMEOUT_MS, 'Nominatim geocoding'),
    );
    if (!res.ok) {
      // Transient failure — see the matching comment in geocodeZip above.
      console.warn(`[Geocode] Address lookup got HTTP ${res.status} — not caching.`);
      return null;
    }
    const data = (await res.json()) as NominatimResult[];
    const first = data[0];
    const latitude = first ? parseFloat(first.lat) : NaN;
    const longitude = first ? parseFloat(first.lon) : NaN;
    const result =
      first && Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
    geocodeCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.warn('[Geocode] Address lookup failed — not caching:', err);
    return null;
  }
}

/** Great-circle distance between two coordinates, in miles — used to rank
 * candidate store locations by actual proximity instead of trusting an
 * API's result order. */
export function haversineDistanceMiles(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const EARTH_RADIUS_MILES = 3958.8;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}
