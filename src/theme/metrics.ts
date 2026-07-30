import { Platform, ViewStyle } from 'react-native';
import { colors } from './colors';

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

/**
 * Surface tiers (Phase 7.1 follow-up) — the ONE shared definition of
 * "how a grouped block of content is contained," so the exact drift
 * this pass fixed by hand (15 components independently inventing the
 * identical `white + borderWidth:1 + borderColor:borderGray` recipe,
 * several doubling it with a shadow or a colored border on top) can't
 * quietly recur one component at a time. Pick exactly one tier per
 * surface — never add a border/shadow of your own on top of one of
 * these.
 *
 * - `flat` — secondary/status info (preferences, history, suggestions).
 *   No border, no shadow; groups by tint alone.
 * - `tinted` — an "explained"/highlighted secondary section (why-chosen
 *   blocks) — same idea as `flat`, mint instead of neutral.
 * - `card` — the ONE primary/hero result on a screen (a real plan, a
 *   real meal plan). Real shadow, no border — the one focal point.
 * - `bordered` — dense grids only (ProductCard, PlanStoreSection),
 *   where several adjacent shadows would read as visual noise and a
 *   hairline border cleanly separates neighbors instead.
 */
export const surfaces = {
  flat: { backgroundColor: colors.panelBg, borderRadius: radius.lg } satisfies ViewStyle,
  tinted: { backgroundColor: colors.mint, borderRadius: radius.lg } satisfies ViewStyle,
  card: { backgroundColor: colors.white, borderRadius: radius.lg, ...elevation.medium } satisfies ViewStyle,
  bordered: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.borderGray, borderRadius: radius.lg } satisfies ViewStyle,
};
