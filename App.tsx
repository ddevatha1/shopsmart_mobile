import React, { useCallback, useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreenNative from 'expo-splash-screen';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  useFonts,
  Manrope_200ExtraLight,
  Manrope_300Light,
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  Manrope_800ExtraBold,
} from '@expo-google-fonts/manrope';
import { AppNavigator } from './src/navigation/AppNavigator';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import { useCartStore } from './src/store/cartStore';
import { useUserStore } from './src/store/userStore';
import { useOnboardingStore } from './src/store/onboardingStore';
import { useWarmupStore } from './src/store/warmupStore';
import { perfLog } from './src/utils/perfLog';

// Keep the native (OS-level) splash visible until our fonts are ready —
// avoids a flash of un-styled/system-font text before our custom animated
// SplashScreen (src/screens/SplashScreen.tsx) takes over.
SplashScreenNative.preventAutoHideAsync();

perfLog('app:start');

export default function App() {
  const hydrateCart = useCartStore((s) => s.hydrate);
  const hydrateUser = useUserStore((s) => s.hydrate);
  const hydrateOnboarding = useOnboardingStore((s) => s.hydrate);
  const warmup = useWarmupStore((s) => s.warmup);

  const [fontsLoaded] = useFonts({
    Manrope_200ExtraLight,
    Manrope_300Light,
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    Manrope_800ExtraBold,
  });

  useEffect(() => {
    // Independent of the signed-in user (it must work before an account
    // even exists, at the Welcome screen) — fired in parallel rather than
    // chained after hydrateUser.
    hydrateOnboarding();
  }, [hydrateOnboarding]);

  // Backend/search warm-up — fired here, at the true first render, rather
  // than chained after hydrateUser() resolving. The previous version
  // waited on that on-device AsyncStorage read before even STARTING the
  // network warm-up call, which meant the very thing meant to hide
  // network latency was itself delayed by an unrelated disk read. This
  // zip-less call warms everything that doesn't need a shopper's ZIP yet
  // (Kroger OAuth, Aldi/Sprouts sessions, Trader Joe's browser session) —
  // see warmupStore.ts. Deliberately not awaited: the splash-to-Tabs
  // transition must never wait on this.
  useEffect(() => {
    warmup();
  }, [warmup]);

  useEffect(() => {
    // Cart is scoped per signed-in account, so it must hydrate after the
    // user does — otherwise it would momentarily load with no owner and
    // come up empty before the correct (or newly-registered) account's
    // cart is known.
    hydrateUser().then(() => {
      hydrateCart();
      // A second, zip-specific warm-up call — real and independent of the
      // zip-less one above (see warmupStore.ts's per-zip-key dedup), not
      // a duplicate: it warms the zip-specific nearest-store lookups and
      // runs the background dummy search, neither of which the zip-less
      // call above can do without a real ZIP. Still deliberately not
      // awaited here; useSearchStore's own first search is what actually
      // waits on this (see warmupStore.ts's waitForWarmup).
      const zipcode = useUserStore.getState().user?.zipcode;
      warmup(zipcode);
    });
  }, [hydrateUser, hydrateCart, warmup]);

  const onLayoutRootView = useCallback(async () => {
    if (fontsLoaded) {
      // Our custom SplashScreen component has now mounted underneath —
      // hide the native one so control hands off seamlessly.
      await SplashScreenNative.hideAsync();
    }
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    return null;
  }

  return (
    <SafeAreaProvider onLayout={onLayoutRootView}>
      <ErrorBoundary>
        <AppNavigator />
      </ErrorBoundary>
      <StatusBar style="dark" />
    </SafeAreaProvider>
  );
}
