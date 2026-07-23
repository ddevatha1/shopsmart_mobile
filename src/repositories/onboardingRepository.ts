import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Persisted onboarding state — deliberately independent of `userRepository`
 * (the signed-in account): a shopper needs a "have they seen onboarding
 * yet" answer *before* an account exists (during the Welcome screen), and
 * the same shopper's contextual-hint history shouldn't reset just because
 * they signed out and back in. Mirrors userRepository.ts's
 * load/save-with-try/catch shape.
 */
const ONBOARDING_KEY = 'shopsmart_onboarding_v1';

export type HintKey = 'search-suggestions' | 'search-compare' | 'compare' | 'cart' | 'route';

export interface OnboardingState {
  completed: boolean;
  hintsSeen: Partial<Record<HintKey, boolean>>;
}

function defaultState(): OnboardingState {
  return { completed: false, hintsSeen: {} };
}

export const onboardingRepository = {
  async load(): Promise<OnboardingState> {
    const raw = await AsyncStorage.getItem(ONBOARDING_KEY);
    if (!raw) return defaultState();
    try {
      const parsed = JSON.parse(raw) as Partial<OnboardingState>;
      return {
        completed: parsed.completed ?? false,
        hintsSeen: parsed.hintsSeen ?? {},
      };
    } catch {
      return defaultState();
    }
  },

  async save(state: OnboardingState): Promise<void> {
    await AsyncStorage.setItem(ONBOARDING_KEY, JSON.stringify(state));
  },
};
