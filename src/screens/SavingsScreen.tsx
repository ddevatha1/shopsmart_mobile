import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { ScreenContainer } from '../components/ScreenContainer';
import { ScreenHeader } from '../components/ScreenHeader';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { AdvisorCard } from '../components/AdvisorCard';
import { HomeInsightsStrip } from '../components/home/HomeInsightsStrip';
import { PantryCheckInCard } from '../components/home/PantryCheckInCard';
import { ShoppingHistoryCard } from '../components/assistant/ShoppingHistoryCard';
import { dismissalKey, getHomeInsight, type AdvisorInsight } from '../services/advisorService';
import { dismissInsight } from '../services/dismissalStore';
import { selectHomeIntelligenceSurface } from '../services/homeIntelligencePriorityService';
import { getSessionHistory } from '../services/assistantShoppingSessionStore';
import { useSearchStore } from '../store/searchStore';
import { useUserStore } from '../store/userStore';
import { useCartStore } from '../store/cartStore';
import { useStoreModeStore } from '../store/storeModeStore';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';
import { spacing, radius } from '../theme/metrics';
import type { RootStackParamList } from '../navigation/types';
import type { ShoppingSessionHistory } from '../models/intent';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Savings'> };

/**
 * Homepage Redesign — "Find Savings." This screen does not compute
 * anything new: it's the relocated home for the exact real intelligence
 * surfaces (`HomeInsightsStrip`, `PantryCheckInCard`, `AdvisorCard`'s
 * home insight, and now real session-savings history) that used to
 * render directly on Home before this redesign decluttered it down to a
 * clean search hub. Every data source, every service call, and every
 * evidence-gating rule is identical to before — see
 * homeIntelligencePriorityService.ts for the unchanged priority
 * arbitration (`HomeInsightsStrip` → `PantryCheckInCard` → `AdvisorCard`)
 * this screen still uses, just with the assistant-discovery hint tier
 * dropped (the Home hub's floating "Ask CartIQ" button now handles
 * that job, so there's no reason to ever show "nothing real to say"
 * copy on the one screen a shopper came to specifically to see savings).
 */
export function SavingsScreen({ navigation }: Props) {
  const user = useUserStore((s) => s.user);
  const ownerEmail = user?.email ?? '';
  const selectedStore = useStoreModeStore((s) => s.selectedStore);
  const allSearchProducts = useSearchStore((s) => s.products);
  const addToCart = useCartStore((s) => s.addToCart);
  const productsForAdvisor = selectedStore
    ? allSearchProducts.filter((p) => p.store === selectedStore)
    : allSearchProducts;

  const [advisorInsight, setAdvisorInsight] = useState<AdvisorInsight | null>(null);
  const [advisorEvaluated, setAdvisorEvaluated] = useState(false);
  const [stripHasContent, setStripHasContent] = useState(false);
  const [stripEvaluated, setStripEvaluated] = useState(false);
  const [pantryHasContent, setPantryHasContent] = useState(false);
  const [pantryEvaluated, setPantryEvaluated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAdvisorEvaluated(false);
    const insightPromise = user
      ? getHomeInsight({ ownerEmail: user.email, recentSearchProducts: productsForAdvisor })
      : Promise.resolve(null);
    insightPromise.then((insight) => {
      if (cancelled) return;
      setAdvisorInsight(insight);
      setAdvisorEvaluated(true);
    });
    return () => {
      cancelled = true;
    };
  }, [user, productsForAdvisor]);

  const ready = advisorEvaluated && stripEvaluated && pantryEvaluated;
  const surface = selectHomeIntelligenceSurface({
    insightsStripHasContent: stripHasContent,
    pantryHasContent,
    advisorHasContent: advisorInsight != null,
  });

  const handleDismissAdvisor = () => {
    if (!advisorInsight) return;
    dismissInsight(ownerEmail, dismissalKey(advisorInsight));
    setAdvisorInsight(null);
  };

  // Real session-savings history (Phase 5.3 Part 5's `getSessionHistory`,
  // unchanged) — reused directly with the exact same `ShoppingHistoryCard`
  // the Assistant's own thread already renders, not a second history view.
  const [sessions, setSessions] = useState<ShoppingSessionHistory[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!ownerEmail) {
      setSessions([]);
      return;
    }
    getSessionHistory(ownerEmail).then((history) => {
      if (!cancelled) setSessions(history);
    });
    return () => {
      cancelled = true;
    };
  }, [ownerEmail]);

  const nothingToShow = ready && surface !== 'insights_strip' && surface !== 'pantry_check_in'
    && !(surface === 'advisor' && advisorInsight) && sessions.length === 0;

  return (
    <ScreenContainer>
      <ScreenHeader title="Savings" onBack={() => navigation.goBack()} />

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <HomeInsightsStrip
          ownerEmail={ownerEmail}
          onOpenAssistant={(prompt) => navigation.navigate('Assistant', { initialPrompt: prompt })}
          onAvailabilityChange={(available) => {
            setStripHasContent(available);
            setStripEvaluated(true);
          }}
        />

        <PantryCheckInCard
          ownerEmail={ownerEmail}
          onAddToList={(itemName) => navigation.navigate('Planner', { prefillText: itemName })}
          onAvailabilityChange={(available) => {
            setPantryHasContent(available);
            setPantryEvaluated(true);
          }}
          suppressedBy={surface !== 'pantry_check_in'}
        />

        {ready && surface === 'advisor' && advisorInsight && (
          <View style={styles.advisorSlot}>
            <AdvisorCard
              insight={advisorInsight}
              onSeeProduct={(product) => navigation.navigate('ProductDetail', { product, allProducts: allSearchProducts })}
              onAddToCart={(product) => addToCart(product)}
              onDismiss={handleDismissAdvisor}
            />
          </View>
        )}

        {sessions.length > 0 && (
          <View style={styles.historySlot}>
            <ShoppingHistoryCard sessions={sessions} />
          </View>
        )}

        {nothingToShow && (
          <View style={styles.emptyState}>
            <Ionicons name="cash-outline" size={28} color={`${colors.green}80`} />
            <Text style={styles.emptyTitle}>No savings signals yet</Text>
            <Text style={styles.emptyText}>
              Search for groceries, build a shopping list, or ask CartIQ to save you money — real savings and
              suggestions will show up here.
            </Text>
          </View>
        )}
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  body: { paddingBottom: spacing.xxl, gap: spacing.md },
  advisorSlot: { paddingHorizontal: spacing.lg },
  historySlot: { paddingHorizontal: spacing.lg },
  emptyState: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: spacing.xl, gap: spacing.sm },
  emptyTitle: { ...typography.h3 },
  emptyText: { ...typography.body, color: `${colors.charcoal}80`, textAlign: 'center' },
});
