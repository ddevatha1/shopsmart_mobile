import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import type { ApiProduct } from '../models/types';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';
import { elevation, radius, spacing, surfaces } from '../theme/metrics';
import { duration, easing, staggerDelay } from '../theme/motion';
import { AnimatedPressable } from './AnimatedPressable';
import { ProductImage } from './ProductImage';
import { StoreLogo } from './StoreLogo';
import { isOrganicProduct } from '../utils/filterProducts';

/**
 * Mirrors CartIQ_web/src/components/ProductCard.tsx: store badge,
 * add-to-cart button with checkmark feedback, "Organic" badge,
 * price/discount, brand, name, star rating, size, and pickup/
 * delivery fulfillment badges. Tap interactions replace the web's hover
 * interactions (scale/shadow on hover → tap ripple + navigation).
 */
interface Props {
  product: ApiProduct;
  onPress: () => void;
  onAddToCart: () => void;
  /** Position within the results grid — staggers the entrance animation so
   * cards cascade in rather than popping in all at once. Optional; a card
   * rendered on its own (e.g. in a horizontal "related" rail) just omits it. */
  index?: number;
  /** Normalized comparison price (e.g. "$0.62 / apple") — shown as a
   * secondary line under the total price. Only ever set on the comparison
   * screen (see CompareScreen/comparisonService); every other caller omits
   * it and the card looks exactly as it always has. */
  unitPriceLabel?: string;
  /** Marks this as the comparison engine's single featured recommendation —
   * a subtle accent border plus a "Best Value" ribbon, not a new card. */
  bestValue?: boolean;
  /** Short savings callout (e.g. "Save $2.10") shown alongside the price —
   * only meaningful together with `bestValue`. */
  savingsLabel?: string;
  /** Phase 6 Part 5 — real, evidence-gated "why chosen" reasons (see
   * recommendationExplanationService.ts's `explainProductSelection`,
   * flattened to plain message strings by the caller). Capped to 2 here
   * purely for card space — the caller decides which real reasons to
   * pass, this component never invents or reorders them. Omitted by
   * every caller that hasn't computed a real explanation for this
   * product, which is the normal case and renders the card exactly as
   * it always has. */
  /* Phase 7.1 — capped to 1 here (was 2): three different mint-tinted
   * pill styles (savings, why-chosen, fulfillment) were all competing
   * for the same small card, all in the same color, all reading as the
   * same generic "tag" widget. Showing the single strongest real
   * reason keeps the card legible; ProductDetailScreen's own "Why
   * CartIQ chose this" block still shows the full evidence list. */
  whyChosenBadges?: string[];
  /** Real, on-device price-history signal (see priceHistoryService.ts's
   * `getStats`/`getStatsForMany`) — never shown for 'flat' (nothing
   * meaningful to say) or when there isn't enough real observed history
   * yet; omitted entirely by every caller that hasn't computed it, which
   * renders the card exactly as it always has. Folded into the existing
   * metaRow line rather than a new pill, per this card's own Phase 7.1
   * "one glance of secondary facts" rule. */
  priceTrend?: { trend: 'up' | 'down'; changePercent: number };
}

