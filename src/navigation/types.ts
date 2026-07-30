import type { ApiProduct, StoreName } from '../models/types';
import type { ProductGroup } from '../services/comparisonService';

export type RootStackParamList = {
  Splash: undefined;
  /** The single minimal Welcome screen — branding + one-sentence value
   * prop + "Get Started"/"Skip" (see SplashScreen/OnboardingScreen).
   * Reached on first launch (signed out) and again from Profile's
   * "Restart Onboarding" (signed in — see ProfileScreen). */
  Onboarding: undefined;
  Tabs: undefined;
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
   *
   * `preferredStoreToSave` (Phase 6 Part 2) — a real, explicit selection
   * a shopper made on OnboardingScreen's optional store picker, carried
   * here only because no account (and so no `ownerEmail` to persist
   * against) exists yet at selection time. AuthScreen writes it via
   * `shopperPreferenceService.addPreferredStore` ONLY on a successful
   * sign-UP (a brand-new account) — never on sign-in, and never unless
   * the shopper explicitly tapped a store. Omitted (the normal case,
   * every other `navigate('Auth', ...)` call site) saves nothing.
   */
  Auth: { initialMode?: 'signIn' | 'signUp'; onSuccess?: 'goBack' | 'toDashboard'; preferredStoreToSave?: StoreName } | undefined;
  /** Reads the cart directly from useCartStore rather than taking it as a
   * param — same pattern as every other screen reading shared state from
   * Zustand instead of threading it through navigation. */
  Route: undefined;
  /** The Smart Shopping Planner — reads ZIP/preferences from
   * useUserStore/plannerPreferenceService the same way every other screen
   * reads shared state instead of threading it through navigation.
   * `prefillText` (Phase 5.0) is optional and additive — set only when
   * arriving from AssistantScreen's "Open in Planner" action on a real
   * MealPlanResult's grocery items; every existing `navigate('Planner')`
   * call site with no params keeps working unchanged. */
  Planner: { prefillText?: string } | undefined;
  /** The Assistant Boundary's first real UI surface (Phase 5.0) — typed
   * text only; every request it sends goes through assistantService.ts's
   * `runAssistant`, never a separate pipeline. `initialPrompt` (Phase 5.5
   * Part 1) is optional and additive — set only when arriving from the
   * homepage's HomeInsightsStrip, and sent through the exact same `send`
   * function a hand-typed message uses (see AssistantScreen.tsx); every
   * existing `navigate('Assistant')` call site with no params keeps
   * working unchanged. */
  Assistant: { initialPrompt?: string } | undefined;
  /** Homepage Redesign — a dedicated, UI-driven entry point over the
   * exact same real generator the Assistant's "plan my meals" flow
   * already calls (see mealPlanService.ts's `requestMealPlan` and
   * assistantDispatcher.ts's `dispatchMealPlan`) — no second meal-plan
   * pipeline. Reachable from Home's "Plan a Whole Meal" card. */
  MealPlanner: undefined;
  /** Homepage Redesign — the new home for the real, already-computed
   * homepage intelligence surfaces (HomeInsightsStrip, PantryCheckInCard,
   * AdvisorCard's home insight, real session-savings history) that used
   * to render directly on Home before this redesign decluttered it down
   * to a clean search hub. Nothing about what these surfaces compute
   * changed — only where a shopper goes to see them. Reachable from
   * Home's "Find Savings" card. */
  Savings: undefined;
  /** AI Product Quality Scanner (Feature 1) + optional expiration-date
   * detection (Feature 2) — reached only from Route's own optional
   * "Check quality" action on a pickup checklist item (see
   * RouteScreen.tsx's GuidedPickupFlow). `productName` is the real item
   * this scan was launched for, used only as a hint to the vision model
   * and to key a real detected expiration date to the right product —
   * never required, since the scanner still works with no product
   * context. */
  ProductQuality: { productName?: string } | undefined;
  /** Navigation Redesign — the dedicated, focused search-input screen
   * (large input, recent/suggested searches, "Try asking CartIQ"
   * AI-example prompts). Reached ONLY from the Home Hub tapping its
   * (non-editable) search bar — see HomeScreen.tsx. Deliberately its own
   * root-stack push (hides the tab bar, gets a real back arrow) rather
   * than a mode flag on the Hub, so submitting a search no longer
   * replaces the Hub in place — the Hub stays mounted underneath,
   * scroll position and all. No params: reads/writes the same
   * `useSearchStore`/`useStoreModeStore` every other search-related
   * screen already does. */
  Search: undefined;
  /** Navigation Redesign — everything that used to render inline on the
   * old combined Home/Search screen once `hasSearched` was true (the
   * product grid, ComparisonView bypass, RefinementSection, "Did you
   * mean" banner) now lives here instead, reached by submitting a query
   * on the `Search` screen above. No params — store-driven, same
   * convention as `Search`. Its own back arrow returns to `Search` (the
   * query is still there to edit/resubmit); `Search`'s own back arrow is
   * what returns to the Hub. */
  SearchResults: undefined;
};

export type TabParamList = {
  /** Renamed from `Search` (Navigation Redesign) — this tab is now the
   * Home Hub (search launcher + capability cards), not the search
   * experience itself; keeping the old name would also collide with the
   * new root-stack `Search` screen above when a component holds a
   * composite nav prop for both navigators at once (see HomeScreen.tsx). */
  Home: undefined;
  Cart: undefined;
  Profile: undefined;
};
