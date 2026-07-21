import React, { useState } from 'react';
import { StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';
import { AnimatedPressable } from './AnimatedPressable';
import { colors } from '../theme/colors';
import { spacing, radius } from '../theme/metrics';
import { duration, easing } from '../theme/motion';

interface Props {
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}

/**
 * The labeled "Add to Cart" action used on recommendation surfaces
 * (AdvisorCard, ProductDetailScreen's substitution box) — same
 * bounce-and-checkmark feedback as ProductCard's icon-only add button
 * (same durations/easing/colors), just with a text label since these
 * appear in a text-forward card rather than atop a product image.
 * `onPress` is expected to be idempotent-safe (cartStore.addToCart merges
 * by product id), so this never needs its own de-duplication logic.
 */
export function AddToCartButton({ onPress, style }: Props) {
  const [feedback, setFeedback] = useState(false);
  const confirmScale = useSharedValue(1);
  const confirmStyle = useAnimatedStyle(() => ({ transform: [{ scale: confirmScale.value }] }));

  const handlePress = () => {
    onPress();
    setFeedback(true);
    confirmScale.value = withSequence(
      withTiming(1.25, { duration: duration.micro, easing: easing.emphasized }),
      withTiming(1, { duration: duration.base, easing: easing.standard }),
    );
    setTimeout(() => setFeedback(false), 1500);
  };

  return (
    <AnimatedPressable
      onPress={handlePress}
      style={[styles.button, feedback && styles.buttonFeedback, style]}
      scaleTo={0.94}
    >
      <Animated.View style={[styles.row, confirmStyle]}>
        <Ionicons name={feedback ? 'checkmark' : 'add'} size={14} color={feedback ? colors.green : colors.white} />
        <Text style={[styles.label, feedback && styles.labelFeedback]}>{feedback ? 'Added' : 'Add to Cart'}</Text>
      </Animated.View>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: colors.green,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonFeedback: { backgroundColor: colors.mint },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  label: { color: colors.white, fontWeight: '700', fontSize: 12 },
  labelFeedback: { color: colors.green },
});
