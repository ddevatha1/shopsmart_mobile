import React from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { colors } from '../theme/colors';

/**
 * Global Layout Fix (Issue 5) — the one place every screen's safe-area
 * edges get decided, instead of each screen guessing (or forgetting)
 * which edges it needs. Root cause this fixes: the app had 14+ screens
 * independently calling `SafeAreaView` with `edges={['top']}` copy-pasted
 * from one another — correct for the three screens actually nested
 * inside the bottom tab navigator (its own tab bar already reserves the
 * bottom safe area/home-indicator space), but silently WRONG for every
 * full-screen stack push, which has no tab bar underneath it and so had
 * nothing at all accounting for the home indicator/gesture-nav area —
 * content (most visibly the Assistant's chat input) sat flush against
 * the physical bottom edge. Two screens (AuthScreen, ProductDetailScreen)
 * had no safe-area handling whatsoever, one of them approximating the
 * status bar with a hardcoded `paddingTop: 60` instead.
 *
 * `variant`:
 *  - `'tab'` — a screen mounted directly under the bottom tab navigator
 *    (Home, Cart, Profile). The tab bar already insets its own bottom
 *    edge; adding it here too would double the gap.
 *  - `'stack'` (default) — anything pushed on top of the tab bar (which
 *    is most of this app's screens) or presented as a full-screen modal.
 *    Nothing else reserves bottom space for these, so they need it here.
 */
export type ScreenVariant = 'tab' | 'stack';

const EDGES_BY_VARIANT: Record<ScreenVariant, Edge[]> = {
  tab: ['top'],
  stack: ['top', 'bottom'],
};

interface Props {
  variant?: ScreenVariant;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}

export function ScreenContainer({ variant = 'stack', style, children }: Props) {
  return (
    <SafeAreaView style={[styles.container, style]} edges={EDGES_BY_VARIANT[variant]}>
      {children}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.white },
});
