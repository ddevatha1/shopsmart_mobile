import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AdvisorInsight, AdvisorInsightKind } from '../services/advisorService';
import type { ApiProduct } from '../models/types';
import { RecommendationActions } from './RecommendationActions';
import { colors } from '../theme/colors';
import { spacing, radius } from '../theme/metrics';

interface Props {
  insight: AdvisorInsight;
  /** Only called when `insight.product` and `insight.actions` include the
   * corresponding action — see RecommendationActions. */
  onSeeProduct?: (product: ApiProduct) => void;
  onAddToCart?: (product: ApiProduct) => void;
  style?: StyleProp<ViewStyle>;
}

const KIND_META: Record<AdvisorInsightKind, { icon: keyof typeof Ionicons.glyphMap; color: string }> = {
  'worth-the-stop': { icon: 'trending-up-outline', color: colors.green },
  'skip-the-stop': { icon: 'information-circle-outline', color: '#B45309' },
  pantry: { icon: 'time-outline', color: '#0369A1' },
  deal: { icon: 'pricetag-outline', color: colors.green },
  budget: { icon: 'wallet-outline', color: '#B45309' },
  'well-optimized': { icon: 'checkmark-circle-outline', color: colors.green },
  'comparison-tip': { icon: 'analytics-outline', color: colors.green },
};

/**
 * The single, shared "Smart Shopping Advisor" card — every intelligent
 * recommendation in the app (worth-the-extra-stop, pantry reminders,
 * deals, budget warnings) renders through this exact component, never a
 * bespoke widget per feature. One consistent shape (icon + headline +
 * optional detail line) is what keeps five different signals from ever
 * reading as five different UI languages bolted onto the app.
 */
export function AdvisorCard({ insight, onSeeProduct, onAddToCart, style }: Props) {
  const meta = KIND_META[insight.kind];
  const product = insight.product;
  const actions = insight.actions ?? [];

  return (
    <View style={[styles.card, style]}>
      <View style={[styles.iconCircle, { backgroundColor: `${meta.color}1A` }]}>
        <Ionicons name={meta.icon} size={18} color={meta.color} />
      </View>
      <View style={styles.textCol}>
        <Text style={styles.title}>{insight.title}</Text>
        {insight.detail && <Text style={styles.detail}>{insight.detail}</Text>}
        {product && (
          <RecommendationActions
            onSeeProduct={actions.includes('see-product') && onSeeProduct ? () => onSeeProduct(product) : undefined}
            onAddToCart={actions.includes('add-to-cart') && onAddToCart ? () => onAddToCart(product) : undefined}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.borderGray,
    borderRadius: radius.lg,
    padding: spacing.md + 2,
  },
  iconCircle: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textCol: { flex: 1, gap: 2 },
  title: { color: colors.charcoal, fontWeight: '700', fontSize: 13.5, lineHeight: 18 },
  detail: { color: `${colors.charcoal}99`, fontSize: 12, lineHeight: 16 },
});
