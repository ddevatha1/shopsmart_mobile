import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { AnimatedPressable } from '../AnimatedPressable';
import { colors } from '../../theme/colors';
import { elevation, radius, spacing } from '../../theme/metrics';

/**
 * Homepage Redesign — "Ask CartIQ," a floating entry point into the
 * exact same Assistant screen every earlier phase built (same
 * `navigate('Assistant')`, same `runAssistant` pipeline underneath —
 * this component has no logic of its own, just a fixed-position button).
 * Replaces the old full-width CTA banner and the equal-weight
 * QuickActionsRow tile: the assistant stays reachable everywhere on
 * Home without competing with search for the first thing a shopper
 * sees, per this phase's own explicit instruction that it "should not
 * replace the primary grocery search experience."
 */
export function AskCartIQFAB({ onPress }: { onPress: () => void }) {
  // Global Layout Fix (Issue 5) — a fixed-position overlay is exactly the
  // kind of element a parent's SafeAreaView doesn't automatically protect
  // (it's absolutely positioned relative to the nearest positioned
  // ancestor, not flowed through the safe-area-inset padding a screen's
  // own container applies to its normal children). Made self-sufficient
  // here rather than trusting every future call site to remember to
  // leave room for it — harmless on Home today (the tab bar underneath
  // already reserves the home-indicator area), but this is what actually
  // prevents this button from ever crowding the home indicator if it's
  // ever rendered on a screen with no tab bar below it.
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.wrap, { bottom: spacing.xl + insets.bottom }]} pointerEvents="box-none">
      <AnimatedPressable onPress={onPress} style={styles.button} scaleTo={0.95}>
        <Ionicons name="sparkles" size={16} color={colors.white} />
        <Text style={styles.label}>Ask CartIQ</Text>
      </AnimatedPressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute', right: spacing.lg,
  },
  button: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.xs,
    backgroundColor: colors.green, borderRadius: radius.pill,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    ...elevation.high,
  },
  label: { color: colors.white, fontWeight: '700', fontSize: 13.5 },
});
