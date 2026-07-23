import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { useUserStore } from '../store/userStore';
import { useOnboardingStore } from '../store/onboardingStore';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';
import { elevation, radius, spacing } from '../theme/metrics';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Onboarding'>;

/**
 * The app's entire first-launch onboarding "screen" — deliberately just
 * one. One sentence explaining what the app does, one primary action, one
 * small way out. Everything the old multi-slide feature carousel used to
 * explain up front (compare-across-stores, one cart, one route, tips) is
 * taught instead the first time it's actually relevant, via ContextualHint
 * banners on the real screens — see SearchScreen/CompareScreen/CartScreen/
 * RouteScreen. "Teach only what the user needs right now."
 *
 * Reached two ways:
 *  - First launch, signed out (via Splash) — Get Started leads into
 *    account creation; Skip leads into sign-in, for a returning shopper
 *    reinstalling on a new device.
 *  - "Restart Onboarding" in Profile, already signed in — there is
 *    nothing to sign up for again, so the single action just re-enters
 *    the app and lets the (freshly reset) contextual hints teach
 *    everything again from scratch.
 */
export function OnboardingScreen({ navigation }: Props) {
  const user = useUserStore((s) => s.user);
  const completeOnboarding = useOnboardingStore((s) => s.completeOnboarding);
  const isReplay = user != null;

  const fade = useSharedValue(0);
  const slide = useSharedValue(24);

  useEffect(() => {
    fade.value = withTiming(1, { duration: 550, easing: Easing.out(Easing.cubic) });
    slide.value = withDelay(100, withTiming(0, { duration: 550, easing: Easing.out(Easing.cubic) }));
  }, [fade, slide]);

  const contentStyle = useAnimatedStyle(() => ({
    opacity: fade.value,
    transform: [{ translateY: slide.value }],
  }));

  function enterApp() {
    navigation.reset({ index: 0, routes: [{ name: 'Tabs' }] });
  }

  async function handlePrimaryAction() {
    if (isReplay) {
      // Already signed in (restart-onboarding path) — nothing left to set
      // up, just re-enter the app with hints re-armed.
      await completeOnboarding();
      enterApp();
      return;
    }
    navigation.navigate('Auth', { initialMode: 'signUp', onSuccess: 'toDashboard' });
  }

  function handleSkip() {
    navigation.navigate('Auth', { initialMode: 'signIn', onSuccess: 'toDashboard' });
  }

  return (
    <View style={{ flex: 1 }}>
      <LinearGradient colors={[colors.mint, colors.white]} style={StyleSheet.absoluteFill} />
      <SafeAreaView style={styles.safeArea}>
        <Animated.View style={[styles.content, contentStyle]}>
          <View style={styles.top}>
            <View style={styles.iconCircle}>
              <Ionicons name="cart-outline" size={36} color={colors.green} />
            </View>
            <Text style={styles.logo}>
              Shop<Text style={{ color: colors.green }}>Smart</Text>
            </Text>
            <Text style={styles.headline}>
              {isReplay
                ? 'Welcome back.'
                : 'Shop smarter.\nFind better grocery prices across your favorite stores.'}
            </Text>
          </View>

          <View style={styles.actions}>
            <AnimatedPressable style={styles.primaryButton} onPress={handlePrimaryAction}>
              <Text style={styles.primaryButtonText}>{isReplay ? 'Continue' : 'Get Started'}</Text>
            </AnimatedPressable>
            {!isReplay && (
              <AnimatedPressable style={styles.skipButton} onPress={handleSkip} scaleTo={0.98}>
                <Text style={styles.skipText}>Skip</Text>
              </AnimatedPressable>
            )}
          </View>
        </Animated.View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  content: { flex: 1, justifyContent: 'space-between', paddingHorizontal: spacing.xl, paddingVertical: spacing.xl },
  top: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  iconCircle: {
    width: 88, height: 88, borderRadius: 44, backgroundColor: colors.mint,
    alignItems: 'center', justifyContent: 'center', marginBottom: spacing.xl,
    borderWidth: 1, borderColor: colors.mintDark,
  },
  logo: { ...typography.h2, fontSize: 20, color: colors.charcoal, marginBottom: spacing.lg },
  headline: { ...typography.display, fontSize: 28, lineHeight: 34, textAlign: 'center', maxWidth: 320 },
  actions: { gap: spacing.sm },
  primaryButton: {
    backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: 16,
    alignItems: 'center', ...elevation.medium,
  },
  primaryButtonText: { ...typography.button, color: colors.white, fontSize: 15.5 },
  skipButton: { paddingVertical: spacing.sm, alignItems: 'center' },
  skipText: { ...typography.bodyMedium, color: `${colors.charcoal}80` },
});
