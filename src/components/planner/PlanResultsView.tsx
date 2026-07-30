import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { AnimatedPressable } from '../AnimatedPressable';
import { PlanStoreSection } from './PlanStoreSection';
import { PlanItemProductGrid } from './PlanItemProductGrid';
import { WhyThisPlanCard } from '../assistant/WhyThisPlanCard';
import { explainRecommendation, type PreferencesUsed } from '../../services/recommendationExplanationService';
import { flattenPlanCandidateItems } from '../../utils/planProducts';
import type { ApiProduct, BudgetAnalysis, PlanCandidate, PlanCandidateId, PlanLineItem } from '../../models/types';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { spacing, radius } from '../../theme/metrics';

interface Props {
  candidates: PlanCandidate[];
  recommendedId: PlanCandidateId;
  unresolvedItems: PlanLineItem[];
  onStartShopping: (candidate: PlanCandidate) => void;
  /** Optional — real navigation into ProductDetail (see PlannerScreen.tsx).
   * Omitted call sites just don't navigate on tap. */
  onPressProduct?: (product: ApiProduct) => void;
  /** Optional — a shopper's real, already-stored preferences (see
   * shopperPreferenceService.ts), used ONLY to build a real, evidence-
   * gated "why" explanation (see recommendationExplanationService.ts) —
   * never passed to the optimizer, never changes which candidate is
   * computed or recommended. */
  preferencesUsed?: PreferencesUsed;
  /** Optional (Phase 6 Part 5) — threaded through to `PlanStoreSection`/
   * `PlanItemProductGrid` for real "why chosen" badges on each product
   * card. Omitted renders every card exactly as before. */
  ownerEmail?: string;
}

/** Foundation-only: a plain one-line comparison, no chart/dashboard — see
 * backend/src/services/budgetAnalysisService.ts for the underlying
 * arithmetic this just puts into words. */
