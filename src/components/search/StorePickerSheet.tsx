import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { STORE_NAMES, UNAVAILABLE_STORES, type StoreName } from '../../models/types';
import { colors, storeAccents } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { radius, spacing } from '../../theme/metrics';
import { AnimatedPressable } from '../AnimatedPressable';

interface Props {
  visible: boolean;
  onClose: () => void;
  onSelect: (store: StoreName) => void;
}

/**
 * The store picker for "Search Within One Store" — a plain list of the
 * four supported retailers (see STORE_NAMES; expandable later without
 * touching this component, since it just maps over the constant). Same
 * bottom-sheet shell as the other quick-pick sheets in this app
 * (ComparisonFilterModal, the old NotSatisfiedSheet) for a consistent feel.
 */
export function StorePickerSheet({ visible, onClose, onSelect }: Props) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={[StyleSheet.absoluteFill, styles.backdrop]} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.grabberRow}>
            <View style={styles.grabber} />
          </View>
          <View style={styles.header}>
            <Text style={typography.h2}>Search Within One Store</Text>
            <AnimatedPressable onPress={onClose} style={styles.closeButton} scaleTo={0.9} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={20} color={colors.charcoal} />
            </AnimatedPressable>
          </View>
          <Text style={styles.subtitle}>Browse one retailer&apos;s inventory directly — no cross-store comparison.</Text>

          <View style={styles.list}>
            {STORE_NAMES.map((store) => {
              const accent = storeAccents[store];
              const unavailable = UNAVAILABLE_STORES.has(store);
              return (
                <AnimatedPressable
                  key={store}
                  onPress={() => { if (!unavailable) onSelect(store); }}
                  style={[styles.row, unavailable && styles.rowDisabled]}
                  scaleTo={unavailable ? 1 : 0.98}
                  disabled={unavailable}
                >
                  <View style={[styles.logo, { backgroundColor: accent.background }]}>
                    <Text style={[styles.logoText, { color: accent.text }]}>{store.slice(0, 2).toUpperCase()}</Text>
                  </View>
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
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingBottom: spacing.xl,
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
  logo: { width: 36, height: 36, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  logoText: { fontSize: 12, fontWeight: '800' },
  rowLabel: { ...typography.bodyMedium, fontSize: 14.5 },
  rowDisabled: { opacity: 0.75 },
  unavailableLabel: { ...typography.caption, color: `${colors.charcoal}99`, marginTop: 2 },
});
