import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { StoreName } from '../../models/types';
import { colors, storeAccents } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { radius, spacing } from '../../theme/metrics';
import { AnimatedPressable } from '../AnimatedPressable';

interface Props {
  selectedStore: StoreName | null;
  onOpenPicker: () => void;
  onClear: () => void;
}

/**
 * The lightweight entry point for "Search Within One Store," and — once a
 * store is chosen — the equally lightweight way back to comparison mode.
 * Deliberately just a text link (opt-in) or a small pill (once active),
 * never a prominent button: the default, comparison-first workflow should
 * never feel like it's competing with this optional mode for attention.
 */
export function StoreModeBar({ selectedStore, onOpenPicker, onClear }: Props) {
  if (selectedStore == null) {
    return (
      <AnimatedPressable onPress={onOpenPicker} scaleTo={0.98} style={styles.entryWrap} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
        <Text style={styles.entryText}>Search within one store</Text>
      </AnimatedPressable>
    );
  }

  const accent = storeAccents[selectedStore];
  return (
    <View style={styles.activeRow}>
      <View style={[styles.activePill, { backgroundColor: accent.background }]}>
        <View style={[styles.dot, { backgroundColor: accent.dot }]} />
        <Text style={[styles.activeText, { color: accent.text }]}>Shopping at {selectedStore}</Text>
      </View>
      <AnimatedPressable onPress={onClear} scaleTo={0.96} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
        <Text style={styles.compareLink}>Compare Across Stores</Text>
      </AnimatedPressable>
    </View>
  );
}

const styles = StyleSheet.create({
  entryWrap: { alignSelf: 'flex-start', marginTop: spacing.sm },
  entryText: { ...typography.caption, color: colors.green, textDecorationLine: 'underline' },
  activeRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.sm },
  activePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
  },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  activeText: { fontSize: 12, fontWeight: '700' },
  compareLink: { ...typography.caption, color: colors.green, textDecorationLine: 'underline' },
});
