import React from 'react';
import type { PressableProps, StyleProp, ViewStyle } from 'react-native';
import { Pressable } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { duration, spring } from '../theme/motion';

const AnimatedPressableBase = Animated.createAnimatedComponent(Pressable);

interface Props {
  onPress?: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
  /** How much to shrink on press — kept subtle by default. */
  scaleTo?: number;
  /** Also recede the shadow slightly on press — for elevated surfaces
   * (cards) where "pressed" should read as a gentle dip, not just a scale
   * change. Off by default: most usages (icon buttons, pills) carry no
   * shadow to animate in the first place. */
  liftOnPress?: boolean;
  /** Expands the tappable area beyond the visible bounds without changing
   * layout — the standard fix for compact icon buttons (steppers, close
   * buttons) that need to stay visually small but still meet mobile
   * touch-target guidelines. */
  hitSlop?: PressableProps['hitSlop'];
}

/**
 * Shared tap-feedback wrapper used across every button/card in the app so
 * presses feel consistent and alive (per "button press animations" /
 * "tasteful animations throughout"). A thin wrapper around Pressable, not
 * a new interaction model — onPress/disabled behave exactly as they would
 * on a plain Pressable.
 *
 * Press-in is a quick timing (instant-feeling compression); release is a
 * soft spring rather than a timing curve, so letting go feels physical
 * rather than mechanical — the one deliberate asymmetry in the motion
 * system, shared by every button/card in the app via this component.
 */
export function AnimatedPressable({ onPress, disabled, style, children, scaleTo = 0.96, liftOnPress = false, hitSlop }: Props) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => {
    if (!liftOnPress) return { transform: [{ scale: scale.value }] };
    // Derived straight from the same scale value driving the press
    // animation (0 at the pressed extreme, 1 at rest) rather than a
    // second shared value — one source of truth for "how pressed is this."
    // Resting values (t=1) match theme/metrics.ts's elevation.low exactly,
    // so a liftOnPress card looks identical to a non-animated one at rest.
    const t = (scale.value - scaleTo) / (1 - scaleTo);
    return {
      transform: [{ scale: scale.value }],
      shadowOpacity: 0.02 + 0.03 * t,
      elevation: 1 + t,
    };
  });

  return (
    <AnimatedPressableBase
      onPress={onPress}
      disabled={disabled}
      hitSlop={hitSlop}
      onPressIn={() => { scale.value = withTiming(scaleTo, { duration: duration.micro }); }}
      onPressOut={() => { scale.value = withSpring(1, spring); }}
      style={[style, animatedStyle, disabled ? { opacity: 0.5 } : null]}
    >
      {children}
    </AnimatedPressableBase>
  );
}
