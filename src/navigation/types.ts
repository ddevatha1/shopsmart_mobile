import type { ApiProduct } from '../models/types';
import type { ProductGroup } from '../services/comparisonService';

export type RootStackParamList = {
  Splash: undefined;
  /** First-launch feature walkthrough, shown once per signed-out session
   * right before Welcome (see SplashScreen/OnboardingScreen). */
  Onboarding: undefined;
  Welcome: undefined;
  Tabs: undefined;
  /** Stage 2 — the store comparison hero screen for one semantic product
   * group (see ProductGroupCard / SearchScreen). */
  Compare: { group: ProductGroup };
  ProductDetail: { product: ApiProduct; allProducts: ApiProduct[] };
  /**
   * `onSuccess` controls where a successful sign-in/sign-up lands:
   *   - 'toDashboard' (from Welcome, first-launch onboarding): reset the
   *     whole stack to Tabs so there's no back button into onboarding.
   *   - 'goBack' (from Profile's "Sign In" prompt, mid-session): just
   *     dismiss back to whatever screen pushed Auth.
   */
  Auth: { initialMode?: 'signIn' | 'signUp'; onSuccess?: 'goBack' | 'toDashboard' } | undefined;
  /** Reads the cart directly from useCartStore rather than taking it as a
   * param — same pattern as every other screen reading shared state from
   * Zustand instead of threading it through navigation. */
  Route: undefined;
};

export type TabParamList = {
  Search: undefined;
  Cart: undefined;
  Profile: undefined;
};
