import * as Location from 'expo-location';

/**
 * The "NavigationController" GPS feed — continuous position + compass
 * heading updates for the active Route screen, separate from
 * `locationService.ts`'s one-shot `getCurrentCoordinates()` (used for
 * "how far is this store" hints and the initial trip origin, which only
 * ever need a single snapshot). Live tracking is its own concern: it has
 * to start/stop cleanly with the screen, push updates efficiently, and
 * carry a heading for the map's rotating direction indicator.
 *
 * Never fabricates a position: if permission is denied or GPS is
 * unavailable, callers simply stop receiving updates — the same
 * "null/absent means unknown, never guessed" contract the rest of the
 * app's location handling already follows.
 */
export interface LiveLocation {
  latitude: number;
  longitude: number;
  /** Compass heading in degrees (0 = north), when the device can report
   * one — absent on devices/simulators without a magnetometer. */
  heading: number | null;
  accuracyMeters: number | null;
}

// Balances battery/CPU cost against how often a walking-or-driving shopper
// actually needs the puck to move — finer than this is imperceptible on a
// phone-sized map and just churns re-renders.
const DISTANCE_INTERVAL_METERS = 5;
const TIME_INTERVAL_MS = 2000;

/**
 * Starts watching the device's live position (and, where available,
 * compass heading) and invokes `onUpdate` for every change. Returns an
 * unsubscribe function that must be called when the consumer unmounts —
 * watches are real OS-level sensors and keep running (and draining
 * battery) until explicitly stopped.
 *
 * Resolves permission once up front; if denied, `onUpdate` is simply never
 * called (mirrors `getCurrentCoordinates()`'s "no coordinates available"
 * contract rather than throwing).
 */
export function subscribeToLiveLocation(onUpdate: (location: LiveLocation) => void): () => void {
  let cancelled = false;
  let positionSub: Location.LocationSubscription | null = null;
  let headingSub: Location.LocationSubscription | null = null;
  let lastHeading: number | null = null;

  (async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted' || cancelled) return;

    positionSub = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        distanceInterval: DISTANCE_INTERVAL_METERS,
        timeInterval: TIME_INTERVAL_MS,
      },
      (position) => {
        if (cancelled) return;
        onUpdate({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          // GPS-derived course-over-ground is a steadier "which way am I
          // facing" signal while actually moving/driving than the raw
          // magnetometer heading, which jitters near metal/electronics —
          // fall back to the compass only when the device isn't moving
          // fast enough to have a reliable course.
          heading: position.coords.heading != null && position.coords.heading >= 0
            ? position.coords.heading
            : lastHeading,
          accuracyMeters: position.coords.accuracy,
        });
      },
    );
    if (cancelled) {
      positionSub.remove();
      return;
    }

    try {
      headingSub = await Location.watchHeadingAsync((event) => {
        lastHeading = event.trueHeading >= 0 ? event.trueHeading : event.magHeading;
      });
      if (cancelled) headingSub.remove();
    } catch {
      // No magnetometer (common on simulators) — course-over-ground from
      // watchPositionAsync above still covers heading while moving.
    }
  })();

  return () => {
    cancelled = true;
    positionSub?.remove();
    headingSub?.remove();
  };
}
