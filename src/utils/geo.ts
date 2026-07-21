/** Great-circle distance between two coordinates, in miles — mirrors the
 * backend's identical helper (backend/src/utils/geocode.ts) so "distance
 * from you" reads the same way everywhere in the app. */
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

export function formatMiles(miles: number): string {
  if (miles < 0.1) return 'nearby';
  return `${miles.toFixed(miles < 10 ? 1 : 0)} mi`;
}
