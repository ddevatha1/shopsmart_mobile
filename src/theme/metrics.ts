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

/** The app's layout is designed for phone-width viewports only (no
 * screen anywhere branches on `Platform.OS === 'web'` or checks window
 * width). On a wide browser window this app.json-listed web target
 * would otherwise stretch every screen full-bleed — most visibly a
 * product photo whose box sizes off an aspectRatio, ballooning to
 * several screen-heights tall. Centering every screen's content in a
 * capped column keeps native (already narrower than this) unaffected
 * while giving web/tablet a sane, non-stretched layout. */
export const webContentMaxWidth = 520;

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
