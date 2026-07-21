import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { AnimatedPressable } from './AnimatedPressable';
import type { StoreName, TripPlan } from '../models/types';
import type { StopProgress } from '../services/navigationController';
import type { LiveLocation } from '../services/liveLocationService';
import type { NavigationMode } from '../store/routeStore';
import { colors, storeAccents } from '../theme/colors';
import { radius, elevation } from '../theme/metrics';

interface Props {
  trip: TripPlan;
  /** Store chain per stop, same order as `trip.stops` — used only to color
   * each marker consistently with that store's accent color elsewhere in
   * the app (StoreLocation itself doesn't carry the chain name). */
  stopStores: StoreName[];
  /** Pickup-checklist completion per stop, same order as `trip.stops` —
   * drives the completed/active/upcoming marker treatment. Pushed into
   * the running page via `injectJavaScript`, never rebuilds the WebView —
   * see the perf note below. */
  stopProgress: StopProgress[];
  /** Index of the current destination — trip.stops.length once every stop
   * is done. */
  activeStopIndex: number;
  liveLocation: LiveLocation | null;
  followMode: boolean;
  /** Trip Overview (flat, whole-trip bounds-fit) vs Navigation Mode
   * (zoomed/pitched/rotated, camera follows the live position). Mode
   * changes never rebuild the WebView — see the perf note below. */
  mode: NavigationMode;
  onManualPan: () => void;
  onRecenter: () => void;
  style?: StyleProp<ViewStyle>;
}

/**
 * The "MapRenderer" — real vector map tiles (roads, buildings, parks,
 * water, labels, business POIs — see OpenFreeMap's "liberty" style) via
 * MapLibre GL JS running inside a WebView, not a native map SDK. This app
 * runs on Expo Go (no custom dev client), and both `react-native-maps`
 * and `expo-maps` require native code Expo Go doesn't bundle — a WebView
 * is the one map-rendering path that works today without forcing a
 * dev-client rebuild, and MapLibre GL JS is a pure browser/WebGL library
 * that natively supports the pitch/bearing camera work Navigation Mode
 * needs (Leaflet, used before, has no equivalent).
 *
 * The HTML page is built exactly once per trip (`useMemo` keyed only on
 * `[trip, stopStores]`, which never change during an active trip) and is
 * never rebuilt after that — not on a live GPS tick, not on a mode
 * switch, and critically not on a checklist toggle either. Every one of
 * those is pushed into the already-running page via `injectJavaScript`,
 * which is what keeps tracking, the overview↔navigation transition, and
 * marking a stop complete all smooth instead of flashing a full page
 * reload on every interaction.
 */
