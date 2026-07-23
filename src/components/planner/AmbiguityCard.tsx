import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ChipRow } from '../filters/ChipRow';
import type { AmbiguityPrompt } from '../../models/types';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { spacing, radius } from '../../theme/metrics';

const NO_PREFERENCE = '__no_preference__';

interface Props {
  prompt: AmbiguityPrompt;
  /** `null` = "No Preference" selected, a subtypeId = that option chosen. */
  selected: string | null;
  onChange: (subtypeId: string | null) => void;
}

/** One compact clarification card — a label plus a single row of chips
 * (every subtype option + "No Preference"). Mirrors shopsmart_web's
 * AmbiguityCard.tsx, reusing ChipRow's existing multi-select-shaped API in
 * single-select mode (picking one clears the others is this component's
 * onToggle logic, the same pattern Sort By already uses elsewhere). */
export function AmbiguityCard({ prompt, selected, onChange }: Props) {
  const chipValue = selected ?? NO_PREFERENCE;
  const options = [
    ...prompt.options.map(o => ({ value: o.subtypeId, label: o.label })),
    { value: NO_PREFERENCE, label: 'No Preference' },
  ];

  return (
    <View style={styles.card}>
      <Text style={styles.label}>{prompt.itemLabel}</Text>
      <ChipRow
        options={options}
        selected={new Set([chipValue])}
        onToggle={value => onChange(value === NO_PREFERENCE ? null : value)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.panelBg, borderRadius: radius.lg, padding: spacing.lg },
  label: { ...typography.cardTitle, fontSize: 14, marginBottom: spacing.md },
});
