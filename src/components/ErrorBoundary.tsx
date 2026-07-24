import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AnimatedPressable } from './AnimatedPressable';
import { colors } from '../theme/colors';
import { spacing, radius } from '../theme/metrics';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * The app's single top-level React error boundary — without this, a
 * render-time exception anywhere in the tree (a malformed retailer
 * response that slips past every other guard, a bug in a new screen)
 * crashes the whole app to a blank white screen with no way back short of
 * force-quitting. This catches it, shows a real recovery screen, and lets
 * the shopper retry instead. It only catches render/lifecycle errors, not
 * errors inside async callbacks/promises — those are and should stay
 * handled locally (see apiClient.ts's ApiError, every screen's own
 * try/catch), since a network failure two screens ago shouldn't blank out
 * the one the shopper is actually looking at now.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] Caught a render error:', error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <View style={styles.container}>
          <Ionicons name="alert-circle-outline" size={48} color={colors.errorRed} />
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.detail}>
            ShopSmart ran into an unexpected error. Your cart and account are safe — try again.
          </Text>
          <AnimatedPressable onPress={this.reset} style={styles.button} scaleTo={0.97}>
            <Text style={styles.buttonText}>Try Again</Text>
          </AnimatedPressable>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.md,
    backgroundColor: colors.white,
  },
  title: { fontWeight: '700', fontSize: 18, color: colors.charcoal },
  detail: { color: `${colors.charcoal}99`, fontSize: 13.5, textAlign: 'center', lineHeight: 19 },
  button: {
    marginTop: spacing.md,
    backgroundColor: colors.green,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    minHeight: 48,
    justifyContent: 'center',
  },
  buttonText: { color: colors.white, fontWeight: '700', fontSize: 14.5 },
});