export function ProductCard({
  product, onPress, onAddToCart, index = 0, unitPriceLabel, bestValue, savingsLabel, whyChosenBadges, priceTrend,
}: Props) {
  const [cartFeedback, setCartFeedback] = useState(false);
  const cartFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (cartFeedbackTimeoutRef.current) clearTimeout(cartFeedbackTimeoutRef.current);
    };
  }, []);
  const isOrganic = isOrganicProduct(product);

  const entrance = useSharedValue(0);
  useEffect(() => {
    entrance.value = withDelay(
      staggerDelay(index),
      withTiming(1, { duration: duration.slow, easing: easing.standard }),
    );
  }, [entrance, index]);
  const entranceStyle = useAnimatedStyle(() => ({
    opacity: entrance.value,
    transform: [{ translateY: (1 - entrance.value) * 12 }],
  }));

  const confirmScale = useSharedValue(1);
  const confirmStyle = useAnimatedStyle(() => ({ transform: [{ scale: confirmScale.value }] }));

  const handleAddToCart = () => {
    onAddToCart();
    setCartFeedback(true);
    confirmScale.value = withSequence(
      withTiming(1.25, { duration: duration.micro, easing: easing.emphasized }),
      withTiming(1, { duration: duration.base, easing: easing.standard }),
    );
    if (cartFeedbackTimeoutRef.current) clearTimeout(cartFeedbackTimeoutRef.current);
    cartFeedbackTimeoutRef.current = setTimeout(() => setCartFeedback(false), 1500);
  };

  return (
    <Animated.View style={entranceStyle} layout={LinearTransition.duration(duration.base)}>
      <AnimatedPressable
        onPress={onPress}
        style={[styles.card, bestValue && styles.cardBestValue]}
        scaleTo={0.98}
        liftOnPress
      >
        {bestValue && (
          <View style={styles.bestValueRibbon}>
            <Ionicons name="trophy" size={12} color={colors.white} />
            <Text style={styles.bestValueRibbonText}>Best Value</Text>
          </View>
        )}
        <View style={styles.imageWrap}>
          <ProductImage product={product} style={StyleSheet.absoluteFill} />

          <StoreLogo store={product.store} height={20} width={40} style={styles.storeLogoBadge} />

          <AnimatedPressable
            onPress={handleAddToCart}
            style={[styles.addButton, { backgroundColor: cartFeedback ? colors.mint : colors.green }]}
            scaleTo={0.85}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel={cartFeedback ? 'Added to cart' : `Add ${product.name} to cart`}
          >
            <Animated.View style={confirmStyle}>
              <Ionicons name={cartFeedback ? 'checkmark' : 'add'} size={16} color={cartFeedback ? colors.green : colors.white} />
            </Animated.View>
          </AnimatedPressable>

          {isOrganic && (
            <View style={[styles.badge, styles.organicBadge]}>
              <Ionicons name="leaf" size={11} color={colors.green} />
              <Text style={styles.organicText}>Organic</Text>
            </View>
          )}
        </View>

        <View style={styles.body}>
          <View style={styles.priceRow}>
            <View style={styles.priceTag}>
              <Text style={styles.priceText}>{typeof product.price === 'number' ? `$${product.price.toFixed(2)}` : '—'}</Text>
            </View>
            {typeof product.originalPrice === 'number' && (
              <Text style={styles.originalPrice}>${product.originalPrice.toFixed(2)}</Text>
            )}
            {product.discountPercent != null && product.discountPercent > 0 && (
              <Text style={styles.discount}>{product.discountPercent}% off</Text>
            )}
          </View>

          {(unitPriceLabel || savingsLabel) && (
            <View style={styles.comparisonRow}>
              {unitPriceLabel && <Text style={styles.unitPrice}>{unitPriceLabel}</Text>}
              {savingsLabel && (
                <View style={styles.savingsChip}>
                  <Text style={styles.savingsChipText}>{savingsLabel}</Text>
                </View>
              )}
            </View>
          )}

          {whyChosenBadges && whyChosenBadges.length > 0 && (
            <View style={styles.whyChosenBadge}>
              <Ionicons name="checkmark-circle" size={10} color={colors.green} />
              <Text style={styles.whyChosenText} numberOfLines={1}>{whyChosenBadges[0]}</Text>
            </View>
          )}

          {!!product.brand && (
            <Text style={styles.brand} numberOfLines={1}>
              {product.brand.toUpperCase()}
            </Text>
          )}
          <Text style={styles.name} numberOfLines={2}>
            {product.name}
          </Text>

          {/* Phase 7.1 — rating, size, and fulfillment collapsed onto one
              plain metadata line instead of a star row + a caption line
              + a row of colored pill chips: three visually different
              treatments for what is, to a shopper, one glance of
              "secondary facts." Removes two repeated mint-pill chips
              without losing any information. */}
          <View style={styles.metaRow}>
            <StarRating rating={product.rating} />
            {(!!product.size || product.pickupAvailable || product.deliveryAvailable) && (
              <Text style={styles.metaText} numberOfLines={1}>
                {[product.size, product.pickupAvailable && 'Pickup', product.deliveryAvailable && 'Delivery']
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            )}
            {priceTrend && (
              <Text style={[styles.trendText, { color: priceTrend.trend === 'down' ? colors.green : '#B45309' }]}>
                {priceTrend.trend === 'down' ? '▼' : '▲'} {Math.abs(priceTrend.changePercent)}%
              </Text>
            )}
          </View>
        </View>
      </AnimatedPressable>
    </Animated.View>
  );
}

