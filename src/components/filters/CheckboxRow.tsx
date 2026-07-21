import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { radius, spacing } from '../../theme/metrics';
import { AnimatedPressable } from '../AnimatedPressable';

interface Props {
  label: string;
  selected: boolean;
  onPress: () => void;
  /** Optional colored dot before the label (used by the Stores section to
   * echo each store's accent color). */
  dotColor?: string;
}

export function CheckboxRow({ label, selected, onPress, dotColor }: Props) {
  return (
    <AnimatedPressable onPress={onPress} style={styles.row} scaleTo={0.99}>
      <View style={[styles.box, selected && styles.boxSelected]}>
        {selected && <Ionicons name="checkmark" size={13} color={colors.white} />}
      </View>
      {dotColor && <View style={[styles.dot, { backgroundColor: dotColor }]} />}
      <Text style={[typography.body, styles.label]}>{label}</Text>
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
  box: {
    width: 20,
    height: 20,
    borderRadius: radius.sm - 6,
    borderWidth: 1.5,
    borderColor: colors.borderGray,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxSelected: {
    backgroundColor: colors.green,
    borderColor: colors.green,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: {
    flex: 1,
  },
});
