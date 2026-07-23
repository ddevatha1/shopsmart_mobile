import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCartStore } from '../store/cartStore';
import { useSearchStore } from '../store/searchStore';
import { useUserStore } from '../store/userStore';
import { useRouteStore } from '../store/routeStore';
import { groupCartByStore, locationKey } from '../utils/groupCartByStore';
import { planShoppingTrip } from '../services/tripService';
import { requestPreciseLocation } from '../services/locationService';
import { subscribeToLiveLocation, type LiveLocation } from '../services/liveLocationService';
import { LocationPermissionModal } from '../components/route/LocationPermissionModal';
import {
  computeStopProgress,
  computeTripProgress,
  computeTripSignature,
  type StopProgress,
  type TripProgress,
} from '../services/navigationController';
import { recordPurchases } from '../services/purchaseHistoryService';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { RouteMap } from '../components/RouteMap';
import { colors, storeAccents } from '../theme/colors';
import { spacing, radius, elevation } from '../theme/metrics';
import { duration, easing, spring } from '../theme/motion';
import type { RootStackParamList } from '../navigation/types';
import type { CartItem, StoreGroup, StoreName, TripPlan } from '../models/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Route'>;

// One explainer per app session (module-scoped, so it survives navigating
// away and back within the same launch but resets on a fresh app start),
// not once per visit to this screen — a shopper who already said yes (or
// explicitly skipped) shouldn't be asked again just for returning to the
// cart and coming back here.
let hasSeenLocationPrompt = false;

/**
 * The "Navigation UI" layer — orchestrates the other route-planning pieces
 * (groupCartByStore for store selection, tripService for the real routing
 * call, navigationController for all derived progress state, routeStore
 * for checklist persistence + follow-mode, liveLocationService for GPS,
 * RouteMap for rendering) but contains no routing/progress logic of its
 * own — every number shown here comes from one of those modules. Reads the
 * cart directly from useCartStore, same as every other screen reading
 * shared app state.
 */
export function RouteScreen({ navigation }: Props) {
  const items = useCartStore((s) => s.items);
  const activeZip = useSearchStore((s) => s.activeZip);
  const user = useUserStore((s) => s.user);
  const zipcode = activeZip || user?.zipcode || '';

  const { groups, itemsWithoutLocation } = useMemo(() => groupCartByStore(items), [items]);
  // Remounts TripLoader (and so its internal loading/error/trip state)
  // whenever the actual set of stops or the origin changes, instead of an
  // effect resetting state synchronously — React's own recommended pattern
  // for "reset state when an input changes" (see
  // react.dev/learn/you-might-not-need-an-effect).
  const routeKey = `${groups.map((g) => locationKey(g.location)).join(',')}|${zipcode}`;

  const [locationPromptSeen, setLocationPromptSeen] = useState(hasSeenLocationPrompt);
  const dismissLocationPrompt = () => {
    hasSeenLocationPrompt = true;
    setLocationPromptSeen(true);
  };
  const handleShareLocation = async () => {
    // Errors (denied/unavailable/timeout) resolve to null — tripService's
    // own getCurrentCoordinates() fallback to the saved ZIP still applies,
    // exactly as if the shopper had tapped "skip" instead.
    await requestPreciseLocation();
    dismissLocationPrompt();
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.header}>
        <AnimatedPressable
          onPress={() => navigation.goBack()}
          style={styles.backButton}
          scaleTo={0.9}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="chevron-back" size={22} color={colors.charcoal} />
        </AnimatedPressable>
        <Text style={styles.headerTitle}>Your Route</Text>
        <View style={{ width: 40 }} />
      </View>

      {items.length === 0 ? (
        <View style={styles.centerState}>
          <Ionicons name="cart-outline" size={40} color={`${colors.charcoal}33`} />
          <Text style={styles.emptyText}>Your cart is empty — add items to plan a route.</Text>
        </View>
      ) : groups.length === 0 ? (
        <View style={styles.centerState}>
          <Ionicons name="warning-outline" size={40} color="#B45309" />
          <Text style={styles.emptyText}>
            None of the items in your cart can be routed to yet — we don&apos;t have a store location for:
          </Text>
          {itemsWithoutLocation.map((item) => (
            <Text key={item.product.id} style={styles.warningItemText}>
              • {item.product.name} ({item.product.store})
            </Text>
          ))}
        </View>
      ) : !locationPromptSeen ? (
        <LocationPermissionModal visible onShare={handleShareLocation} onSkip={dismissLocationPrompt} />
      ) : (
        <TripLoader
          key={routeKey}
          groups={groups}
          zipcode={zipcode}
          itemsWithoutLocation={itemsWithoutLocation}
          totalProducts={items.reduce((sum, i) => sum + i.quantity, 0)}
        />
      )}
    </SafeAreaView>
  );
}

