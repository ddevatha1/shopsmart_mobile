import AsyncStorage from '@react-native-async-storage/async-storage';
import { useOnboardingStore } from '../onboardingStore';

// jest.mock calls are hoisted above these imports by Babel/ts-jest, so this
// runs before onboardingStore ever touches the real AsyncStorage module.
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

describe('onboardingStore', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    useOnboardingStore.setState({ completed: false, hintsSeen: {}, hydrated: false });
  });

  test('hydrate() defaults to not-completed with no hints seen when nothing is persisted', async () => {
    await useOnboardingStore.getState().hydrate();
    const state = useOnboardingStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.completed).toBe(false);
    expect(state.hintsSeen).toEqual({});
  });

  test('completeOnboarding() persists across a fresh hydrate (simulating an app restart)', async () => {
    await useOnboardingStore.getState().hydrate();
    await useOnboardingStore.getState().completeOnboarding();
    expect(useOnboardingStore.getState().completed).toBe(true);

    // Simulate a restart: reset in-memory state, hydrate again from storage.
    useOnboardingStore.setState({ completed: false, hintsSeen: {}, hydrated: false });
    await useOnboardingStore.getState().hydrate();
    expect(useOnboardingStore.getState().completed).toBe(true);
  });

  test('markHintSeen()/isHintSeen() round-trip and persist independently per hint key', async () => {
    await useOnboardingStore.getState().hydrate();
    expect(useOnboardingStore.getState().isHintSeen('cart')).toBe(false);

    await useOnboardingStore.getState().markHintSeen('cart');
    expect(useOnboardingStore.getState().isHintSeen('cart')).toBe(true);
    // Marking one hint must not mark a different one.
    expect(useOnboardingStore.getState().isHintSeen('route')).toBe(false);

    useOnboardingStore.setState({ completed: false, hintsSeen: {}, hydrated: false });
    await useOnboardingStore.getState().hydrate();
    expect(useOnboardingStore.getState().isHintSeen('cart')).toBe(true);
    expect(useOnboardingStore.getState().isHintSeen('route')).toBe(false);
  });

  test('resetOnboarding() clears both the completed flag and every seen hint ("Restart Onboarding")', async () => {
    await useOnboardingStore.getState().hydrate();
    await useOnboardingStore.getState().completeOnboarding();
    await useOnboardingStore.getState().markHintSeen('search-compare');
    await useOnboardingStore.getState().markHintSeen('cart');

    await useOnboardingStore.getState().resetOnboarding();
    const state = useOnboardingStore.getState();
    expect(state.completed).toBe(false);
    expect(state.hintsSeen).toEqual({});

    // And the reset must itself persist, not just live in memory.
    useOnboardingStore.setState({ completed: true, hintsSeen: { cart: true }, hydrated: false });
    await useOnboardingStore.getState().hydrate();
    expect(useOnboardingStore.getState().completed).toBe(false);
    expect(useOnboardingStore.getState().hintsSeen).toEqual({});
  });

  test('a malformed/corrupt persisted value falls back to defaults instead of throwing', async () => {
    await AsyncStorage.setItem('shopsmart_onboarding_v1', 'not valid json{{{');
    await expect(useOnboardingStore.getState().hydrate()).resolves.toBeUndefined();
    const state = useOnboardingStore.getState();
    expect(state.completed).toBe(false);
    expect(state.hintsSeen).toEqual({});
  });
});
