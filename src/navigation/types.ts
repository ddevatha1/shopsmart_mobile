import type { NavigatorScreenParams } from '@react-navigation/native';
import type { ApiProduct } from '../models/types';
import type { ProductGroup } from '../services/comparisonService';

export type RootStackParamList = {
  Splash: undefined;
  /** The single minimal Welcome screen — branding + one-sentence value
   * prop + "Get Started"/"Skip" (see SplashScreen/OnboardingScreen).
   * Reached on first launch (signed out) and again from Profile's
   * "Restart Onboarding" (signed in — see ProfileScreen). */
  Onboarding: undefined;
  /** NavigatorScreenParams so a top-level screen (e.g. Planner) can jump
   * straight into a specific tab — `navigate('Tabs', { screen: 'Route' })`
   * — since Route now lives inside the tab navigator rather than as its
   * own top-level stack screen. */
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
  /** Stage 2 — the store comparison hero screen for one semantic product
   * group (see ProductGroupCard / SearchScreen). `allDirectProducts` is the
   * whole direct-match pool from the search that led here (every variety,
   * every store) — carried along only so the "Still looking?" refinement
   * strip (RefinementSection) can offer sibling categories and an
   * ungrouped per-store view without re-fetching or navigating away.
   * Optional because a screen could in principle push Compare with just
   * one group and no broader context; every real call site passes it. */
  Compare: { group: ProductGroup; allDirectProducts?: ApiProduct[] };
  ProductDetail: { product: ApiProduct; allProducts: ApiProduct[] };
  /**
   * `onSuccess` controls where a successful sign-in/sign-up lands:
   *   - 'toDashboard' (from Welcome, first-launch onboarding): reset the
   *     whole stack to Tabs so there's no back button into onboarding.
   *   - 'goBack' (from Profile's "Sign In" prompt, mid-session): just
   *     dismiss back to whatever screen pushed Auth.
   */
  Auth: { initialMode?: 'signIn' | 'signUp'; onSuccess?: 'goBack' | 'toDashboard' } | undefined;
  /** The Smart Shopping Planner — no params; reads ZIP/preferences from
   * useUserStore/plannerPreferenceService the same way every other screen
   * reads shared state instead of threading it through navigation. */
  Planner: undefined;
};

export type TabParamList = {
  Search: undefined;
  Cart: undefined;
  /** A persistent bottom-nav destination now, not a screen pushed on top
   * of the stack — reads the cart directly from useCartStore rather than
   * taking it as a param, same pattern as every other screen reading
   * shared state from Zustand instead of threading it through navigation.
   * Shows an empty-state CTA (rather than a blank map) when the cart has
   * nothing to route yet, per "don't surface the route too early." */
  Route: undefined;
  Profile: undefined;
};