export function RouteMap({
  trip, stopStores, stopProgress, activeStopIndex, liveLocation, followMode, mode, onManualPan, onRecenter, style,
}: Props) {
  const webViewRef = useRef<WebView>(null);
  // Captured once, at mount (lazy initializer — never recomputed), purely
  // to seed the initial marker states and the initial (pre-GPS) route
  // split — see buildMapHtml. Deliberately NOT re-derived from live props
  // on every render: every state change after mount goes through
  // __updateStopStates instead of a rebuild.
  const [initialStopProgress] = useState(() => stopProgress);
  const [initialActiveStopIndex] = useState(() => activeStopIndex);

  const html = useMemo(
    () => buildMapHtml(trip, stopStores, initialStopProgress, initialActiveStopIndex),
    [trip, stopStores, initialStopProgress, initialActiveStopIndex],
  );

  // Live location: pushed into the running page, not rebuilt into the HTML
  // — see the perf note above. Cheap enough to fire on every GPS tick.
  useEffect(() => {
    if (!liveLocation || !webViewRef.current) return;
    const heading = liveLocation.heading ?? 'null';
    webViewRef.current.injectJavaScript(
      `window.__updateUserLocation && window.__updateUserLocation(${liveLocation.latitude}, ${liveLocation.longitude}, ${heading}, ${followMode}); true;`,
    );
  }, [liveLocation, followMode]);

  // Follow-mode toggling alone (e.g. tapping "recenter" without a new GPS
  // tick yet) still needs to re-center on the last known position.
  useEffect(() => {
    if (!webViewRef.current) return;
    webViewRef.current.injectJavaScript(`window.__setFollowMode && window.__setFollowMode(${followMode}); true;`);
  }, [followMode]);

  // Overview ↔ Navigation — a camera transition, never a page reload, so
  // it can animate smoothly from wherever the map currently sits.
  useEffect(() => {
    if (!webViewRef.current) return;
    webViewRef.current.injectJavaScript(
      `window.__setNavigationMode && window.__setNavigationMode(${JSON.stringify(mode === 'navigation')}); true;`,
    );
  }, [mode]);

  // Stop-marker visuals (upcoming/active/completed) update in place — a
  // checklist toggle should never cost a full map reload. The injected
  // function itself no-ops per-marker when a state hasn't actually
  // changed, so this is cheap even though it re-fires on every render.
  useEffect(() => {
    if (!webViewRef.current) return;
    const states = trip.stops.map((_, i) =>
      stopProgress[i]?.isComplete ? 'completed' : i === activeStopIndex ? 'active' : 'upcoming',
    );
    webViewRef.current.injectJavaScript(
      `window.__updateStopStates && window.__updateStopStates(${safeJson(states)}); true;`,
    );
  }, [trip, stopProgress, activeStopIndex]);

  const handleMessage = (event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data) as { type?: string };
      if (msg.type === 'manualPan') onManualPan();
    } catch {
      // Ignore malformed messages rather than crash the screen over a
      // rendering-only concern.
    }
  };

  return (
    <View style={[styles.container, style]}>
      <WebView
        ref={webViewRef}
        originWhitelist={['*']}
        source={{ html }}
        style={styles.webview}
        scrollEnabled={false}
        javaScriptEnabled
        onMessage={handleMessage}
      />
      {!followMode && (
        <AnimatedPressable style={styles.recenterButton} onPress={onRecenter} scaleTo={0.92}>
          <Ionicons name="navigate" size={18} color={colors.green} />
        </AnimatedPressable>
      )}
    </View>
  );
}

// Guards against a store name/address that happens to contain "</script"
// prematurely closing the embedded <script> block — store data comes from
// trusted retailer APIs, not user input, but this is a free, correct
// precaution for any string ending up inside inline HTML. Reused for
// every injectJavaScript payload above, not just the initial HTML build.
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/<\/script/gi, '<\\/script');
}

/** Index of the nearest coordinate to `target`, searched only from
 * `fromIdx` onward — used to split the real routing-engine geometry at a
 * stop's location. Searching forward-only (rather than the whole route)
 * is what makes this safe for stops that sit close together in raw
 * lat/lng space (e.g. two stores a few hundred feet apart on the same
 * road): each stop's match is constrained to come after the previous
 * stop's, so it can never "jump back" to an earlier, coincidentally
 * closer vertex on a different leg. Derived entirely from real route
 * geometry, never a fabricated split point. */
