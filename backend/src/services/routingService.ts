import { withTimeout } from '../utils/withTimeout.ts';

/**
 * Thin client for OSRM (Open Source Routing Machine) — the routing engine
 * chosen for real multi-stop trip planning. OSRM was picked over
 * GraphHopper/Valhalla because it's the only one of the three with a free,
 * no-API-key public demo server (router.project-osrm.org, OpenStreetMap
 * Foundation-adjacent infrastructure) suitable for this app's existing
 * "free public API, no key" pattern (matches Nominatim, already used for
 * geocoding) — GraphHopper's and Valhalla's public offerings require an
 * account/API key or self-hosting. OSRM's `/trip` endpoint is a genuine
 * routing-engine-side solver for "visit these points in the best order,
 * starting here" (the Traveling Salesman-style optimization this feature
 * needs) — not something this app computes by hand.
 */
const OSRM_BASE_URL = 'https://router.project-osrm.org';
const FETCH_TIMEOUT_MS = 15000;

export interface OsrmManeuver {
  type: string;
  modifier?: string;
}
export interface OsrmStep {
  maneuver: OsrmManeuver;
  name: string;
}
export interface OsrmLeg {
  duration: number; // seconds
  distance: number; // meters
  steps: OsrmStep[];
}
export interface OsrmTrip {
  duration: number;
  distance: number;
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  legs: OsrmLeg[];
}
export interface OsrmWaypoint {
  waypoint_index: number;
  trips_index: number;
}
interface OsrmTripResponse {
  code: string;
  message?: string;
  trips?: OsrmTrip[];
  waypoints?: OsrmWaypoint[];
}

/**
 * Solves the optimal visit order for `coordinates` (each `[longitude,
 * latitude]`), starting at `coordinates[0]`, and returns the real driving
 * route for that order. `source=first` pins the trip's start to the
 * shopper's actual location — everything after that is the engine's own
 * optimization, not this app's guess.
 */
export async function planOptimizedTrip(coordinates: [number, number][]): Promise<{
  trip: OsrmTrip;
  /** For each input coordinate (including the origin at index 0), its
   * position in the optimized visit order. */
  visitOrderByInputIndex: number[];
}> {
  const coordsPath = coordinates.map(([lng, lat]) => `${lng},${lat}`).join(';');
  const url =
    `${OSRM_BASE_URL}/trip/v1/driving/${coordsPath}` +
    '?source=first&roundtrip=false&overview=full&geometries=geojson&steps=true';

  const res = await withTimeout(fetch(url), FETCH_TIMEOUT_MS, 'OSRM trip request');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OSRM trip request failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as OsrmTripResponse;
  if (json.code !== 'Ok' || !json.trips?.length || !json.waypoints) {
    throw new Error(`OSRM could not compute a route: ${json.code}${json.message ? ` — ${json.message}` : ''}`);
  }

  // `json.waypoints` is already in INPUT order (waypoints[i] corresponds to
  // coordinates[i]); each entry's own `waypoint_index` is its position in
  // the optimized VISIT order. Sorting by waypoint_index before mapping to
  // waypoint_index would discard exactly the input<->visit correspondence
  // this function exists to produce (it'd collapse to the trivial identity
  // sequence [0, 1, ..., n-1] regardless of the real optimized order).
  const visitOrderByInputIndex = json.waypoints.map(w => w.waypoint_index);

  return { trip: json.trips[0], visitOrderByInputIndex };
}

/** Renders a single OSRM maneuver into a short human-readable instruction,
 * e.g. "Turn left onto Main St" — used for the "next turn" hint on each
 * stop. Returns undefined when there's nothing useful to say (no street
 * name, e.g. leaving a parking lot), rather than showing a vague fallback. */
export function describeManeuver(step: OsrmStep | undefined): string | undefined {
  if (!step) return undefined;
  const { type, modifier } = step.maneuver;
  const street = step.name?.trim();

  if (type === 'arrive') return street ? `Arrive at ${street}` : 'Arrive at destination';
  if (type === 'depart') return street ? `Head out on ${street}` : undefined;
  if (!street) return undefined;

  const verb =
    type === 'roundabout' || type === 'rotary'
      ? 'Enter the roundabout, then continue on'
      : modifier
        ? `${modifier[0].toUpperCase()}${modifier.slice(1)}`
        : 'Continue on';
  const onto = type === 'turn' || type === 'merge' || type === 'fork' ? 'onto' : 'on';
  return `${verb} ${onto} ${street}`;
}
