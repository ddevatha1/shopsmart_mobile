import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AnimatedPressable } from '../AnimatedPressable';
import type { PlanStoreAssignment } from '../../models/types';
import { colors, storeAccents } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { spacing, radius } from '../../theme/metrics';

interface Props {
  index: number;
  assignment: PlanStoreAssignment;
}

/** One store's card within the plan results — collapsed to name/count/
 * subtotal by default (progressive disclosure), expandable to the full
 * item list. Mirrors shopsmart_web's PlanStoreSection.tsx; visual pattern
 * borrowed from RouteScreen's StopCard. */
export function PlanStoreSection({ index, assignment }: Props) {
  const [expanded, setExpanded] = useState(false);
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
        <View style={styles.itemList}>
          {assignment.items.map(line => (
            <View key={line.listItemId} style={styles.itemRow}>
              <Text style={styles.itemName} numberOfLines={1}>{line.product?.name ?? line.rawText}</Text>
              <Text style={styles.itemPrice}>{typeof line.product?.price === 'number' ? `$${line.product.price.toFixed(2)}` : '—'}</Text>
            </View>
          ))}
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
  itemList: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.sm, borderTopWidth: 1, borderTopColor: colors.borderGray, paddingTop: spacing.md },
  itemRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  itemName: { flex: 1, color: `${colors.charcoal}bf`, fontSize: 13 },
  itemPrice: { color: `${colors.charcoal}99`, fontSize: 13, fontWeight: '500' },
});
