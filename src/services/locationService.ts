import * as Location from 'expo-location';

/**
 * The single place this app asks for the device's real GPS position —
 * used both for a "how far is this store" hint on the product detail
 * screen and as the starting point for route planning. Never blocks the
 * UI waiting on a permission prompt the user might dismiss: every caller
 * treats `null` (permission denied, GPS unavailable, or a genuine error)
 * as "no coordinates available" and falls back to the shopper's saved ZIP
 * instead, exactly the way the rest of the app already treats optional
 * location data.
 *
 * Cached in memory for a few minutes so navigating between screens (e.g.
 * a product detail screen, then Cart, then the Route screen moments
 * later) doesn't re-prompt or re-fetch GPS repeatedly.
 */
export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface PreciseLocationResult {
  coords: Coordinates;
  /** The device's own radius-of-confidence for this fix, in meters —
   * surfaced so the caller (the route-planning "share your exact location"
   * prompt) can show the shopper how precise the fix it just got actually
   * was, rather than a bare "done." */
  accuracyMeters: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cached: { coords: Coordinates | null; expiresAt: number } | null = null;

// Caps how long any caller of getCurrentCoordinates() will actually wait —
// a shopper who leaves the browser's/OS's permission prompt unanswered
// (neither Allow nor Block) can otherwise leave requestForegroundPermissionsAsync
// pending indefinitely, which would silently hang whatever awaited this
// (found live: it blocked Search from ever firing its request). Racing it
// against this timeout is what actually makes the "never blocks the UI"
// contract in this file's own header comment true, rather than just
// documented intent.
const PERMISSION_TIMEOUT_MS = 4000;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

async function resolveCoordinates(): Promise<Coordinates | null> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== 'granted') return null;
  const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  return { latitude: position.coords.latitude, longitude: position.coords.longitude };
}

export async function getCurrentCoordinates(): Promise<Coordinates | null> {
  if (cached && Date.now() < cached.expiresAt) return cached.coords;

  // `undefined` (distinct from a settled `null`) means the permission
  // prompt never resolved within the timeout — treated as "check again
  // next time" rather than cached as a 5-minute "no location," since it
  // was never actually answered.
  const result = await withTimeout<Coordinates | null | undefined>(
    resolveCoordinates().catch(() => null),
    PERMISSION_TIMEOUT_MS,
    undefined,
  );

  if (result !== undefined) {
    cached = { coords: result, expiresAt: Date.now() + CACHE_TTL_MS };
  }
  return result ?? null;
}

/** A shopper-initiated, high-accuracy GPS fix — used only by the pre-route
 * "share your exact location" prompt, where a shopper has explicitly asked
 * for the most accurate starting point available for driving directions,
 * rather than the quick/battery-friendly fix `getCurrentCoordinates`
 * normally settles for. Always requests a fresh permission check and fix
 * rather than trusting the cache, unlike `getCurrentCoordinates`. A
 * successful result also refreshes the shared cache, so every other caller
 * (product-detail distance, closest-store sorting) benefits from the more
 * precise fix for the rest of its TTL too. */
export async function requestPreciseLocation(): Promise<PreciseLocationResult | null> {
  let result: PreciseLocationResult | null = null;
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status === 'granted') {
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Highest,
      });
      result = {
        coords: { latitude: position.coords.latitude, longitude: position.coords.longitude },
        accuracyMeters: position.coords.accuracy ?? Number.POSITIVE_INFINITY,
      };
    }
  } catch {
    result = null;
  }

  cached = { coords: result?.coords ?? null, expiresAt: Date.now() + CACHE_TTL_MS };
  return result;
}
