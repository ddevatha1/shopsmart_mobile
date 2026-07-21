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

const CACHE_TTL_MS = 5 * 60 * 1000;
let cached: { coords: Coordinates | null; expiresAt: number } | null = null;

export async function getCurrentCoordinates(): Promise<Coordinates | null> {
  if (cached && Date.now() < cached.expiresAt) return cached.coords;

  let coords: Coordinates | null = null;
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status === 'granted') {
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      coords = { latitude: position.coords.latitude, longitude: position.coords.longitude };
    }
  } catch {
    coords = null;
  }

  cached = { coords, expiresAt: Date.now() + CACHE_TTL_MS };
  return coords;
}
