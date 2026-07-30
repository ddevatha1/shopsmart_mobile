import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { STORE_NAMES, UNAVAILABLE_STORES, type StoreName } from '../../models/types';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { radius, spacing } from '../../theme/metrics';
import { AnimatedPressable } from '../AnimatedPressable';
import { StoreLogo } from '../StoreLogo';

interface Props {
  visible: boolean;
  onClose: () => void;
  onSelect: (store: StoreName) => void;
  /** Optional (Phase 6 Part 2) — lets a second real caller
   * (OnboardingScreen's optional preferred-store picker) reuse this exact
   * sheet with its own real copy, instead of a second store-list
   * component. Defaults to the original "Search Within One Store" copy —
   * the existing call site (SearchScreen) is unaffected. */
  title?: string;
  subtitle?: string;
}

/**
 * The store picker for "Search Within One Store" — a plain list of every
 * supported retailer (see STORE_NAMES; expandable later without touching
 * this component, since it just maps over the constant). Same
 * bottom-sheet shell as the other quick-pick sheets in this app
 * (ComparisonFilterModal, the old NotSatisfiedSheet) for a consistent feel.
 */
export function StorePickerSheet({
  visible, onClose, onSelect,
  title = 'Search Within One Store',
  subtitle = "Browse one retailer's inventory directly — no cross-store comparison.",
}: Props) {
  // Global Layout Fix (Issue 5) — a Modal's content isn't automatically
  // inset by anything; a bottom sheet's own fixed `paddingBottom` needs
  // the real home-indicator inset added on top of it, or the last row
  // sits right at (sometimes under) the gesture-nav area.
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={[StyleSheet.absoluteFill, styles.backdrop]} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: spacing.xl + insets.bottom }]}>
          <View style={styles.grabberRow}>
            <View style={styles.grabber} />
          </View>
          <View style={styles.header}>
            <Text style={typography.h2}>{title}</Text>
            <AnimatedPressable onPress={onClose} style={styles.closeButton} scaleTo={0.9} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={20} color={colors.charcoal} />
            </AnimatedPressable>
          </View>
          <Text style={styles.subtitle}>{subtitle}</Text>

          <View style={styles.list}>
            {STORE_NAMES.map((store) => {
              const unavailable = UNAVAILABLE_STORES.has(store);
              return (
                <AnimatedPressable
                  key={store}
                  onPress={() => { if (!unavailable) onSelect(store); }}
                  style={[styles.row, unavailable && styles.rowDisabled]}
                  scaleTo={unavailable ? 1 : 0.98}
                  disabled={unavailable}
                >
                  <StoreLogo store={store} height={36} width={64} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowLabel}>{store}</Text>
                    {unavailable && <Text style={styles.unavailableLabel}>Temporarily unavailable</Text>}
                  </View>
                  {!unavailable && <Ionicons name="chevron-forward" size={18} color={`${colors.charcoal}66`} />}
                </AnimatedPressable>
              );
            })}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { backgroundColor: 'rgba(0,0,0,0.35)' },
  // paddingBottom is set dynamically at the call site (spacing.xl +
  // insets.bottom) — see this component's own comment above.
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
  },
  grabberRow: { alignItems: 'center', paddingTop: spacing.sm },
  grabber: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.borderGray },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  closeButton: { padding: spacing.xs },
  subtitle: { ...typography.caption, paddingHorizontal: spacing.lg, marginTop: spacing.xs, marginBottom: spacing.md },
  list: { paddingHorizontal: spacing.lg, gap: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.panelBg,
  },
  rowLabel: { ...typography.bodyMedium, fontSize: 14.5 },
  rowDisabled: { opacity: 0.75 },
  unavailableLabel: { ...typography.caption, color: `${colors.charcoal}99`, marginTop: 2 },
});
