import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AnimatedPressable } from '../AnimatedPressable';
import { getShoppingSuggestions } from '../../services/assistantSuggestionService';
import { getSessionHistory } from '../../services/assistantShoppingSessionStore';
import { getMostRecentSessionSavings } from '../../services/shoppingHistoryInsightService';
import type { AssistantSuggestion } from '../../models/types';
import { colors } from '../../theme/colors';
import { spacing, radius } from '../../theme/metrics';

/**
 * Homepage Intelligence Strip (Phase 5.5 Part 1) — makes intelligence
 * this app already computes visible on Home, before a shopper asks for
 * it. Zero new intelligence: chips are a direct, unmodified projection of
 * `assistantSuggestionService.getShoppingSuggestions` (restock/frequent/
 * budget signals, already prioritized) and
 * `shoppingHistoryInsightService.getMostRecentSessionSavings` (a real
 * prior session's own real `estimatedSavings`, see
 * assistantShoppingSessionStore.ts's `getSessionHistory`). Renders
 * nothing for a signed-out or brand-new account — that is the correct,
 * honest state, never a placeholder or a "get started" card. Tapping a
 * chip opens the Assistant with a real trigger phrase that
 * intentRouterService.ts already routes deterministically — never a new
 * entry point or a fabricated context.
 *
 * `onAvailabilityChange` (Phase 6.1 Part 1) — an optional, purely
 * informational callback fired once this component's own real-content
 * check resolves (true when it has a savings chip and/or suggestion
 * chips, false otherwise). It reports a fact this component already
 * computed for itself; it does not change what renders here. See
 * homeIntelligencePriorityService.ts, this callback's only real
 * consumer (SearchScreen.tsx), for why a caller needs to know this.
 */

const MAX_SUGGESTION_CHIPS = 3;

const ICON_BY_TYPE: Record<AssistantSuggestion['type'], keyof typeof Ionicons.glyphMap> = {
  restock: 'alert-circle-outline',
  frequent_purchase: 'repeat-outline',
  budget_tip: 'pricetag-outline',
};

/** The exact phrase intentRouterService.ts already maps to a real
 * outcome for this suggestion's type — 'restock'/'frequent_purchase' both
 * reach the real restock-suggestions list (goal: 'restock'), 'budget_tip'
 * starts the real guided savings session. Never a made-up phrase. */
function promptForSuggestion(suggestion: AssistantSuggestion): string {
  return suggestion.type === 'budget_tip' ? 'Help me save money this week' : 'What should I buy?';
}

export function HomeInsightsStrip({
  ownerEmail, onOpenAssistant, onAvailabilityChange,
}: {
  ownerEmail: string;
  onOpenAssistant: (prompt: string) => void;
  onAvailabilityChange?: (available: boolean) => void;
}) {
  const [suggestions, setSuggestions] = useState<AssistantSuggestion[]>([]);
  const [lastTripSavings, setLastTripSavings] = useState<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    if (!ownerEmail) {
      setSuggestions([]);
      setLastTripSavings(undefined);
      onAvailabilityChange?.(false);
      return;
    }
    Promise.all([getShoppingSuggestions(ownerEmail), getSessionHistory(ownerEmail)]).then(([realSuggestions, history]) => {
      if (cancelled) return;
      const savings = getMostRecentSessionSavings(history);
      setSuggestions(realSuggestions);
      setLastTripSavings(savings);
      onAvailabilityChange?.(realSuggestions.length > 0 || savings != null);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerEmail]);

  const chips = suggestions.slice(0, MAX_SUGGESTION_CHIPS);
  if (chips.length === 0 && lastTripSavings == null) return null;

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
      {lastTripSavings != null && (
        <AnimatedPressable style={styles.chip} scaleTo={0.96} onPress={() => onOpenAssistant('How did my shopping improve?')}>
          <Ionicons name="trending-up-outline" size={14} color={colors.green} />
          <Text style={styles.chipText}>Saved ${lastTripSavings.toFixed(2)} last trip</Text>
        </AnimatedPressable>
      )}
      {chips.map((s) => (
        <AnimatedPressable
          key={`${s.type}-${s.itemName}`}
          style={styles.chip}
          scaleTo={0.96}
          onPress={() => onOpenAssistant(promptForSuggestion(s))}
        >
          <Ionicons name={ICON_BY_TYPE[s.type]} size={14} color={colors.green} />
          <Text style={styles.chipText} numberOfLines={1}>{s.itemName}</Text>
        </AnimatedPressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.xs,
    backgroundColor: colors.mint, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: spacing.xs + 2,
  },
  chipText: { color: colors.green, fontSize: 12.5, fontWeight: '700', maxWidth: 170 },
});
