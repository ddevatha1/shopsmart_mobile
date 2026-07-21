import { TextStyle } from 'react-native';
import { colors } from './colors';

/**
 * Global typography system.
 *
 * IMPORTANT — font substitution notice: "Amazon Ember" is Amazon's own
 * proprietary corporate typeface. It isn't distributed under a license that
 * allows bundling it into a third-party app, so it can't legitimately be
 * included here. `FONT_FAMILY` below points at Manrope (a free, similarly
 * clean/modern humanist sans-serif from Google Fonts, loaded via
 * @expo-google-fonts/manrope) as a visually-close, legally-safe substitute.
 *
 * If you obtain a legitimate license for the real Amazon Ember font files,
 * swap them in by: (1) dropping the .ttf files into assets/fonts/, (2)
 * loading them with `useFonts` in App.tsx the same way Manrope is loaded
 * (see App.tsx), and (3) changing the `weights` map below to your loaded
 * font keys. Nothing else in the app needs to change — every screen reads
 * fonts through this file.
 */
export const weights = {
  extraLight: 'Manrope_200ExtraLight',
  light: 'Manrope_300Light',
  regular: 'Manrope_400Regular',
  medium: 'Manrope_500Medium',
  semiBold: 'Manrope_600SemiBold',
  bold: 'Manrope_700Bold',
  extraBold: 'Manrope_800ExtraBold',
} as const;

// Font family names actually used by React Native `fontFamily` at runtime
// are the *keys* useFonts() registers assets under — expo-google-fonts
// registers them under these exact same string values, so `weights.bold`
// doubles as both "which weight" and "the fontFamily string to use."

export const typography = {
  // Large hero/display text (splash logo, welcome headline)
  display: { fontFamily: weights.extraBold, fontSize: 34, lineHeight: 40, color: colors.charcoal, letterSpacing: -0.5 } satisfies TextStyle,
  // Screen-level headings ("Compare grocery prices, instantly")
  h1: { fontFamily: weights.extraBold, fontSize: 26, lineHeight: 32, color: colors.charcoal, letterSpacing: -0.4 } satisfies TextStyle,
  // Section titles ("Account", "Recent Searches", "Picked For You")
  h2: { fontFamily: weights.bold, fontSize: 18, lineHeight: 24, color: colors.charcoal } satisfies TextStyle,
  h3: { fontFamily: weights.semiBold, fontSize: 15, lineHeight: 20, color: colors.charcoal } satisfies TextStyle,
  // Card titles (product name, cart item name)
  cardTitle: { fontFamily: weights.semiBold, fontSize: 13.5, lineHeight: 18, color: colors.charcoal } satisfies TextStyle,
  // Buttons
  button: { fontFamily: weights.semiBold, fontSize: 14.5, lineHeight: 18, letterSpacing: 0.1 } satisfies TextStyle,
  // Body copy
  body: { fontFamily: weights.regular, fontSize: 14, lineHeight: 20, color: colors.charcoal } satisfies TextStyle,
  bodyMedium: { fontFamily: weights.medium, fontSize: 14, lineHeight: 20, color: colors.charcoal } satisfies TextStyle,
  // Captions / muted metadata (brand labels, timestamps, helper text)
  caption: { fontFamily: weights.medium, fontSize: 11.5, lineHeight: 15, color: `${colors.charcoal}80` } satisfies TextStyle,
  overline: { fontFamily: weights.bold, fontSize: 10.5, lineHeight: 14, letterSpacing: 0.6, color: `${colors.charcoal}80` } satisfies TextStyle,
};
