import React, { useEffect, useState } from 'react';
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
import { colors, storeAccents } from '../theme/colors';
import { typography } from '../theme/typography';
import { elevation, radius, spacing } from '../theme/metrics';
import { duration, easing, staggerDelay } from '../theme/motion';
import { AnimatedPressable } from './AnimatedPressable';
import { ProductImage } from './ProductImage';
import { isOrganicProduct } from '../utils/filterProducts';

/**
 * Mirrors shopsmart_web/src/components/ProductCard.tsx: store badge,
 * add-to-cart button with checkmark feedback, "Live" badge, "Organic"
 * badge, price/discount, brand, name, star rating, size, and pickup/
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
}

export function ProductCard({
  product, onPress, onAddToCart, index = 0, unitPriceLabel, bestValue, savingsLabel,
}: Props) {
  const [cartFeedback, setCartFeedback] = useState(false);
  const accent = storeAccents[product.store];
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
    setTimeout(() => setCartFeedback(false), 1500);
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

          <View style={[styles.badge, { top: spacing.sm, left: spacing.sm, backgroundColor: accent.background }]}>
            <Text style={[styles.badgeText, { color: accent.text }]}>{product.store}</Text>
          </View>

          <AnimatedPressable
            onPress={handleAddToCart}
            style={[styles.addButton, { backgroundColor: cartFeedback ? colors.mint : colors.green }]}
            scaleTo={0.85}
          >
            <Animated.View style={confirmStyle}>
              <Ionicons name={cartFeedback ? 'checkmark' : 'add'} size={16} color={cartFeedback ? colors.green : colors.white} />
            </Animated.View>
          </AnimatedPressable>

          {product.isLiveData && (
            <View style={[styles.badge, styles.liveBadge]}>
              <View style={styles.liveDot} />
              <Text style={styles.liveText}>LIVE</Text>
            </View>
          )}

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
              <Text style={styles.priceText}>${product.price.toFixed(2)}</Text>
            </View>
            {product.originalPrice != null && (
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

          <Text style={styles.brand} numberOfLines={1}>
            {product.brand.toUpperCase()}
          </Text>
          <Text style={styles.name} numberOfLines={2}>
            {product.name}
          </Text>

          <StarRating rating={product.rating} />

          {!!product.size && <Text style={styles.size}>{product.size}</Text>}

          {(product.pickupAvailable || product.deliveryAvailable) && (
            <View style={styles.fulfillRow}>
              {product.pickupAvailable && (
                <View style={styles.fulfillChip}>
                  <Text style={styles.fulfillText}>Pickup</Text>
                </View>
              )}
              {product.deliveryAvailable && (
                <View style={styles.fulfillChip}>
                  <Text style={styles.fulfillText}>Delivery</Text>
                </View>
              )}
            </View>
          )}
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
  card: {
    flex: 1,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderGray,
    overflow: 'hidden',
    ...elevation.low,
  },
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
  badgeText: { ...typography.caption, fontWeight: '600', color: colors.charcoal },
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
  liveBadge: {
    bottom: spacing.sm,
    right: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(5,150,105,0.9)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    gap: 4,
  },
  liveDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.white },
  liveText: { color: colors.white, fontSize: 8.5, fontWeight: '800', letterSpacing: 0.5 },
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
  unitPrice: { color: colors.green, fontWeight: '700', fontSize: 12 },
  savingsChip: { backgroundColor: colors.mint, paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.sm },
  savingsChipText: { color: colors.green, fontSize: 10, fontWeight: '700' },
  brand: { ...typography.overline, color: `${colors.charcoal}73` },
  name: { ...typography.cardTitle },
  stars: { color: colors.amber, fontSize: 10.5 },
  ratingNum: { color: `${colors.charcoal}66`, fontSize: 10.5 },
  size: { ...typography.caption },
  fulfillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 2 },
  fulfillChip: { backgroundColor: colors.mint, paddingHorizontal: 7, paddingVertical: 3, borderRadius: radius.pill },
  fulfillText: { color: colors.green, fontSize: 9.5, fontWeight: '600' },
});
