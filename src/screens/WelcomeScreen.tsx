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
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';
import { elevation, radius, spacing } from '../theme/metrics';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Welcome'>;

const FEATURES = [
  { icon: 'flash-outline' as const, text: 'Live prices from 4 stores in one search' },
  { icon: 'wallet-outline' as const, text: 'Always find the lowest price nearby' },
  { icon: 'bag-handle-outline' as const, text: 'Build one cart across every store' },
];

/** Branding + account choice screen for signed-out users, shown right
 * after the OnboardingScreen walkthrough. Mirrors the web app's
 * branding/value proposition — no equivalent screen exists on web (the
 * site's hero search IS its welcome screen), so this is a mobile-only
 * addition built to introduce the app before asking for an account. */
export function WelcomeScreen({ navigation }: Props) {
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

  return (
    <View style={{ flex: 1 }}>
      <LinearGradient colors={[colors.mint, colors.white]} style={StyleSheet.absoluteFill} />
      <SafeAreaView style={styles.safeArea}>
        <Animated.View style={[styles.content, contentStyle]}>
          <View style={styles.top}>
            <Text style={styles.logo}>
              Shop<Text style={{ color: colors.green }}>Smart</Text>
            </Text>
            <Text style={styles.headline}>Grocery shopping,{'\n'}smarter than ever.</Text>
            <Text style={styles.subhead}>
              Compare live prices across Trader Joe&apos;s, Sprouts, Kroger, and Aldi — then shop the best deal, every time.
            </Text>

            <View style={styles.features}>
              {FEATURES.map((f) => (
                <View key={f.text} style={styles.featureRow}>
                  <View style={styles.featureIcon}>
                    <Ionicons name={f.icon} size={16} color={colors.green} />
                  </View>
                  <Text style={styles.featureText}>{f.text}</Text>
                </View>
              ))}
            </View>
          </View>

          <View style={styles.actions}>
            <AnimatedPressable
              style={styles.primaryButton}
              onPress={() => navigation.navigate('Auth', { initialMode: 'signUp', onSuccess: 'toDashboard' })}
            >
              <Text style={styles.primaryButtonText}>Create Account</Text>
            </AnimatedPressable>
            <AnimatedPressable
              style={styles.secondaryButton}
              onPress={() => navigation.navigate('Auth', { initialMode: 'signIn', onSuccess: 'toDashboard' })}
            >
              <Text style={styles.secondaryButtonText}>Log In</Text>
            </AnimatedPressable>
          </View>
        </Animated.View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  content: { flex: 1, justifyContent: 'space-between', paddingHorizontal: spacing.xl, paddingVertical: spacing.xl },
  top: { marginTop: spacing.xxl },
  logo: { ...typography.h2, fontSize: 20, color: colors.charcoal, marginBottom: spacing.xxl },
  headline: { ...typography.display, fontSize: 32, lineHeight: 38 },
  subhead: { ...typography.body, color: `${colors.charcoal}99`, marginTop: spacing.md, maxWidth: 340 },
  features: { marginTop: spacing.xxl, gap: spacing.md },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  featureIcon: {
    width: 32, height: 32, borderRadius: radius.md, backgroundColor: colors.mint,
    alignItems: 'center', justifyContent: 'center', ...elevation.low,
  },
  featureText: { ...typography.bodyMedium, flex: 1 },
  actions: { gap: spacing.sm },
  primaryButton: {
    backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: 16,
    alignItems: 'center', ...elevation.medium,
  },
  primaryButtonText: { ...typography.button, color: colors.white, fontSize: 15.5 },
  secondaryButton: {
    backgroundColor: colors.white, borderWidth: 1.5, borderColor: colors.borderGray,
    borderRadius: radius.md, paddingVertical: 16, alignItems: 'center',
  },
  secondaryButtonText: { ...typography.button, color: colors.charcoal, fontSize: 15.5 },
});
