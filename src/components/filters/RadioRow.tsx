import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { spacing } from '../../theme/metrics';
import { AnimatedPressable } from '../AnimatedPressable';

interface Props {
  label: string;
  selected: boolean;
  onPress: () => void;
}

// Whether tapping a selected option clears it (Customer Rating) or is a
// no-op (Sort By, always exactly one selected) is decided by the caller's
// onPress handler — this component just reports taps.
export function RadioRow({ label, selected, onPress }: Props) {
  return (
    <AnimatedPressable onPress={onPress} style={styles.row} scaleTo={0.99}>
      <View style={[styles.dot, selected && styles.dotSelected]}>
        {selected && <View style={styles.dotInner} />}
      </View>
      <Text style={[typography.body, selected && styles.labelSelected]}>{label}</Text>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm + 2,
    minHeight: 44,
  },
  dot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: colors.borderGray,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotSelected: {
    borderColor: colors.green,
  },
  dotInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.green,
  },
  labelSelected: {
    color: colors.green,
    fontFamily: typography.bodyMedium.fontFamily,
  },
});
