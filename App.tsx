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
import { useUserStore } from './src/store/userStore';

// Keep the native (OS-level) splash visible until our fonts are ready —
// avoids a flash of un-styled/system-font text before our custom animated
// SplashScreen (src/screens/SplashScreen.tsx) takes over.
SplashScreenNative.preventAutoHideAsync();

export default function App() {
  const hydrateCart = useCartStore((s) => s.hydrate);
  const hydrateUser = useUserStore((s) => s.hydrate);

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
    // Cart is scoped per signed-in account, so it must hydrate after the
    // user does — otherwise it would momentarily load with no owner and
    // come up empty before the correct (or newly-registered) account's
    // cart is known.
    hydrateUser().then(hydrateCart);
  }, [hydrateUser, hydrateCart]);

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
      <AppNavigator />
      <StatusBar style="dark" />
    </SafeAreaProvider>
  );
}
