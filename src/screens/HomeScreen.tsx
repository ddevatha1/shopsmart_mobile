import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { useNavigation, type CompositeNavigationProp } from '@react-navigation/native';
import { useStoreModeStore } from '../store/storeModeStore';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { ScreenContainer } from '../components/ScreenContainer';
import { HomeCapabilityCards } from '../components/home/HomeCapabilityCards';
import { AskCartIQFAB } from '../components/home/AskCartIQFAB';
import { ContextualHint } from '../components/onboarding/ContextualHint';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';
import { spacing, radius, elevation } from '../theme/metrics';
import type { RootStackParamList, TabParamList } from '../navigation/types';

/** Home is a tab nested inside the root stack, so it needs BOTH
 * navigators' types at once: `navigate('Cart')` (a sibling tab) and
 * `navigate('Search' | 'Assistant' | 'Route' | ...)` (root stack
 * pushes). */
type HomeScreenNavigationProp = CompositeNavigationProp<
  BottomTabNavigationProp<TabParamList, 'Home'>,
  NativeStackNavigationProp<RootStackParamList>
>;

/**
 * Navigation Redesign — the persistent "command center" (per the brief's
 * own framing: "the navigation hub is the user's command center; the
 * search screen is a focused task experience"). This screen NEVER shows
 * search results itself, and never disappears when a shopper searches —
 * it's a real, separate Tab screen that stays mounted underneath the
 * `Search`/`SearchResults` screens the root stack pushes on top of it
 * (see navigation/types.ts). Tapping the search bar below is the ONLY
 * way this screen ever navigates away from itself for a search — no
 * live TextInput lives here any more (that moved to SearchScreen.tsx),
 * so this screen has no query state of its own to lose or restore:
 * there's simply nothing on it that a search could have replaced.
 *
 * Formerly `SearchScreen.tsx` before the Home/Search/Results split —
 * this file keeps everything that ISN'T "enter a query, see results":
 * the hero, the capability cards (redesigned — see HomeCapabilityCards),
 * the floating Assistant button, and the one-time AI-discovery hint.
 */
export function HomeScreen() {
  const navigation = useNavigation<HomeScreenNavigationProp>();
  const selectedStore = useStoreModeStore((s) => s.selectedStore);

  const openSearch = () => navigation.navigate('Search');
  const openAssistant = () => navigation.navigate('Assistant');
  const openShoppingList = () => navigation.navigate('Planner');
  const openMealPlanner = () => navigation.navigate('MealPlanner');
  const openCart = () => navigation.navigate('Cart');
  const openSavings = () => navigation.navigate('Savings');
  const openRoute = () => navigation.navigate('Route');

  return (
    <ScreenContainer variant="tab">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        // Extra clearance so the floating "Ask CartIQ" button never
        // permanently overlaps the last real content once scrolling stops.
        contentContainerStyle={{ paddingBottom: spacing.xxl + 60 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.hero}>
          <Text style={styles.wordmark}>
            Shop<Text style={{ color: colors.green }}>Smart</Text>
          </Text>
          <Text style={styles.heroTagline}>Your smart grocery assistant</Text>

          {/* A tappable trigger, not a live input — this is the one
              change that actually fixes the core complaint: searching
              used to replace this whole screen in place. Now it just
              opens a dedicated screen; this one never unmounts. */}
          <AnimatedPressable onPress={openSearch} style={styles.searchTrigger} scaleTo={0.98}>
            <Ionicons name="search" size={18} color={`${colors.charcoal}80`} />
            <Text style={styles.searchTriggerText}>
              {selectedStore ? `Search ${selectedStore}` : 'Search milk, bananas, chicken, etc.'}
            </Text>
          </AnimatedPressable>

          <Text style={styles.heroFooter}>Compare prices • Find savings • Build your cart</Text>
        </View>

        <HomeCapabilityCards
          onOpenSavings={openSavings}
          onOpenMealPlanner={openMealPlanner}
          onOpenShoppingList={openShoppingList}
          onOpenAssistant={openAssistant}
          onOpenRoute={openRoute}
        />

        {/* AI Capability Discovery — subtle, once-only "did you know it
            can do this" nudge (see onboardingRepository.ts's
            'assistant-intro' HintKey). Real example prompts, never a
            tutorial; never reappears once dismissed. */}
        <View style={styles.assistantHintWrap}>
          <ContextualHint
            hintKey="assistant-intro"
            icon="sparkles"
            title="Ask CartIQ"
            message={'Try: "Create a cheap meal plan" or "Optimize my grocery budget."'}
          />
        </View>
      </ScrollView>

      <AskCartIQFAB onPress={openAssistant} />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  hero: { backgroundColor: colors.mint, padding: spacing.xl, paddingBottom: spacing.xxl, alignItems: 'center' },
  wordmark: { ...typography.h2, fontSize: 20 },
  heroTagline: { ...typography.body, color: `${colors.charcoal}80`, marginTop: 2, marginBottom: spacing.lg },
  searchTrigger: {
    width: '100%', flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    backgroundColor: colors.white, borderRadius: radius.lg, paddingHorizontal: spacing.lg, paddingVertical: spacing.md + 2,
    ...elevation.medium,
  },
  searchTriggerText: { ...typography.body, color: `${colors.charcoal}80`, fontSize: 14 },
  heroFooter: { ...typography.caption, marginTop: spacing.lg, textAlign: 'center' },
  assistantHintWrap: { paddingHorizontal: spacing.lg, marginTop: spacing.md },
});
