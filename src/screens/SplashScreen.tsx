import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useUserStore } from '../store/userStore';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Splash'>;

const MIN_DURATION_MS = 2200;

/**
 * The app's first screen on every launch. Purely presentational — routes
 * to Onboarding (signed out) or Tabs (signed in) once both (a) the
 * entrance animation has had its minimum on-screen time and (b) the auth
 * state has finished hydrating from storage (see userStore.hydrate(),
 * kicked off in App.tsx). Never requires user interaction to dismiss, per
 * the spec.
 */
export function SplashScreen({ navigation }: Props) {
  const logoOpacity = useSharedValue(0);
  const logoScale = useSharedValue(0.85);
  const floatA = useSharedValue(0);
  const floatB = useSharedValue(0);
  const floatC = useSharedValue(0);
  const screenOpacity = useSharedValue(1);

  useEffect(() => {
    // Logo: gentle fade + scale-up entrance.
    logoOpacity.value = withTiming(1, { duration: 650, easing: Easing.out(Easing.cubic) });
    logoScale.value = withTiming(1, { duration: 750, easing: Easing.out(Easing.back(1.2)) });

    // Floating background elements — slow, continuous, staggered loops.
    floatA.value = withRepeat(withSequence(
      withTiming(1, { duration: 2600, easing: Easing.inOut(Easing.sin) }),
      withTiming(0, { duration: 2600, easing: Easing.inOut(Easing.sin) }),
    ), -1, false);
    floatB.value = withDelay(400, withRepeat(withSequence(
      withTiming(1, { duration: 3200, easing: Easing.inOut(Easing.sin) }),
      withTiming(0, { duration: 3200, easing: Easing.inOut(Easing.sin) }),
    ), -1, false));
    floatC.value = withDelay(800, withRepeat(withSequence(
      withTiming(1, { duration: 2900, easing: Easing.inOut(Easing.sin) }),
      withTiming(0, { duration: 2900, easing: Easing.inOut(Easing.sin) }),
    ), -1, false));

    // The float loops repeat forever (-1) and must be stopped explicitly
    // before this screen unmounts (navigation.reset below), or the UI
    // thread keeps flushing worklet frames for a torn-down component and
    // crashes the app on the next display-link tick.
    return () => {
      cancelAnimation(floatA);
      cancelAnimation(floatB);
      cancelAnimation(floatC);
    };
  }, [floatA, floatB, floatC, logoOpacity, logoScale]);

  useEffect(() => {
    let cancelled = false;
    const start = Date.now();

    async function proceedWhenReady() {
      // Poll for hydration in small steps rather than a fixed timer, so
      // slow storage reads never cut the animation off mid-flight, but
      // typical fast reads don't extend it past the minimum either.
      while (!useUserStore.getState().hydrated) {
        await new Promise((r) => setTimeout(r, 50));
        if (cancelled) return;
      }
      const elapsed = Date.now() - start;
      const remaining = Math.max(0, MIN_DURATION_MS - elapsed);
      await new Promise((r) => setTimeout(r, remaining));
      if (cancelled) return;

      function goToNextRoute() {
        const nextRoute = useUserStore.getState().user ? 'Tabs' : 'Onboarding';
        navigation.reset({ index: 0, routes: [{ name: nextRoute }] });
      }

      screenOpacity.value = withTiming(0, { duration: 280, easing: Easing.in(Easing.cubic) }, (finished) => {
        if (finished) {
          runOnJS(goToNextRoute)();
        }
      });
    }

    proceedWhenReady();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const screenStyle = useAnimatedStyle(() => ({ opacity: screenOpacity.value }));
  const logoStyle = useAnimatedStyle(() => ({
    opacity: logoOpacity.value,
    transform: [{ scale: logoScale.value }],
  }));
  const floatAStyle = useAnimatedStyle(() => ({
    opacity: 0.5 + floatA.value * 0.5,
    transform: [{ translateY: -floatA.value * 18 }],
  }));
  const floatBStyle = useAnimatedStyle(() => ({
    opacity: 0.5 + floatB.value * 0.5,
    transform: [{ translateY: -floatB.value * 24 }],
  }));
  const floatCStyle = useAnimatedStyle(() => ({
    opacity: 0.5 + floatC.value * 0.5,
    transform: [{ translateY: -floatC.value * 14 }],
  }));

  return (
    <Animated.View style={[styles.container, screenStyle]}>
      <LinearGradient colors={[colors.mint, '#CDEBD0', colors.mint]} style={StyleSheet.absoluteFill} />

      <Animated.View style={[styles.blob, styles.blobA, floatAStyle]} />
      <Animated.View style={[styles.blob, styles.blobB, floatBStyle]} />
      <Animated.View style={[styles.blob, styles.blobC, floatCStyle]} />

      <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
        <View style={styles.center}>
          <Animated.View style={logoStyle}>
            <Text style={styles.logo}>
              Shop<Text style={{ color: colors.green }}>Smart</Text>
            </Text>
            <Text style={styles.tagline}>Compare grocery prices, instantly</Text>
          </Animated.View>
        </View>
      </SafeAreaView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  center: { alignItems: 'center' },
  // lineHeight is deliberately larger than fontSize — ExtraBold glyphs at
  // this size need headroom or their ascenders/descenders clip against a
  // tight line box (this showed up as the logo looking "cut off").
  logo: { ...typography.display, fontSize: 40, lineHeight: 48, color: colors.charcoal, textAlign: 'center' },
  tagline: { ...typography.body, color: `${colors.charcoal}80`, marginTop: 10, textAlign: 'center' },
  blob: { position: 'absolute', borderRadius: 999 },
  blobA: { width: 160, height: 160, backgroundColor: '#F43F5E22', top: '18%', left: '8%' },
  blobB: { width: 200, height: 200, backgroundColor: '#0284C722', bottom: '14%', right: '6%' },
  blobC: { width: 120, height: 120, backgroundColor: '#10B98133', top: '58%', left: '62%' },
});
