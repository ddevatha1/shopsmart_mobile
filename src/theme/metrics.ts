import { Platform, ViewStyle } from 'react-native';

/** Consistent spacing scale used across every screen. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  xxxl: 40,
};

/** Consistent corner-radius scale. */
export const radius = {
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24,
  pill: 999,
};

/** Subtle elevation presets — cross-platform (elevation on Android, shadow* on iOS). */
function shadow(elevation: number, opacity: number, shadowRadius: number, offsetY: number): ViewStyle {
  return Platform.select<ViewStyle>({
    android: { elevation },
    default: {
      shadowColor: '#0B1A0C',
      shadowOpacity: opacity,
      shadowRadius,
      shadowOffset: { width: 0, height: offsetY },
    },
  })!;
}

export const elevation = {
  none: {},
  low: shadow(2, 0.05, 4, 1),
  medium: shadow(4, 0.08, 10, 3),
  high: shadow(8, 0.12, 20, 8),
};
