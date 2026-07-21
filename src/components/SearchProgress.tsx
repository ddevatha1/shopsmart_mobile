import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';
import { spacing } from '../theme/metrics';
import { duration } from '../theme/motion';

// Deliberately store-agnostic — no store names, no per-store status. A
// single unified experience that won't get more cluttered as stores are
// added, unlike the old one-card-per-store ScannerTray.
const MESSAGES = [
  'Searching nearby grocery stores…',
  'Comparing prices…',
  'Looking for fresh options…',
  "Gathering today's products…",
  'Organizing your results…',
  'Checking available items…',
  'Finding the best matches…',
];

const MESSAGE_INTERVAL_MS = 2400;
const FADE_DURATION_MS = duration.base;

/** Replaces ScannerTray. A single centered, tasteful "searching" state:
 * a gently pulsing icon badge, a staggered three-dot loop, and a rotating
 * status message that crossfades — no fake progress bar, no per-store
 * detail the user doesn't need. Purely presentational; owns no search
 * state itself, so it's trivial to swap out or reuse elsewhere. */
export function SearchProgress() {
  const [messageIndex, setMessageIndex] = useState(0);
  const messageOpacity = useSharedValue(1);

  useEffect(() => {
    function advanceMessage() {
      setMessageIndex((i) => (i + 1) % MESSAGES.length);
      messageOpacity.value = withTiming(1, { duration: FADE_DURATION_MS, easing: Easing.out(Easing.quad) });
    }

    const id = setInterval(() => {
      messageOpacity.value = withTiming(
        0,
        { duration: FADE_DURATION_MS, easing: Easing.in(Easing.quad) },
        (finished) => {
          if (finished) runOnJS(advanceMessage)();
        },
      );
    }, MESSAGE_INTERVAL_MS);

    return () => clearInterval(id);
  }, [messageOpacity]);

  const messageStyle = useAnimatedStyle(() => ({ opacity: messageOpacity.value }));

  return (
    <View style={styles.container}>
      <PulsingIconBadge />
      <Animated.Text style={[typography.bodyMedium, styles.message, messageStyle]}>
        {MESSAGES[messageIndex]}
      </Animated.Text>
      <DotRow />
    </View>
  );
}

function PulsingIconBadge() {
  const scale = useSharedValue(1);
  const opacity = useSharedValue(0.85);

  useEffect(() => {
    scale.value = withRepeat(
      withSequence(
        withTiming(1.08, { duration: 900, easing: Easing.inOut(Easing.sin) }),
        withTiming(1, { duration: 900, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      false,
    );
    opacity.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 900, easing: Easing.inOut(Easing.sin) }),
        withTiming(0.85, { duration: 900, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      false,
    );
  }, [scale, opacity]);

  const style = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  return (
    <Animated.View style={[styles.iconBadge, style]}>
      <Ionicons name="search" size={26} color={colors.green} />
    </Animated.View>
  );
}

function DotRow() {
  return (
    <View style={styles.dotRow}>
      <Dot delay={0} />
      <Dot delay={160} />
      <Dot delay={320} />
    </View>
  );
}

function Dot({ delay }: { delay: number }) {
  const opacity = useSharedValue(0.3);

  useEffect(() => {
    opacity.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 450, easing: Easing.inOut(Easing.quad) }),
          withTiming(0.3, { duration: 450, easing: Easing.inOut(Easing.quad) }),
        ),
        -1,
        false,
      ),
    );
  }, [opacity, delay]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={[styles.dot, style]} />;
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', paddingVertical: 48, gap: spacing.md },
  iconBadge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.mint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  message: { color: colors.charcoal, textAlign: 'center', paddingHorizontal: spacing.xl },
  dotRow: { flexDirection: 'row', gap: 8, marginTop: spacing.xs },
  dot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: colors.green },
});
