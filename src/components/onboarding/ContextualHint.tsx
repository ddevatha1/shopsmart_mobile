import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { AnimatedPressable } from '../AnimatedPressable';
import { useOnboardingStore } from '../../store/onboardingStore';
import type { HintKey } from '../../repositories/onboardingRepository';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { radius, spacing } from '../../theme/metrics';
import { duration, easing } from '../../theme/motion';

interface Props {
  /** Which persisted "have I shown this before" slot this hint occupies —
   * see onboardingRepository's HintKey. Once dismissed, this exact hint
   * never renders again on this device. */
  hintKey: HintKey;
  message: string;
  /** Optional short title above the message — most hints are a single
   * short sentence and don't need one. */
  title?: string;
  icon?: keyof typeof Ionicons.glyphMap;
}

/**
 * The app's one reusable "teach this concept, once, right when it's
 * relevant" building block — see onboarding system: post-onboarding
 * guidance should never repeat once a shopper has seen it. Callers just
 * render this inline wherever the concept first becomes relevant (e.g.
 * CartScreen renders `<ContextualHint hintKey="cart" .../>` once the cart
 * has its first item) — this component owns all of the "has this been
 * seen/dismissed before" bookkeeping itself, so callers never juggle that
 * state.
 *
 * Deliberately not a floating tooltip anchored to a specific element (that
 * would need per-screen positioning math for little benefit here) — a
 * plain inline dismissible banner reads just as clearly and is far simpler
 * to drop into any screen's layout.
 */
export function ContextualHint({ hintKey, message, title, icon = 'bulb-outline' }: Props) {
  const isSeen = useOnboardingStore((s) => s.isHintSeen(hintKey));
  const markHintSeen = useOnboardingStore((s) => s.markHintSeen);
  const hydrated = useOnboardingStore((s) => s.hydrated);

  const entrance = useSharedValue(0);
  useEffect(() => {
    if (hydrated && !isSeen) {
      entrance.value = withTiming(1, { duration: duration.base, easing: easing.standard });
    }
    // Only ever runs the entrance once per mount — this component unmounts
    // itself for good once dismissed (see the early return below), so there
    // is no "re-play the entrance" case to guard against.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  const style = useAnimatedStyle(() => ({
    opacity: entrance.value,
    transform: [{ translateY: (1 - entrance.value) * -6 }],
  }));

  // Wait for hydration before deciding — otherwise a hint that was already
  // seen on a previous launch would flash visible for one frame while
  // AsyncStorage is still being read.
  if (!hydrated || isSeen) return null;

  return (
    <Animated.View style={[styles.container, style]}>
      <View style={styles.iconCircle}>
        <Ionicons name={icon} size={14} color={colors.green} />
      </View>
      <View style={styles.textCol}>
        {!!title && <Text style={styles.title}>{title}</Text>}
        <Text style={styles.message}>{message}</Text>
      </View>
      <AnimatedPressable
        onPress={() => markHintSeen(hintKey)}
        scaleTo={0.85}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        accessibilityLabel="Dismiss tip"
      >
        <Ionicons name="close" size={16} color={`${colors.charcoal}66`} />
      </AnimatedPressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.mint,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  iconCircle: {
    width: 24, height: 24, borderRadius: 12, backgroundColor: colors.white,
    alignItems: 'center', justifyContent: 'center', marginTop: 1,
  },
  textCol: { flex: 1 },
  title: { ...typography.bodyMedium, fontSize: 13, color: colors.green, marginBottom: 2 },
  message: { ...typography.body, fontSize: 12.5, color: `${colors.charcoal}b3`, lineHeight: 17 },
});
