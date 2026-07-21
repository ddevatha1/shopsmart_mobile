import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { elevation, radius, spacing } from '../../theme/metrics';
import { AnimatedPressable } from '../AnimatedPressable';

interface Props {
  activeFilterCount: number;
  onClear: () => void;
  onApply: () => void;
}

export function FilterFooter({ activeFilterCount, onClear, onApply }: Props) {
  return (
    <View style={styles.footer}>
      <AnimatedPressable onPress={onClear} style={styles.clearButton}>
        <Text style={[typography.button, styles.clearLabel]}>Clear Filters</Text>
      </AnimatedPressable>
      <AnimatedPressable onPress={onApply} style={styles.applyButton}>
        <Text style={[typography.button, styles.applyLabel]}>
          Apply Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
        </Text>
      </AnimatedPressable>
    </View>
  );
}

const styles = StyleSheet.create({
  footer: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.borderGray,
    backgroundColor: colors.white,
    ...elevation.medium,
  },
  clearButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.borderGray,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  clearLabel: { color: colors.charcoal },
  applyButton: {
    flex: 2,
    backgroundColor: colors.green,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  applyLabel: { color: colors.white },
});
