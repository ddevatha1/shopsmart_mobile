import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { AnimatedPressable } from '../AnimatedPressable';
import { PlanStoreSection } from './PlanStoreSection';
import type { PlanCandidate, PlanCandidateId, PlanLineItem } from '../../models/types';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { spacing, radius } from '../../theme/metrics';

interface Props {
  candidates: PlanCandidate[];
  recommendedId: PlanCandidateId;
  unresolvedItems: PlanLineItem[];
  onStartShopping: (candidate: PlanCandidate) => void;
}

function formatMinutes(minutes: number): string {
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

/** The results screen: a tab per candidate plan (Balanced first/default), a
 * concise totals block up front, and store sections with progressive
 * disclosure below. Mirrors shopsmart_web's PlanResultsView.tsx. */
export function PlanResultsView({ candidates, recommendedId, unresolvedItems, onStartShopping }: Props) {
  const [activeId, setActiveId] = useState<PlanCandidateId>(recommendedId);
  const active = candidates.find(c => c.id === activeId) ?? candidates[0];
  const [showReasoning, setShowReasoning] = useState(false);

  return (
    <View style={styles.container}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabRow}>
        {candidates.map(c => (
          <AnimatedPressable
            key={c.id}
            onPress={() => setActiveId(c.id)}
            style={[styles.tab, c.id === activeId && styles.tabActive]}
            scaleTo={0.96}
          >
            <Text style={[styles.tabLabel, c.id === activeId && styles.tabLabelActive]}>
              {c.label}{c.id === recommendedId ? ' ✓' : ''}
            </Text>
          </AnimatedPressable>
        ))}
      </ScrollView>

      <View style={styles.statsCard}>
        <Stat value={`$${active.totalCost.toFixed(2)}`} label="Estimated Cost" />
        <Stat value={active.estimatedSavings > 0 ? `$${active.estimatedSavings.toFixed(2)}` : '—'} label="Est. Savings" />
        <Stat value={formatMinutes(active.totalDriveMinutes)} label="Drive Time" />
        <Stat value={`${active.storeCount} store${active.storeCount !== 1 ? 's' : ''}`} label="Stops" />
      </View>

      {active.itemsFound < active.itemsTotal && (
        <Text style={styles.coverageNote}>
          Found {active.itemsFound} of {active.itemsTotal} items for this plan.
        </Text>
      )}

      <View style={styles.storeSection}>
        <Text style={styles.sectionTitle}>Recommended Route</Text>
        {active.storeAssignments.map((assignment, i) => (
          <PlanStoreSection key={`${assignment.store}-${assignment.location.address}`} index={i} assignment={assignment} />
        ))}
      </View>

      {unresolvedItems.length > 0 && (
        <View style={styles.notFoundCard}>
          <Text style={styles.notFoundTitle}>
            {unresolvedItems.length} item{unresolvedItems.length !== 1 ? 's' : ''} not found
          </Text>
          {unresolvedItems.map(item => (
            <Text key={item.listItemId} style={styles.notFoundItem}>
              <Text style={{ fontWeight: '600' }}>{item.rawText}</Text>
              {item.alternativeSuggestion ? ` — try "${item.alternativeSuggestion.name}" instead?` : ''}
            </Text>
          ))}
        </View>
      )}

      <AnimatedPressable onPress={() => setShowReasoning(s => !s)} scaleTo={0.98}>
        <Text style={styles.reasoningToggle}>
          {showReasoning ? 'Hide' : 'Show'} price breakdown &amp; estimated gas cost
        </Text>
      </AnimatedPressable>
      {showReasoning && (
        <View style={styles.reasoningCard}>
          <Text style={styles.reasoningText}>Groceries: ${active.totalCost.toFixed(2)}</Text>
          <Text style={styles.reasoningText}>Est. gas cost (approximate, based on drive distance): ${active.estimatedGasCost.toFixed(2)}</Text>
          <Text style={styles.reasoningText}>Total drive distance: {active.totalDriveMiles.toFixed(1)} mi</Text>
          <Text style={styles.reasoningDisclaimer}>
            This plan is based on price, drive distance, and drive time. Store hours and reliability
            aren&apos;t factored in yet.
          </Text>
        </View>
      )}

      <AnimatedPressable onPress={() => onStartShopping(active)} style={styles.startButton} scaleTo={0.97}>
        <Text style={styles.startButtonText}>Start Shopping</Text>
      </AnimatedPressable>
    </View>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.lg },
  tabRow: { gap: spacing.sm, paddingBottom: spacing.xs },
  tab: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm + 2, borderRadius: radius.pill, backgroundColor: '#F3F4F6' },
  tabActive: { backgroundColor: colors.green },
  tabLabel: { color: `${colors.charcoal}99`, fontSize: 13, fontWeight: '600' },
  tabLabelActive: { color: colors.white },
  statsCard: { flexDirection: 'row', flexWrap: 'wrap', backgroundColor: colors.mint, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.lg },
  stat: { flexGrow: 1, flexBasis: '40%', alignItems: 'center' },
  statValue: { color: colors.green, fontWeight: '800', fontSize: 18 },
  statLabel: { color: `${colors.green}b3`, fontSize: 11, marginTop: 2 },
  coverageNote: { color: '#92400E', fontSize: 12, backgroundColor: '#FFFBEB', borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2 },
  storeSection: { gap: spacing.sm + 2 },
  sectionTitle: { ...typography.cardTitle, fontSize: 14 },
  notFoundCard: { backgroundColor: '#FFFBEB', borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm },
  notFoundTitle: { color: '#78350F', fontWeight: '600', fontSize: 13.5 },
  notFoundItem: { color: '#92400E', fontSize: 12 },
  reasoningToggle: { color: colors.green, fontSize: 12, fontWeight: '500', textDecorationLine: 'underline' },
  reasoningCard: { backgroundColor: colors.panelBg, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm - 2 },
  reasoningText: { color: `${colors.charcoal}b3`, fontSize: 12 },
  reasoningDisclaimer: { color: `${colors.charcoal}73`, fontSize: 12, marginTop: spacing.xs },
  startButton: { backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: spacing.md + 2, minHeight: 50, alignItems: 'center', justifyContent: 'center' },
  startButtonText: { color: colors.white, fontWeight: '700', fontSize: 14.5 },
});
