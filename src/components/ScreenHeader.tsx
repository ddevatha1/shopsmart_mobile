import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AnimatedPressable } from './AnimatedPressable';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';
import { spacing } from '../theme/metrics';

/**
 * Global Layout Fix (Issue 5) — the one header every full-screen push
 * uses, replacing ~10 near-identical copy-pasted implementations (back
 * button + centered/left title + a spacer `View` to balance it) that had
 * each independently landed on a slightly different title style/back-
 * button size. Consolidating means a future spacing fix only has to
 * happen once, here — not once per screen, the exact failure mode that
 * produced Issue 5's inconsistent header spacing in the first place.
 *
 * The back button is 44×44 (Apple HIG's minimum comfortable touch
 * target — several screens had shrunk this to 40×40), always with an
 * `accessibilityLabel` since it's icon-only. `title` gets `numberOfLines`
 * so a long product/category name truncates instead of wrapping the
 * header onto a second line or pushing the back button off-balance.
 */
interface Props {
  title: string;
  /** A short line above `title` — e.g. SearchResultsScreen's "Results
   * for" above the actual query. Omitted by every header that doesn't
   * need one. */
  eyebrow?: string;
  /** Omit entirely for a header with no back action (rare — every real
   * screen using this component today provides one). */
  onBack?: () => void;
  /** An optional right-side slot (e.g. a second action) — when omitted,
   * an equal-width spacer keeps the title visually centered against the
   * back button, same as every screen already did by hand. */
  right?: React.ReactNode;
}

const SIDE_SLOT_WIDTH = 44;

export function ScreenHeader({ title, eyebrow, onBack, right }: Props) {
  return (
    <View style={styles.header}>
      {onBack ? (
        <AnimatedPressable
          onPress={onBack}
          style={styles.backButton}
          scaleTo={0.9}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityLabel="Back"
        >
          <Ionicons name="chevron-back" size={22} color={colors.charcoal} />
        </AnimatedPressable>
      ) : (
        <View style={styles.sideSlot} />
      )}

      <View style={styles.titleCol}>
        {eyebrow && <Text style={styles.eyebrow}>{eyebrow}</Text>}
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
      </View>

      {right ?? <View style={styles.sideSlot} />}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
  },
  backButton: {
    width: SIDE_SLOT_WIDTH, height: SIDE_SLOT_WIDTH, alignItems: 'center', justifyContent: 'center',
  },
  sideSlot: { width: SIDE_SLOT_WIDTH },
  titleCol: { flex: 1 },
  eyebrow: { ...typography.caption },
  title: { ...typography.h3 },
});