function TripLoader({ groups, zipcode, itemsWithoutLocation, totalProducts }: {
  groups: StoreGroup[];
  zipcode: string;
  itemsWithoutLocation: CartItem[];
  totalProducts: number;
}) {
  const [trip, setTrip] = useState<TripPlan | null>(null);
  // Captured once when the trip finishes loading (not read live via
  // Date.now() during render) so "estimated arrival" times stay stable
  // across re-renders instead of drifting on every paint.
  const [tripStartTime, setTripStartTime] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    planShoppingTrip(groups.map((g) => g.location), zipcode)
      .then((plan) => {
        if (cancelled) return;
        setTrip(plan);
        setTripStartTime(Date.now());
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not plan a route.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // This component is remounted (via `key`) whenever groups/zipcode
    // actually change, so a plain mount-once effect is correct here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Match each returned stop back to the StoreGroup that produced it, both
  // for the store-accent color on the map and for the pick-up checklist.
  const groupByKey = useMemo(() => {
    const map = new Map<string, StoreGroup>();
    for (const g of groups) map.set(locationKey(g.location), g);
    return map;
  }, [groups]);

  const stopKeys = useMemo(() => trip?.stops.map((s) => locationKey(s.location)) ?? [], [trip]);
  const tripSignature = useMemo(() => computeTripSignature(stopKeys), [stopKeys]);

  // routeStore is the RouteStateManager — checklist + follow-mode live
  // there, persisted across app backgrounding, not in this component.
  const hydrateForTrip = useRouteStore((s) => s.hydrateForTrip);
  useEffect(() => {
    if (trip) hydrateForTrip(tripSignature);
  }, [trip, tripSignature, hydrateForTrip]);

  const checklist = useRouteStore((s) => s.checklist);
  const toggleItem = useRouteStore((s) => s.toggleItem);
  const followMode = useRouteStore((s) => s.followMode);
  const setFollowMode = useRouteStore((s) => s.setFollowMode);
  const navigationMode = useRouteStore((s) => s.navigationMode);
  const startNavigation = useRouteStore((s) => s.startNavigation);
  const exitNavigation = useRouteStore((s) => s.exitNavigation);

  const stopGroups = useMemo(
    () => trip?.stops.map((stop) => groupByKey.get(locationKey(stop.location))) ?? [],
    [trip, groupByKey],
  );
  const stopStores: StoreName[] = stopGroups.map((g) => g?.items[0]?.product.store ?? "Trader Joe's");
  const stopItems = useMemo(() => stopGroups.map((g) => g?.items ?? []), [stopGroups]);

  const stopProgressList: StopProgress[] = useMemo(
    () => stopKeys.map((key, i) => computeStopProgress(stopItems[i] ?? [], checklist[key])),
    [stopKeys, stopItems, checklist],
  );

  const tripProgress: TripProgress | null = useMemo(
    () => (trip ? computeTripProgress(trip, stopItems, checklist, stopKeys) : null),
    [trip, stopItems, checklist, stopKeys],
  );

  // Pantry reminders (see purchaseHistoryService) need a real purchase
  // log — the only real "this left the store" signal this app has is the
  // shopper finishing a stop's own pickup checklist. Records once per
  // stop, the moment it flips to complete, never on every render.
  const ownerEmail = useUserStore((s) => s.user?.email ?? '');
  const recordedStops = useRef<Record<string, boolean>>({});
  useEffect(() => {
    if (!ownerEmail) return;
    stopKeys.forEach((key, i) => {
      const isComplete = stopProgressList[i]?.isComplete ?? false;
      if (isComplete && !recordedStops.current[key]) {
        recordedStops.current[key] = true;
        recordPurchases(ownerEmail, stopItems[i] ?? []);
      }
    });
  }, [ownerEmail, stopKeys, stopProgressList, stopItems]);

  // Live location: a continuous GPS (+ heading) feed for the map's puck.
  // Subscribed once per trip; never blocks rendering if permission is
  // denied — the map just keeps showing the static trip-start pin.
  const [liveLocation, setLiveLocation] = useState<LiveLocation | null>(null);
  useEffect(() => {
    return subscribeToLiveLocation(setLiveLocation);
  }, []);

  // Auto-focus the next destination: when the active stop advances (the
  // shopper just finished checking off the previous stop's items), scroll
  // its card into view instead of leaving them looking at a collapsed,
  // completed stop.
  const scrollRef = useRef<ScrollView>(null);
  const stopOffsets = useRef<Record<number, number>>({});
  const prevActiveIndex = useRef<number | null>(null);
  useEffect(() => {
    if (!tripProgress) return;
    if (prevActiveIndex.current !== null && prevActiveIndex.current !== tripProgress.activeStopIndex) {
      const y = stopOffsets.current[tripProgress.activeStopIndex];
      if (y != null) scrollRef.current?.scrollTo({ y: Math.max(0, y - spacing.md), animated: true });
    }
    prevActiveIndex.current = tripProgress.activeStopIndex;
    // Deliberately keyed on just the index, not the whole `tripProgress`
    // object — this should only fire when the active stop actually
    // changes, not on every checklist tick that leaves it unchanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripProgress?.activeStopIndex]);

  // Stores the backend received but couldn't resolve coordinates for (no
  // lat/lng from the store itself, and its address didn't geocode either) —
  // matched back to the cart items that produced them so the warning below
  // can name the actual products, not just a count.
  const unresolvedItems = (trip?.unresolvedStops ?? []).flatMap(
    (stop) => groupByKey.get(locationKey(stop))?.items ?? [],
  );
  const unroutableItems = [...itemsWithoutLocation, ...unresolvedItems];

  if (loading) {
    return (
      <View style={styles.centerState}>
        <ActivityIndicator color={colors.green} size="large" />
        <Text style={styles.loadingText}>Finding the best route to {groups.length} store{groups.length !== 1 ? 's' : ''}…</Text>
      </View>
    );
  }

  if (error || !trip || !tripProgress) {
    return (
      <View style={styles.centerState}>
        <Ionicons name="alert-circle-outline" size={40} color={colors.errorRed} />
        <Text style={styles.errorText}>{error ?? 'Could not plan a route.'}</Text>
      </View>
    );
  }

  if (navigationMode === 'navigation') {
    const activeStop = trip.stops[tripProgress.activeStopIndex];
    const activeKey = activeStop ? stopKeys[tripProgress.activeStopIndex] : null;
    return (
      <View style={styles.navContainer}>
        <RouteMap
          trip={trip}
          stopStores={stopStores}
          stopProgress={stopProgressList}
          activeStopIndex={tripProgress.activeStopIndex}
          liveLocation={liveLocation}
          followMode={followMode}
          mode="navigation"
          onManualPan={() => setFollowMode(false)}
          onRecenter={() => setFollowMode(true)}
          style={styles.navMap}
        />
        <NavigationBanner activeStop={activeStop} tripStartTime={tripStartTime} />
        <NavigationPanel
          trip={trip}
          tripProgress={tripProgress}
          activeStop={activeStop}
          activeStopKey={activeKey}
          activeStopItems={activeStop ? stopItems[tripProgress.activeStopIndex] : []}
          activeStopProgress={activeStop ? stopProgressList[tripProgress.activeStopIndex] : undefined}
          checklist={activeKey ? (checklist[activeKey] ?? {}) : {}}
          onToggleItem={(productId) => activeKey && toggleItem(activeKey, productId)}
          onExit={exitNavigation}
          tripStartTime={tripStartTime}
        />
      </View>
    );
  }

  return (
    <ScrollView ref={scrollRef} contentContainerStyle={styles.scrollContent}>
      <RouteMap
        trip={trip}
        stopStores={stopStores}
        stopProgress={stopProgressList}
        activeStopIndex={tripProgress.activeStopIndex}
        liveLocation={liveLocation}
        followMode={followMode}
        mode="overview"
        onManualPan={() => setFollowMode(false)}
        onRecenter={() => setFollowMode(true)}
        style={styles.map}
      />

      <View style={styles.startRouteRow}>
        <AnimatedPressable style={styles.startRouteButton} onPress={startNavigation} scaleTo={0.97}>
          <Ionicons name="navigate" size={17} color={colors.white} />
          <Text style={styles.startRouteText}>
            {tripProgress.isTripComplete ? 'Review Route' : 'Start Route'}
          </Text>
        </AnimatedPressable>
      </View>

      <TripProgressHeader progress={tripProgress} />

      {unroutableItems.length > 0 && (
        <View style={styles.warningBox}>
          <Ionicons name="warning-outline" size={16} color="#B45309" />
          <View style={{ flex: 1 }}>
            <Text style={styles.warningText}>
              {unroutableItems.length} item{unroutableItems.length !== 1 ? 's' : ''} couldn&apos;t be included in
              this route — routing can&apos;t continue to a store until a valid location is known for it:
            </Text>
            {unroutableItems.map((item) => (
              <Text key={item.product.id} style={styles.warningItemText}>
                • {item.product.name} ({item.product.store})
              </Text>
            ))}
          </View>
        </View>
      )}

      <View style={styles.stopsHeader}>
        <Text style={styles.sectionTitle}>Stops</Text>
      </View>
      {trip.stops.map((stop, i) => (
        <View key={stopKeys[i]} onLayout={(e) => { stopOffsets.current[i] = e.nativeEvent.layout.y; }}>
          <StopCard
            index={i}
            stop={stop}
            store={stopStores[i]}
            items={stopItems[i]}
            progress={stopProgressList[i]}
            isActive={i === tripProgress.activeStopIndex}
            isFirst={i === 0}
            isLast={i === trip.stops.length - 1}
            tripStartTime={tripStartTime}
            checklist={checklist[stopKeys[i]] ?? {}}
            onToggleItem={(productId) => toggleItem(stopKeys[i], productId)}
          />
        </View>
      ))}
    </ScrollView>
  );
}

/**
 * The compact top banner shown only in Navigation Mode — "Continue to
 * Trader Joe's" / "Head toward Sprouts" plus distance and ETA to the
 * current destination, and the real next-turn instruction (from OSRM's
 * own maneuver data — see backend routingService.ts's describeManeuver)
 * when one is available. An absolute overlay pinned to the top of the
 * map, never pushing the map itself down — "compact and unobtrusive" per
 * the brief.
 */
function NavigationBanner({ activeStop, tripStartTime }: {
  activeStop: TripPlan['stops'][number] | undefined;
  tripStartTime: number;
}) {
  if (!activeStop) return null;
  const eta = new Date(tripStartTime + activeStop.cumulativeEtaMinutes * 60000);
  const etaLabel = eta.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const instruction = activeStop.nextManeuver ?? `Head toward ${activeStop.location.name}`;

  return (
    <Animated.View entering={FadeInDown.duration(400)} style={styles.navBanner}>
      <View style={styles.navBannerIcon}>
        <Ionicons name="navigate" size={17} color={colors.white} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.navBannerInstruction} numberOfLines={1}>{instruction}</Text>
        <Text style={styles.navBannerMeta} numberOfLines={1}>
          {activeStop.legDistanceMiles.toFixed(1)} mi to {activeStop.location.name} · ETA {etaLabel}
        </Text>
      </View>
    </Animated.View>
  );
}

/**
 * The compact, collapsible overlay shown during Navigation Mode —
 * everything the brief asks for (current destination, products remaining
 * at this stop, remaining time/distance, stores/items remaining) in one
 * panel below the map, never on top of it. Expands automatically the
 * moment a new stop becomes the active destination (arrival), so the
 * checklist is right there without an extra tap; collapses back down
 * once that stop is fully picked up. Manual taps still toggle it freely
 * in between.
 */
function NavigationPanel({
  trip, tripProgress, activeStop, activeStopKey, activeStopItems, activeStopProgress, checklist, onToggleItem, onExit,
  tripStartTime,
}: {
  trip: TripPlan;
  tripProgress: TripProgress;
  activeStop: TripPlan['stops'][number] | undefined;
  activeStopKey: string | null;
  activeStopItems: CartItem[];
  activeStopProgress: StopProgress | undefined;
  checklist: Record<string, boolean>;
  onToggleItem: (productId: string) => void;
  onExit: () => void;
  tripStartTime: number;
}) {
  const [expanded, setExpanded] = useState(false);

  // Expand automatically the moment a new stop becomes the destination
  // (arrival) — the shopper shouldn't have to tap anything to see what to
  // pick up here. Manual taps still toggle freely afterward.
  const prevStopKey = useRef<string | null>(null);
  useEffect(() => {
    if (activeStopKey && activeStopKey !== prevStopKey.current) setExpanded(true);
    prevStopKey.current = activeStopKey;
  }, [activeStopKey]);

  const finalStop = trip.stops[trip.stops.length - 1];
  const tripEta = new Date(tripStartTime + finalStop.cumulativeEtaMinutes * 60000);
  const tripEtaLabel = tripEta.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  return (
    <View style={styles.navPanel}>
      <AnimatedPressable
        onPress={() => setExpanded((e) => !e)}
        scaleTo={0.99}
        style={styles.navPanelHeader}
        disabled={!activeStop}
      >
        <Animated.View key={activeStopKey ?? 'complete'} entering={FadeIn.duration(300)} exiting={FadeOut.duration(150)} style={{ flex: 1 }}>
          <Text style={styles.navDestLabel}>
            {activeStop ? `STORE ${tripProgress.activeStopIndex + 1} OF ${trip.stops.length}` : 'TRIP COMPLETE'}
          </Text>
          <Text style={styles.navDestName}>{activeStop ? activeStop.location.name : 'Nice work — all stops done!'}</Text>
          {activeStop && activeStopProgress && (
            <Text style={styles.navDestMeta}>
              {activeStopProgress.checkedItems}/{activeStopProgress.totalItems} items here ·{' '}
              {tripProgress.checkedItems} of {tripProgress.totalItems} collected overall
            </Text>
          )}
        </Animated.View>
        {activeStop && (
          <Ionicons name={expanded ? 'chevron-down' : 'chevron-up'} size={18} color={`${colors.charcoal}66`} />
        )}
      </AnimatedPressable>

      <View style={styles.navStatsRow}>
        <NavStat icon="time-outline" value={formatDuration(tripProgress.remainingDurationMinutes)} label="Time left" />
        <NavStat icon="speedometer-outline" value={`${tripProgress.remainingDistanceMiles.toFixed(1)} mi`} label="Distance" />
        <NavStat icon="storefront-outline" value={String(tripProgress.remainingStores)} label="Stores left" />
        <NavStat icon="flag-outline" value={tripProgress.isTripComplete ? '—' : tripEtaLabel} label="ETA" />
      </View>

      {expanded && activeStop && (
        <ScrollView style={styles.navChecklist}>
          {activeStopItems.map((item) => (
            <ChecklistRow
              key={item.product.id}
              item={item}
              checked={!!checklist[item.product.id]}
              onToggle={() => onToggleItem(item.product.id)}
            />
          ))}
        </ScrollView>
      )}

      <AnimatedPressable onPress={onExit} scaleTo={0.98} style={styles.exitNavButton}>
        <Ionicons name="chevron-down-circle-outline" size={16} color={`${colors.charcoal}80`} />
        <Text style={styles.exitNavText}>Back to overview</Text>
        <Text style={styles.exitNavStores}>{trip.stops.length} stop{trip.stops.length !== 1 ? 's' : ''}</Text>
      </AnimatedPressable>
    </View>
  );
}

function NavStat({ icon, value, label }: { icon: keyof typeof Ionicons.glyphMap; value: string; label: string }) {
  return (
    <View style={styles.navStat}>
      <Ionicons name={icon} size={14} color={colors.green} />
      <Text style={styles.navStatValue}>{value}</Text>
      <Text style={styles.navStatLabel}>{label}</Text>
    </View>
  );
}

function TripProgressHeader({ progress }: { progress: TripProgress }) {
  const fill = useSharedValue(progress.percentComplete);
  useEffect(() => {
    fill.value = withTiming(progress.percentComplete, { duration: duration.slow, easing: easing.standard });
  }, [progress.percentComplete, fill]);
  const fillStyle = useAnimatedStyle(() => ({ width: `${fill.value}%` }));

  return (
    <View style={styles.progressHeader}>
      <View style={styles.progressTopRow}>
        <Text style={styles.progressTitle}>
          {progress.isTripComplete
            ? 'Trip complete — nice work!'
            : `${progress.checkedItems} / ${progress.totalItems} items collected`}
        </Text>
        <Text style={styles.progressPercent}>{progress.percentComplete}%</Text>
      </View>
      <View style={styles.progressBarTrack}>
        <Animated.View style={[styles.progressBarFill, fillStyle, progress.isTripComplete && styles.progressBarFillDone]} />
      </View>

      <View style={styles.summaryBox}>
        <SummaryStat icon="time-outline" value={formatDuration(progress.remainingDurationMinutes)} label="Time left" />
        <SummaryStat icon="speedometer-outline" value={`${progress.remainingDistanceMiles.toFixed(1)} mi`} label="Left to drive" />
        <SummaryStat
          icon="storefront-outline"
          value={String(progress.remainingStores)}
          label={progress.remainingStores === 1 ? 'Store left' : 'Stores left'}
        />
        <SummaryStat
          icon="basket-outline"
          value={String(progress.remainingItems)}
          label={progress.remainingItems === 1 ? 'Item left' : 'Items left'}
        />
      </View>
    </View>
  );
}

function SummaryStat({ icon, value, label }: { icon: keyof typeof Ionicons.glyphMap; value: string; label: string }) {
  return (
    <View style={styles.summaryStat}>
      <Ionicons name={icon} size={16} color={colors.green} />
      <Text style={styles.summaryValue}>{value}</Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  );
}

function StopCard({ index, stop, store, items, progress, isActive, isFirst, isLast, tripStartTime, checklist, onToggleItem }: {
  index: number;
  stop: TripPlan['stops'][number];
  store: StoreName;
  items: CartItem[];
  progress: StopProgress;
  isActive: boolean;
  isFirst: boolean;
  isLast: boolean;
  tripStartTime: number;
  checklist: Record<string, boolean>;
  onToggleItem: (productId: string) => void;
}) {
  const accent = storeAccents[store];
  const arrival = new Date(tripStartTime + stop.cumulativeEtaMinutes * 60000);
  const arrivalLabel = arrival.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  // Collapses automatically the moment a stop transitions to complete
  // (mark it complete, indicate it visually, move on) but stays a manual
  // toggle after that — a completed stop is collapsed by default, never
  // hidden entirely, per "remain accessible."
  const [collapsed, setCollapsed] = useState(progress.isComplete);
  const wasComplete = useRef(progress.isComplete);
  useEffect(() => {
    if (progress.isComplete && !wasComplete.current) setCollapsed(true);
    wasComplete.current = progress.isComplete;
  }, [progress.isComplete]);

  const stopFill = useSharedValue(progress.percentComplete);
  useEffect(() => {
    stopFill.value = withTiming(progress.percentComplete, { duration: duration.base, easing: easing.standard });
  }, [progress.percentComplete, stopFill]);
  const stopFillStyle = useAnimatedStyle(() => ({ width: `${stopFill.value}%` }));

  return (
    <View style={[styles.stopCard, isActive && styles.stopCardActive]}>
      <View style={styles.stopTimeline}>
        <View
          style={[
            styles.stopBadge,
            { backgroundColor: progress.isComplete ? '#9CA3AF' : accent.dot },
            isActive && styles.stopBadgeActive,
          ]}
        >
          {progress.isComplete
            ? <Ionicons name="checkmark" size={13} color={colors.white} />
            : <Text style={styles.stopBadgeText}>{index + 1}</Text>}
        </View>
        {!isLast && <View style={styles.stopConnector} />}
      </View>

      <View style={styles.stopBody}>
        <AnimatedPressable
          onPress={() => setCollapsed((c) => !c)}
          scaleTo={0.99}
          style={styles.stopHeaderTouchable}
        >
          <View style={styles.stopHeaderRow}>
            <View style={{ flex: 1 }}>
              {isActive && <Text style={styles.nextUpLabel}>CURRENT DESTINATION</Text>}
              {progress.isComplete && !isActive && <Text style={styles.completeLabel}>PICKED UP</Text>}
              <Text style={styles.stopStoreName}>{stop.location.name}</Text>
              <Text style={styles.stopAddress}>
                {stop.location.address}, {stop.location.city}, {stop.location.state} {stop.location.zip}
              </Text>
            </View>
            <Ionicons name={collapsed ? 'chevron-down' : 'chevron-up'} size={18} color={`${colors.charcoal}66`} />
          </View>

          <View style={styles.stopMetaRow}>
            <Text style={styles.stopMeta}>
              {formatDuration(stop.legDurationMinutes)} drive from {isFirst ? 'your location' : 'previous stop'}
            </Text>
            <Text style={styles.stopMeta}>· Arrive ~{arrivalLabel}</Text>
          </View>
          {stop.nextManeuver && <Text style={styles.stopManeuver}>{stop.nextManeuver}</Text>}

          {progress.totalItems > 0 && (
            <View style={styles.stopProgressRow}>
              <View style={styles.stopProgressTrack}>
                <Animated.View
                  style={[
                    styles.stopProgressFill,
                    stopFillStyle,
                    { backgroundColor: progress.isComplete ? '#9CA3AF' : accent.dot },
                  ]}
                />
              </View>
              <Text style={styles.stopProgressText}>{progress.checkedItems}/{progress.totalItems} collected</Text>
            </View>
          )}
        </AnimatedPressable>

        {!collapsed && (
          <View style={styles.pickupList}>
            {items.map((item) => (
              <ChecklistRow
                key={item.product.id}
                item={item}
                checked={!!checklist[item.product.id]}
                onToggle={() => onToggleItem(item.product.id)}
              />
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

function ChecklistRow({ item, checked, onToggle }: { item: CartItem; checked: boolean; onToggle: () => void }) {
  const progress = useSharedValue(checked ? 1 : 0);
  useEffect(() => {
    progress.value = withSpring(checked ? 1 : 0, spring);
  }, [checked, progress]);

  const boxStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], ['#FFFFFF', colors.green]),
    borderColor: interpolateColor(progress.value, [0, 1], [colors.borderGray, colors.green]),
    transform: [{ scale: 0.92 + progress.value * 0.08 }],
  }));
  const checkStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: progress.value }],
  }));

  return (
    <AnimatedPressable
      onPress={onToggle}
      style={styles.pickupRow}
      scaleTo={0.98}
      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
    >
      <Animated.View style={[styles.checklistBox, boxStyle]}>
        <Animated.View style={checkStyle}>
          <Ionicons name="checkmark" size={14} color={colors.white} />
        </Animated.View>
      </Animated.View>
      <Text style={[styles.pickupText, checked && styles.pickupTextChecked]}>
        {item.product.name}{item.quantity > 1 ? ` × ${item.quantity}` : ''}
      </Text>
    </AnimatedPressable>
  );
}