function formatBudgetLine(budget: BudgetAnalysis): string {
  const amount = Math.abs(budget.difference).toFixed(2);
  if (budget.status === 'over') return `$${amount} over your target`;
  if (budget.status === 'at_target') return `Right at your $${budget.target?.toFixed(0) ?? ''} target`;
  return `Under budget by $${amount}`;
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
 * disclosure below. Mirrors CartIQ_web's PlanResultsView.tsx. */
export function PlanResultsView({ candidates, recommendedId, unresolvedItems, onStartShopping, onPressProduct, preferencesUsed, ownerEmail }: Props) {
  const [activeId, setActiveId] = useState<PlanCandidateId>(recommendedId);
  const active = candidates.find(c => c.id === activeId) ?? candidates[0];
  const [showReasoning, setShowReasoning] = useState(false);

  // Phase 5.4 Part 4 — the same structured, evidence-gated explanation
  // the Assistant's ShoppingSessionPlanCard already shows (see
  // recommendationExplanationService.ts) — computed here over the exact
  // same real `active` candidate the shopper is currently viewing, never
  // a second/different selection, and never sent anywhere near the
  // optimizer.
  const explanation = useMemo(() => explainRecommendation(active, preferencesUsed), [active, preferencesUsed]);

  // Phase 7 P0-2 — every real line item across the active candidate's
  // own store assignments, flattened (see planProducts.ts's
  // `flattenPlanCandidateItems`) so the very first products a shopper
  // sees are "everything in your plan," not one store at a time. Same
  // real data `PlanStoreSection` below already renders per store — this
  // is not a second resolution pass, just a different grouping of the
  // exact same `PlanLineItem[]`.
  const allPlanItems = useMemo(() => flattenPlanCandidateItems(active), [active]);

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

      {/* Phase 6.1 Part 4 — reordered to match "how much did I save? →
          where am I shopping? → ..." (savings and stores lead; cost and
          drive time follow as supporting detail). Same four real
          numbers as before, same source fields — presentation order
          only, nothing recomputed. */}
      <View style={styles.statsCard}>
        <Stat value={active.estimatedSavings > 0 ? `$${active.estimatedSavings.toFixed(2)}` : '—'} label="Est. Savings" />
        <Stat value={`${active.storeCount} store${active.storeCount !== 1 ? 's' : ''}`} label="Stops" />
        <Stat value={`$${active.totalCost.toFixed(2)}`} label="Estimated Cost" />
        <Stat value={formatMinutes(active.totalDriveMinutes)} label="Drive Time" />
      </View>

      {active.itemsFound < active.itemsTotal && (
        <Text style={styles.coverageNote}>
          Found {active.itemsFound} of {active.itemsTotal} items for this plan.
        </Text>
      )}

      {active.budgetAnalysis && (
        <Text style={[styles.budgetNote, active.budgetAnalysis.status === 'over' && styles.budgetNoteOver]}>
          {formatBudgetLine(active.budgetAnalysis)}
        </Text>
      )}

      {/* Phase 7 P0-2 — "all products in your plan," reusing the exact
          same PlanItemProductGrid PlanStoreSection uses below, just fed
          the flattened item list instead of one store's. Real ProductCards,
          no new rendering system, no duplicate business logic. */}
      {allPlanItems.length > 0 && (
        <View style={styles.allProductsSection}>
          <Text style={styles.sectionTitle}>All products in your plan</Text>
          <PlanItemProductGrid items={allPlanItems} onPressProduct={onPressProduct} ownerEmail={ownerEmail} />
        </View>
      )}

      {/* Phase 5.4 Part 4 order (Phase 7 P0-2: Summary → All products →
          Store breakdown → Explanation → Actions). */}
      <View style={styles.storeSection}>
        <Text style={styles.sectionTitle}>Recommended Route</Text>
        {active.storeAssignments.map((assignment, i) => (
          <PlanStoreSection
            key={`${assignment.store}-${assignment.location.address}`}
            index={i}
            assignment={assignment}
            onPressProduct={onPressProduct}
            ownerEmail={ownerEmail}
          />
        ))}
      </View>

      {explanation && <WhyThisPlanCard explanation={explanation} />}

      {unresolvedItems.length > 0 && (
        <View style={styles.notFoundCard}>
          <Text style={styles.notFoundTitle}>
            {unresolvedItems.length} item{unresolvedItems.length !== 1 ? 's' : ''} not found
          </Text>
          {/* Same universal grid PlanStoreSection.tsx uses — every item
              here has `product: null` by definition, so this only ever
              renders the honest fallback + real alternative-suggestion
              path, never a resolved-product card. */}
          <PlanItemProductGrid items={unresolvedItems} onPressProduct={onPressProduct} />
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
  budgetNote: { color: colors.green, fontSize: 12, fontWeight: '600', backgroundColor: colors.mint, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2 },
  budgetNoteOver: { color: '#92400E', backgroundColor: '#FFFBEB' },
  allProductsSection: { gap: spacing.sm + 2 },
  storeSection: { gap: spacing.sm + 2 },
  sectionTitle: { ...typography.cardTitle, fontSize: 14 },
  notFoundCard: { backgroundColor: '#FFFBEB', borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm },
  notFoundTitle: { color: '#78350F', fontWeight: '600', fontSize: 13.5 },
  // Phase 7.1 — underline removed in favor of color+weight, matching
  // every other toggle label in this app (ShoppingSessionPlanCard's
  // "Show store-by-store breakdown," HomeInsightsStrip's chips) —
  // underlined text reads as a dated web link, not a native affordance.
  reasoningToggle: { color: colors.green, fontSize: 12.5, fontWeight: '700' },
  reasoningCard: { backgroundColor: colors.panelBg, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm - 2 },
  reasoningText: { color: `${colors.charcoal}b3`, fontSize: 12 },
  reasoningDisclaimer: { color: `${colors.charcoal}73`, fontSize: 12, marginTop: spacing.xs },
  startButton: { backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: spacing.md + 2, minHeight: 50, alignItems: 'center', justifyContent: 'center' },
  startButtonText: { color: colors.white, fontWeight: '700', fontSize: 14.5 },
});
