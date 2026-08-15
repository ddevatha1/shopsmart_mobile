import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { type StoreName } from '../models/types';
import { colors, storeAccents } from '../theme/colors';
import { spacing, radius } from '../theme/metrics';

/**
 * Shown alongside already-loaded results, never instead of them — the
 * whole point of progressive results is that a shopper already looking at
 * Kroger/Aldi/Sprouts's products should never be blocked by whichever
 * store hasn't finished yet (see searchStore.ts's poll loop, which is what
 * eventually clears this banner without the shopper doing anything).
 * Deliberately small/unobtrusive: a single line, no per-store cards, no
 * progress bar — "still working on it" is the entire message.
 */
export function StillSearchingBanner({ stores }: { stores: StoreName[] }) {
  if (stores.length === 0) return null;
  const label = stores.length === 1
    ? `${stores[0]} is still searching…`
    : `${stores.join(', ')} are still searching…`;

  return (
    <View style={styles.container}>
      <PulsingDot />
      <Text style={styles.text} numberOfLines={2}>{label}</Text>
    </View>
  );
}

function PulsingDot() {
  const opacity = useSharedValue(0.4);
  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 550, easing: Easing.inOut(Easing.quad) }),
        withTiming(0.4, { duration: 550, easing: Easing.inOut(Easing.quad) }),
      ),
      -1,
      false,
    );
  }, [opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={[styles.dot, style]} />;
}

/** One row per store, used inside a single-store "Search Within One Store"
 * view where a false "no results" empty state would otherwise show while
 * that specific store is genuinely still in flight (see SearchScreen.tsx). */
export function StoreStillSearchingState({ store }: { store: StoreName }) {
  const accent = storeAccents[store];
  return (
    <View style={styles.singleStoreState}>
      <View style={[styles.singleStoreIconBadge, { backgroundColor: accent.background }]}>
        <Ionicons name="search" size={22} color={accent.text} />
      </View>
      <Text style={styles.singleStoreTitle}>Still searching {store}…</Text>
      <Text style={styles.singleStoreSubtitle}>Results will appear here automatically.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.mint,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  dot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: colors.green },
  text: { color: colors.charcoal, fontSize: 12.5, fontWeight: '500', flex: 1 },
  singleStoreState: { alignItems: 'center', paddingVertical: 40, gap: spacing.sm },
  singleStoreIconBadge: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.xs },
  singleStoreTitle: { color: colors.charcoal, fontWeight: '600', fontSize: 14 },
  singleStoreSubtitle: { color: `${colors.charcoal}80`, fontSize: 13 },
});