function StarRating({ rating }: { rating: number }) {
  const full = Math.floor(rating);
  const half = rating - full >= 0.5;
  const empty = Math.max(0, 5 - full - (half ? 1 : 0));
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <Text style={styles.stars}>{'★'.repeat(full)}{half ? '⯨' : ''}{'☆'.repeat(empty)}</Text>
      <Text style={styles.ratingNum}>{rating.toFixed(1)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // Phase 7.1 — border only, no shadow: in a dense 2-column grid,
  // several adjacent drop shadows read as visual noise/mud, while a
  // single hairline border cleanly separates neighboring cards. This is
  // the one place in the app that deliberately keeps a border instead
  // of switching to elevation — a tight grid is a genuinely different
  // context from a single standalone card in a vertical stack.
  card: { flex: 1, ...surfaces.bordered, overflow: 'hidden' },
  cardBestValue: {
    borderColor: colors.green,
    borderWidth: 1.5,
  },
  bestValueRibbon: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: colors.green,
    paddingVertical: 5,
  },
  bestValueRibbonText: { color: colors.white, fontSize: 11, fontWeight: '700', letterSpacing: 0.2 },
  imageWrap: {
    aspectRatio: 1,
    backgroundColor: colors.imageBackground,
    position: 'relative',
  },
  badge: {
    position: 'absolute',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  storeLogoBadge: {
    position: 'absolute',
    top: spacing.sm,
    left: spacing.sm,
    ...elevation.low,
  },
  addButton: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    ...elevation.medium,
  },
  organicBadge: {
    bottom: spacing.sm,
    left: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.9)',
    gap: 3,
  },
  organicText: { color: colors.green, fontSize: 9.5, fontWeight: '600' },
  body: { padding: spacing.md, gap: 4 },
  priceRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  priceTag: { backgroundColor: colors.priceBadge, paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.sm },
  priceText: { color: colors.white, fontWeight: '800', fontSize: 14 },
  originalPrice: { color: `${colors.charcoal}66`, textDecorationLine: 'line-through', fontSize: 12 },
  discount: { color: colors.green, fontWeight: '700', fontSize: 11 },
  comparisonRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 1 },
  whyChosenBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start',
    backgroundColor: colors.mint, borderRadius: radius.sm, paddingHorizontal: 6, paddingVertical: 3, marginTop: 3,
  },
  whyChosenText: { color: colors.green, fontSize: 10, fontWeight: '700', flexShrink: 1 },
  unitPrice: { color: colors.green, fontWeight: '700', fontSize: 12 },
  savingsChip: { backgroundColor: colors.mint, paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.sm },
  savingsChipText: { color: colors.green, fontSize: 10, fontWeight: '700' },
  brand: { ...typography.overline, color: `${colors.charcoal}73` },
  name: { ...typography.cardTitle },
  stars: { color: colors.amber, fontSize: 10.5 },
  ratingNum: { color: `${colors.charcoal}66`, fontSize: 10.5 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
  trendText: { fontSize: 10.5, fontWeight: '700' },
  metaText: { ...typography.caption, flexShrink: 1 },
});