function formatDuration(minutes: number): string {
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.white },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  backButton: {
    width: 40, height: 40, borderRadius: radius.pill, backgroundColor: colors.panelBg,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { fontWeight: '700', fontSize: 16, color: colors.charcoal },
  centerState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: spacing.md },
  emptyText: { color: `${colors.charcoal}80`, fontSize: 13.5, textAlign: 'center' },
  loadingText: { color: `${colors.charcoal}80`, fontSize: 13.5, textAlign: 'center' },
  errorText: { color: colors.errorRed, fontSize: 13.5, textAlign: 'center' },
  scrollContent: { paddingBottom: spacing.xxl },
  // Taller than before — a route squeezed into a short strip is exactly
  // the "occupies only a tiny portion of the screen" complaint; this
  // gives the overview real presence without pushing the stop list too
  // far down.
  map: { height: 340, width: '100%' },

  startRouteRow: { paddingHorizontal: spacing.lg, marginTop: spacing.lg },
  startRouteButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
    backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: spacing.md + 2, minHeight: 48,
    ...elevation.medium,
  },
  startRouteText: { color: colors.white, fontWeight: '700', fontSize: 14.5 },

  // Navigation Mode — the map takes essentially the whole screen; the
  // panel below it is a normal flex sibling (not an absolute overlay), so
  // it never has to fight the WebView for touch events.
  navContainer: { flex: 1, backgroundColor: colors.white },
  navMap: { flex: 1, width: '100%' },
  // Absolute overlay pinned to the top of the map — compact, never
  // pushes the map down, matches the "unobtrusive" requirement directly.
  navBanner: {
    position: 'absolute', top: spacing.md, left: spacing.md, right: spacing.md,
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    backgroundColor: colors.charcoal, borderRadius: radius.lg,
    paddingVertical: spacing.sm + 2, paddingHorizontal: spacing.md,
    ...elevation.high,
  },
  navBannerIcon: {
    width: 30, height: 30, borderRadius: radius.pill, backgroundColor: colors.green,
    alignItems: 'center', justifyContent: 'center',
  },
  navBannerInstruction: { color: colors.white, fontWeight: '700', fontSize: 14 },
  navBannerMeta: { color: 'rgba(255,255,255,0.7)', fontSize: 11.5, marginTop: 1 },
  navPanel: {
    backgroundColor: colors.white, borderTopWidth: 1, borderTopColor: colors.borderGray,
    paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.lg,
    ...elevation.high,
  },
  navPanelHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  navDestLabel: { color: colors.green, fontWeight: '700', fontSize: 10.5, letterSpacing: 0.5 },
  navDestName: { color: colors.charcoal, fontWeight: '800', fontSize: 17, marginTop: 2 },
  navDestMeta: { color: `${colors.charcoal}80`, fontSize: 12, marginTop: spacing.xs },
  navStatsRow: {
    flexDirection: 'row', justifyContent: 'space-around', backgroundColor: colors.mint,
    marginTop: spacing.md, borderRadius: radius.lg, paddingVertical: spacing.sm + 2,
  },
  navStat: { alignItems: 'center', gap: 1 },
  navStatValue: { fontWeight: '700', fontSize: 13.5, color: colors.charcoal, marginTop: 1 },
  navStatLabel: { color: `${colors.charcoal}80`, fontSize: 9.5 },
  navChecklist: { maxHeight: 220, marginTop: spacing.md },
  exitNavButton: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.md,
    alignSelf: 'center', paddingVertical: spacing.xs,
  },
  exitNavText: { color: `${colors.charcoal}80`, fontWeight: '600', fontSize: 12.5 },
  exitNavStores: { color: `${colors.charcoal}4d`, fontSize: 11.5 },

  progressHeader: { marginHorizontal: spacing.lg, marginTop: spacing.lg },
  progressTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  progressTitle: { fontWeight: '700', fontSize: 14.5, color: colors.charcoal },
  progressPercent: { fontWeight: '800', fontSize: 14.5, color: colors.green },
  progressBarTrack: { height: 8, borderRadius: 4, backgroundColor: colors.borderGray, marginTop: spacing.sm, overflow: 'hidden' },
  progressBarFill: { height: '100%', borderRadius: 4, backgroundColor: colors.green },
  progressBarFillDone: { backgroundColor: '#16A34A' },

  summaryBox: {
    flexDirection: 'row', justifyContent: 'space-around', backgroundColor: colors.mint,
    marginTop: spacing.lg, borderRadius: radius.lg, paddingVertical: spacing.md + 2,
  },
  summaryStat: { alignItems: 'center', gap: 2 },
  summaryValue: { fontWeight: '700', fontSize: 15, color: colors.charcoal, marginTop: 2 },
  summaryLabel: { color: `${colors.charcoal}80`, fontSize: 10.5 },

  warningBox: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginHorizontal: spacing.lg, marginTop: spacing.lg,
    backgroundColor: '#FEF3C7', borderRadius: radius.md, padding: spacing.md,
  },
  warningText: { color: '#92400E', fontSize: 12 },
  warningItemText: { color: '#92400E', fontSize: 12, marginTop: spacing.xs, fontWeight: '600' },

  stopsHeader: { paddingHorizontal: spacing.lg, marginTop: spacing.xl, marginBottom: spacing.sm },
  sectionTitle: { fontWeight: '700', fontSize: 15, color: colors.charcoal },

  stopCard: {
    flexDirection: 'row', paddingHorizontal: spacing.lg, marginTop: spacing.md,
    paddingVertical: spacing.sm, borderRadius: radius.lg,
  },
  stopCardActive: { backgroundColor: colors.mint },
  stopTimeline: { alignItems: 'center', width: 32 },
  stopBadge: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  stopBadgeActive: { width: 30, height: 30, borderRadius: 15, ...elevation.low },
  stopBadgeText: { color: colors.white, fontWeight: '700', fontSize: 12 },
  stopConnector: { flex: 1, width: 2, backgroundColor: colors.borderGray, marginVertical: spacing.xs, minHeight: 24 },
  stopBody: { flex: 1, paddingBottom: spacing.sm, marginLeft: spacing.md },
  stopHeaderTouchable: { gap: spacing.xs },
  stopHeaderRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  nextUpLabel: { color: colors.green, fontWeight: '700', fontSize: 10.5, letterSpacing: 0.5, marginBottom: spacing.xs },
  completeLabel: { color: `${colors.charcoal}66`, fontWeight: '700', fontSize: 10.5, letterSpacing: 0.5, marginBottom: spacing.xs },
  stopStoreName: { fontWeight: '700', fontSize: 14.5, color: colors.charcoal },
  stopAddress: { color: `${colors.charcoal}99`, fontSize: 12.5, marginTop: spacing.xs },
  stopMetaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs + 2, marginTop: spacing.sm },
  stopMeta: { color: `${colors.charcoal}73`, fontSize: 11.5 },
  stopManeuver: { color: colors.green, fontSize: 11.5, marginTop: spacing.xs, fontStyle: 'italic' },
  stopProgressRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  stopProgressTrack: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.borderGray, overflow: 'hidden' },
  stopProgressFill: { height: '100%', borderRadius: 3 },
  stopProgressText: { color: `${colors.charcoal}80`, fontSize: 11, fontWeight: '600' },
  pickupList: { marginTop: spacing.md, gap: spacing.sm },
  pickupRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 32 },
  checklistBox: {
    width: 22, height: 22, borderRadius: radius.sm - 4, borderWidth: 1.5,
    alignItems: 'center', justifyContent: 'center',
  },
  pickupText: { color: colors.charcoal, fontSize: 12.5, flex: 1 },
  pickupTextChecked: { color: `${colors.charcoal}66`, textDecorationLine: 'line-through' },
});
