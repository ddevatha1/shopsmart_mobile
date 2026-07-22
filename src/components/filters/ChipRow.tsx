import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { radius, spacing } from '../../theme/metrics';
import { AnimatedPressable } from '../AnimatedPressable';

export interface ChipOption {
  value: string;
  label: string;
}

interface Props {
  options: ChipOption[];
  /** Which values are currently selected — a Set so callers can share the
   * exact selection state a filter facet already keeps (see
   * ComparisonFilters.attributes) without converting back and forth. */
  selected: Set<string>;
  onToggle: (value: string) => void;
}

/**
 * A compact, wrapping row of toggle chips — the visual language the
 * redesigned Filter & Sort sheet uses for every facet (Sort By, Serving
 * Size, and every dynamically-generated attribute) instead of the old
 * panel's long checkbox/radio lists, per "use chips, segmented controls,
 * and expandable sections" and "avoid long scrolling sheets." Always
 * multi-select at this component's level — Sort By's single-select
 * behavior (picking one clears the others) is the caller's `onToggle`
 * logic, not a separate mode here, so this stays one simple primitive
 * rather than two near-identical ones.
 */
export function ChipRow({ options, selected, onToggle }: Props) {
  return (
    <View style={styles.row}>
      {options.map((option) => {
        const isSelected = selected.has(option.value);
        return (
          <AnimatedPressable
            key={option.value}
            onPress={() => onToggle(option.value)}
            style={[styles.chip, isSelected && styles.chipSelected]}
            scaleTo={0.96}
          >
            <Text style={[styles.chipLabel, isSelected && styles.chipLabelSelected]}>{option.label}</Text>
          </AnimatedPressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    borderWidth: 1,
    borderColor: colors.borderGray,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.white,
  },
  chipSelected: { backgroundColor: colors.green, borderColor: colors.green },
  chipLabel: { ...typography.bodyMedium, fontSize: 13, color: colors.charcoal },
  chipLabelSelected: { color: colors.white },
});