function nearestForwardIndex(
  coordinates: [number, number][],
  target: { latitude?: number; longitude?: number },
  fromIdx: number,
): number | null {
  if (target.latitude == null || target.longitude == null) return null;
  let bestIdx = fromIdx;
  let bestDist = Infinity;
  for (let i = fromIdx; i < coordinates.length; i++) {
    const [lng, lat] = coordinates[i];
    const d = (lat - target.latitude) ** 2 + (lng - target.longitude) ** 2;
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** The initial (pre-GPS) traveled/remaining split for Navigation Mode,
 * anchored to the last completed stop — superseded the moment a live GPS
 * position arrives (see `__updateUserLocation` in the injected script,
 * which re-splits against the shopper's actual position instead). Walks
 * every stop in order, each search starting where the previous stop's
 * match left off, so the split point is always resolved correctly even
 * when stops sit close together. */
function computeInitialSplitIndex(coordinates: [number, number][], trip: TripPlan, activeStopIndex: number): number {
  if (activeStopIndex <= 0 || coordinates.length === 0) return 0;
  let searchFrom = 0;
  let lastIdx = 0;
  for (let i = 0; i < Math.min(activeStopIndex, trip.stops.length); i++) {
    const idx = nearestForwardIndex(coordinates, trip.stops[i].location, searchFrom);
    if (idx != null) {
      lastIdx = idx;
      searchFrom = idx;
    }
  }
  return lastIdx;
}

interface MarkerSpec {
  lat: number | undefined;
  lng: number | undefined;
  label: string;
  color: string;
  name: string;
  address: string;
  state: 'completed' | 'active' | 'upcoming';
}

// Unicode circled digits — a nice concrete "① ② ③" touch for the first
// ten stops; a plain numeral badge (still a clearly numbered dot) covers
// any trip longer than that rather than silently running out of glyphs.
const CIRCLED_DIGITS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
function stopLabel(index: number): string {
  return CIRCLED_DIGITS[index] ?? String(index + 1);
}

function buildMapHtml(
  trip: TripPlan,
  stopStores: StoreName[],
  stopProgress: StopProgress[],
  activeStopIndex: number,
): string {
  const routeCoords = trip.routeGeometry.coordinates;
  const initialSplitIdx = computeInitialSplitIndex(routeCoords, trip, activeStopIndex);

  const markers: MarkerSpec[] = trip.stops.map((stop, i) => ({
    lat: stop.location.latitude,
    lng: stop.location.longitude,
    label: stopLabel(i),
    color: storeAccents[stopStores[i]]?.dot ?? '#2C742F',
    name: stop.location.name,
    address: `${stop.location.address}, ${stop.location.city}, ${stop.location.state} ${stop.location.zip}`,
    state: stopProgress[i]?.isComplete ? 'completed' : i === activeStopIndex ? 'active' : 'upcoming',
  }));

  const bounds: [number, number][] = [
    [trip.origin.longitude, trip.origin.latitude],
    ...markers
      .filter((m): m is MarkerSpec & { lat: number; lng: number } => m.lat != null && m.lng != null)
      .map((m): [number, number] => [m.lng, m.lat]),
  ];

  return `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
  <link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css" />
  <style>
    html, body, #map { height: 100%; margin: 0; padding: 0; background: #E5E7EB; }
    /* Every stop — upcoming, active, or completed — is the same
       pin-shaped marker at the same anchor box, so a state change only
       ever has to mutate fill/opacity/label in place (see
       __updateStopStates) instead of swapping shapes and re-anchoring. */
    .stop-pin-wrap { position: relative; width: 34px; height: 44px; }
    .stop-pin-svg-host { width: 34px; height: 44px; transition: opacity 0.3s ease; }
    .pulse-ring {
      position: absolute; width: 34px; height: 34px; border-radius: 17px; top: 0; left: 0;
      background: var(--pin-color, #2C742F); opacity: 0.35; display: none;
      animation: pulse-ring 1.8s ease-out infinite;
    }
    @keyframes pulse-ring {
      0% { transform: scale(1); opacity: 0.45; }
      100% { transform: scale(2.2); opacity: 0; }
    }
    .origin-pin {
      width: 16px; height: 16px; border-radius: 8px; background: #6B7280;
      border: 3px solid #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.35);
    }
    /* The live "you are here" marker — a dominant navigation chevron
       (not a generic dot) with a soft halo. MapLibre positions AND
       rotates markers via a single CSS transform on this root element
       (see rotationAlignment/setRotation below), so one transition rule
       here is enough to smoothly interpolate both movement and heading
       changes between GPS fixes — MapLibre has no built-in marker
       tweening, but its updates are plain transform writes, which a CSS
       transition happily smooths on its own. */
    .user-marker-wrap {
      width: 46px; height: 46px; display: flex; align-items: center; justify-content: center;
      transition: transform 0.5s linear;
    }
    .user-marker-halo {
      position: absolute; width: 46px; height: 46px; border-radius: 23px; background: rgba(37,99,235,0.16);
    }
    .user-marker-arrow-host { width: 34px; height: 34px; }
    .maplibregl-popup-content { font-family: -apple-system, sans-serif; font-size: 12.5px; padding: 8px 10px; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
  <script>
    var OVERVIEW_PITCH = 0;
    var NAV_ZOOM = 17.5;
    var NAV_PITCH = 55;

    var map = new maplibregl.Map({
      container: 'map',
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [${trip.origin.longitude}, ${trip.origin.latitude}],
      zoom: 12,
      pitch: OVERVIEW_PITCH,
      attributionControl: false,
      maxPitch: 60,
    });

    var followMode = true;
    var navMode = false;
    var lastUserLoc = null;
    var lastHeading = null;
    var currentDestination = null;
    var userMarker = null;
    var originMarker = null;
    var bounds = ${safeJson(bounds)};
    var stopMarkers = [];

    var routeCoords = ${safeJson(routeCoords)};
    var splitIdx = ${initialSplitIdx};
    var routeTraveledSource = null;
    var routeRemainingSource = null;

    function stopPinSvg(color, label) {
      return '<svg width="34" height="44" viewBox="0 0 34 44" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M17 0C7.6 0 0 7.6 0 17c0 12.4 17 27 17 27s17-14.6 17-27C34 7.6 26.4 0 17 0z" fill="' + color + '" stroke="#fff" stroke-width="2"/>' +
        '<circle cx="17" cy="16" r="10.5" fill="#fff"/>' +
        '<text x="17" y="21" text-anchor="middle" font-family="-apple-system,sans-serif" font-weight="700" font-size="13" fill="' + color + '">' + label + '</text>' +
        '</svg>';
    }

    // Applies a marker's current state to its already-created DOM element
    // — mutates fill/label/ring in place, never recreates the element or
    // the maplibregl.Marker wrapping it, so this is safe to call from
    // __updateStopStates on every checklist change without any reload.
    function applyStopState(el, m) {
      var svgHost = el.querySelector('.stop-pin-svg-host');
      var ring = el.querySelector('.pulse-ring');
      var color = m.state === 'completed' ? '#9CA3AF' : m.color;
      var label = m.state === 'completed' ? '\\u2713' : m.label;
      svgHost.innerHTML = stopPinSvg(color, label);
      svgHost.style.opacity = m.state === 'completed' ? '0.5' : '1';
      ring.style.display = m.state === 'active' ? 'block' : 'none';
      ring.style.setProperty('--pin-color', m.color);
      if (m.state === 'active') currentDestination = [m.lng, m.lat];
    }

    function makeStopMarkerEl() {
      var wrap = document.createElement('div');
      wrap.className = 'stop-pin-wrap';
      var ring = document.createElement('div');
      ring.className = 'pulse-ring';
      var svgHost = document.createElement('div');
      svgHost.className = 'stop-pin-svg-host';
      wrap.appendChild(ring);
      wrap.appendChild(svgHost);
      return wrap;
    }

    function fitOverviewBounds(extra) {
      var all = extra ? bounds.concat([extra]) : bounds;
      if (all.length === 0) return;
      var b = all.reduce(function (acc, c) { return acc.extend(c); }, new maplibregl.LngLatBounds(all[0], all[0]));
      map.fitBounds(b, { padding: { top: 70, bottom: 70, left: 44, right: 44 }, duration: navMode ? 0 : 1000, maxZoom: 16 });
    }

    function setRouteData(traveled, remaining) {
      if (routeTraveledSource) routeTraveledSource.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: traveled }, properties: {} });
      if (routeRemainingSource) routeRemainingSource.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: remaining }, properties: {} });
    }

    // Great-circle bearing from "from" to "to" ([lng,lat] pairs, degrees)
    // — the camera-orientation fallback for when the device can't report
    // a live heading (no magnetometer / not yet moving fast enough for a
    // GPS course), so Navigation Mode still visibly faces "the direction
    // I need to go" instead of defaulting to north-up.
    function bearingToward(from, to) {
      var lat1 = from[1] * Math.PI / 180, lat2 = to[1] * Math.PI / 180;
      var dLon = (to[0] - from[0]) * Math.PI / 180;
      var y = Math.sin(dLon) * Math.cos(lat2);
      var x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
      return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    }

    function resolveBearing(fromLngLat) {
      if (lastHeading != null) return lastHeading;
      if (currentDestination) return bearingToward(fromLngLat, currentDestination);
      return map.getBearing();
    }

    map.on('load', function () {
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

      var stops = ${safeJson(markers)};
      stops.forEach(function (m) {
        if (m.lat == null || m.lng == null) { stopMarkers.push(null); return; }
        var el = makeStopMarkerEl();
        applyStopState(el, m);
        var marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
          .setLngLat([m.lng, m.lat])
          .setPopup(new maplibregl.Popup({ offset: 38 }).setHTML('<b>' + m.name + '</b><br/>' + m.address))
          .addTo(map);
        stopMarkers.push({ marker: marker, el: el, data: m });
      });

      var traveled = routeCoords.slice(0, splitIdx + 1);
      var remaining = routeCoords.slice(splitIdx);

      map.addSource('route-traveled', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: traveled }, properties: {} } });
      map.addLayer({ id: 'route-traveled', type: 'line', source: 'route-traveled', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#9CA3AF', 'line-width': 4, 'line-opacity': 0.7 } });
      routeTraveledSource = map.getSource('route-traveled');

      map.addSource('route-remaining', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: remaining }, properties: {} } });
      map.addLayer({ id: 'route-remaining', type: 'line', source: 'route-remaining', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#2C742F', 'line-width': 5, 'line-opacity': 0.9 } });
      routeRemainingSource = map.getSource('route-remaining');
      // Overview never shows a traveled/remaining split (that's a
      // Navigation Mode concept) — starts hidden, revealed only by
      // __setNavigationMode(true).
      map.setLayoutProperty('route-traveled', 'visibility', 'none');

      // Static origin pin — shown until (and unless) live GPS tracking
      // produces a real position, at which point the live marker replaces it.
      var originEl = document.createElement('div');
      originEl.className = 'origin-pin';
      originMarker = new maplibregl.Marker({ element: originEl, anchor: 'center' })
        .setLngLat([${trip.origin.longitude}, ${trip.origin.latitude}])
        .setPopup(new maplibregl.Popup({ offset: 14 }).setText('Trip start'))
        .addTo(map);

      fitOverviewBounds(null);

      map.on('dragstart', function (e) {
        // originalEvent is only present for real user gestures, never for
        // our own programmatic easeTo/flyTo follow-mode moves.
        if (e.originalEvent && window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'manualPan' }));
        }
      });
    });

    // Forward-only nearest-vertex search from the last known split point —
    // the shopper only ever moves forward along the route, so constraining
    // the search this way both is cheap (bounded to the remaining stretch)
    // and can never jump backward to an earlier, coincidentally close
    // vertex on a different leg.
    function nearestForwardIndexJS(lng, lat, fromIdx) {
      var best = fromIdx, bestDist = Infinity;
      for (var i = fromIdx; i < routeCoords.length; i++) {
        var dx = routeCoords[i][0] - lng, dy = routeCoords[i][1] - lat;
        var d = dx * dx + dy * dy;
        if (d < bestDist) { bestDist = d; best = i; }
      }
      return best;
    }

    // Called from React Native on every live GPS update — never rebuilds
    // the page, just moves/rotates the marker (smoothed by the CSS
    // transition on .user-marker-wrap), keeps the traveled/remaining
    // split anchored to the shopper's real position while navigating, and
    // (if following) recenters/re-orients the camera.
    window.__updateUserLocation = function (lat, lng, heading, following) {
      lastUserLoc = [lng, lat];
      if (heading != null) lastHeading = heading;
      var bearing = resolveBearing([lng, lat]);

      if (!userMarker) {
        if (originMarker) { originMarker.remove(); originMarker = null; }
        var wrap = document.createElement('div');
        wrap.className = 'user-marker-wrap';
        var halo = document.createElement('div');
        halo.className = 'user-marker-halo';
        var arrowHost = document.createElement('div');
        arrowHost.className = 'user-marker-arrow-host';
        arrowHost.innerHTML = userArrowSvg();
        wrap.appendChild(halo);
        wrap.appendChild(arrowHost);
        // rotationAlignment: 'map' + setRotation (below) is MapLibre's
        // real rotation API — it rotates the marker in absolute,
        // map-relative terms and keeps applying that same transform even
        // as the CAMERA's own bearing changes underneath it, so the
        // arrow always points the shopper's true heading rather than
        // needing to be manually re-computed relative to the camera.
        userMarker = new maplibregl.Marker({ element: wrap, anchor: 'center', rotationAlignment: 'map' })
          .setLngLat([lng, lat])
          .addTo(map);
        if (!navMode) fitOverviewBounds([lng, lat]);
      } else {
        userMarker.setLngLat([lng, lat]);
      }

      userMarker.setRotation(bearing);

      if (navMode) {
        splitIdx = nearestForwardIndexJS(lng, lat, splitIdx);
        setRouteData(routeCoords.slice(0, splitIdx + 1), routeCoords.slice(splitIdx));
      }

      if (following) {
        if (navMode) {
          map.easeTo({ center: [lng, lat], zoom: NAV_ZOOM, pitch: NAV_PITCH, bearing: bearing, duration: 500 });
        } else {
          map.easeTo({ center: [lng, lat], duration: 400 });
        }
      }
    };

    // A dominant navigation-chevron (not a generic dot/triangle) — wide
    // at the tail, pointed at the tip, the same silhouette every modern
    // turn-by-turn app uses for "this is you, this is which way you're
    // facing."
    function userArrowSvg() {
      return '<svg width="34" height="34" viewBox="0 0 34 34" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M17 2 L29 29 L17 22 L5 29 Z" fill="#2563EB" stroke="#fff" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' +
        '</svg>';
    }

    window.__setFollowMode = function (following) {
      followMode = following;
      if (following && lastUserLoc) {
        var bearing = resolveBearing(lastUserLoc);
        if (navMode) {
          map.easeTo({ center: lastUserLoc, zoom: NAV_ZOOM, pitch: NAV_PITCH, bearing: bearing, duration: 500 });
        } else {
          map.easeTo({ center: lastUserLoc, duration: 400 });
        }
      }
    };

    // Trip Overview <-> Navigation Mode — the one camera transition that's
    // always allowed to animate (never instant), so pressing "Start Route"
    // visibly feels like the app is taking you into guidance rather than
    // just swapping a screen.
    window.__setNavigationMode = function (isNav) {
      navMode = isNav;
      if (isNav) {
        map.setLayoutProperty('route-traveled', 'visibility', 'visible');
        var center = lastUserLoc || [${trip.origin.longitude}, ${trip.origin.latitude}];
        map.easeTo({ center: center, zoom: NAV_ZOOM, pitch: NAV_PITCH, bearing: resolveBearing(center), duration: 1200 });
      } else {
        map.setLayoutProperty('route-traveled', 'visibility', 'none');
        map.easeTo({ pitch: OVERVIEW_PITCH, bearing: 0, duration: 700 });
        fitOverviewBounds(lastUserLoc);
      }
    };

    // Pushed on every checklist change (see RouteMap.tsx's effect) —
    // updates only the markers whose state actually changed, in place,
    // with a CSS opacity transition on the completed fade rather than a
    // page reload.
    window.__updateStopStates = function (states) {
      for (var i = 0; i < states.length; i++) {
        var ref = stopMarkers[i];
        if (!ref || ref.data.state === states[i]) continue;
        ref.data.state = states[i];
        applyStopState(ref.el, ref.data);
      }
    };
  </script>
</body>
</html>`;
}

const styles = StyleSheet.create({
  container: { overflow: 'hidden' },
  webview: { flex: 1, backgroundColor: '#E5E7EB' },
  recenterButton: {
    position: 'absolute',
    bottom: 12,
    right: 12,
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    ...elevation.medium,
  },
});
