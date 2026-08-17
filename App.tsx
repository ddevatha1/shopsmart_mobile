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
import { useCartStore } from './src/store/cartStore';
import { useGuestZipStore } from './src/store/guestZipStore';
import { useGuestSearchHistoryStore } from './src/store/guestSearchHistoryStore';
import { useOnboardingStore } from './src/store/onboardingStore';
import { useWarmupStore } from './src/store/warmupStore';
import { perfLog } from './src/utils/perfLog';

// Keep the native (OS-level) splash screen (see app.json's expo-splash-
// screen config: assets/splash-icon.png on a mint background) visible
// until fonts are ready AND the real first screen (Search, inside Tabs)
// has mounted underneath — see onLayoutRootView below, which is the only
// place that ever hides it. No custom JS-rendered splash route sits in
// between: this is purely "hide the native splash the moment the app is
// actually ready," never an auth gate and never an artificial minimum
// duration.
SplashScreenNative.preventAutoHideAsync();

perfLog('app:start');

export default function App() {
  const hydrateCart = useCartStore((s) => s.hydrate);
  const hydrateGuestZip = useGuestZipStore((s) => s.hydrate);
  const hydrateGuestSearchHistory = useGuestSearchHistoryStore((s) => s.hydrate);
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
    hydrateOnboarding();
  }, [hydrateOnboarding]);

  useEffect(() => {
    // No account to hydrate first anymore — cart is a single, always-
    // present device-local cart (see cartStore.ts's GUEST_OWNER_KEY), so
    // it hydrates independently and immediately, same as everything else
    // here. Never blocks the Tabs screen from rendering: hydration just
    // fills in the real cart contents a moment after first paint.
    hydrateCart();
  }, [hydrateCart]);

  useEffect(() => {
    // Deliberately NOT the trigger for a location-permission prompt —
    // this only reads whatever ZIP (if any) was already resolved and
    // cached on a previous search/session (see guestZipStore.ts). If
    // none exists yet, `zipcode` is simply empty and warm-up runs its
    // zip-independent pieces only; the actual location prompt happens
    // later, only when the shopper performs a real search (see
    // searchStore.ts's resolveZipcode call) — never here, at launch.
    hydrateGuestZip().then(() => {
      // Fire-and-forget, deliberately not awaited: the Tabs screen must
      // never wait on this. See warmupStore.ts for the dedup guard that
      // keeps this safe to call again on remount.
      const zipcode = useGuestZipStore.getState().zipcode || undefined;
      warmup(zipcode);
    });
  }, [hydrateGuestZip, warmup]);

  useEffect(() => {
    hydrateGuestSearchHistory();
  }, [hydrateGuestSearchHistory]);

  const onLayoutRootView = useCallback(async () => {
    if (fontsLoaded) {
      // The real first screen (Search, inside Tabs — see AppNavigator)
      // has now mounted underneath — hide the native splash so control
      // hands off directly to it. No custom in-app splash/onboarding
      // screen sits in between anymore (see requirement: the first
      // usable screen is search, with no intermediate screens).
      await SplashScreenNative.hideAsync();
    }
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    return null;
  }

  return (
    <SafeAreaProvider onLayout={onLayoutRootView}>
      <AppNavigator />
      <StatusBar style="dark" />
    </SafeAreaProvider>
  );
}
