import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AnimatedPressable } from '../AnimatedPressable';
import { PlanItemProductGrid } from './PlanItemProductGrid';
import type { ApiProduct, PlanStoreAssignment } from '../../models/types';
import { colors, storeAccents } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { spacing, radius } from '../../theme/metrics';

interface Props {
  index: number;
  assignment: PlanStoreAssignment;
  /** Optional — when provided (see PlanResultsView.tsx/ShoppingSessionPlanCard.tsx,
   * both of which have real navigation available), tapping a product card
   * opens it. Omitted call sites (e.g. AutoOptimizeSheet.tsx, a modal with
   * no navigation context) just don't navigate — never a fabricated
   * fallback destination. */
  onPressProduct?: (product: ApiProduct) => void;
  /** Optional (Phase 6 Part 5) — threaded straight through to
   * `PlanItemProductGrid` for real "why chosen" badges. See that file's
   * own header comment. */
  ownerEmail?: string;
}

/**
 * One store's card within the plan results — name/count/subtotal plus
 * this store's real product cards, expanded by default (Phase 7 P0-1:
 * a judge/shopper should see real products immediately, not after
 * manually expanding every store — collapsing was undermining this
 * app's own best demo moment). Collapse/expand is preserved as a
 * progressive-disclosure option, just no longer the default. Phase 5.5
 * Part 2: the actual card rendering lives entirely in
 * `PlanItemProductGrid` (the universal "Shopping Item Card Renderer" —
 * used identically by PlannerScreen and AssistantScreen) — this
 * component's only remaining job is the collapsible store-header chrome
 * (badge, name, subtotal, chevron).
 */
export function PlanStoreSection({ index, assignment, onPressProduct, ownerEmail }: Props) {
  const [expanded, setExpanded] = useState(true);
  const accent = storeAccents[assignment.store];

  return (
    <View style={styles.container}>
      <AnimatedPressable onPress={() => setExpanded(e => !e)} scaleTo={0.99} style={styles.header}>
        <View style={[styles.badge, { backgroundColor: accent.dot }]}>
          <Text style={styles.badgeText}>{index + 1}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.storeName}>{assignment.location.name}</Text>
          <Text style={styles.itemCount}>{assignment.items.length} item{assignment.items.length !== 1 ? 's' : ''}</Text>
        </View>
        <Text style={styles.subtotal}>${assignment.subtotal.toFixed(2)}</Text>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={`${colors.charcoal}66`} />
      </AnimatedPressable>

      {expanded && (
        <View style={styles.itemGridWrap}>
          <PlanItemProductGrid items={assignment.items} onPressProduct={onPressProduct} ownerEmail={ownerEmail} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { borderWidth: 1, borderColor: colors.borderGray, borderRadius: radius.lg, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md + 2 },
  badge: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: colors.white, fontWeight: '700', fontSize: 12 },
  storeName: { ...typography.cardTitle, fontSize: 14 },
  itemCount: { color: `${colors.charcoal}80`, fontSize: 12, marginTop: 1 },
  subtotal: { color: colors.charcoal, fontWeight: '800', fontSize: 14 },
  itemGridWrap: { padding: spacing.md, borderTopWidth: 1, borderTopColor: colors.borderGray },
});
