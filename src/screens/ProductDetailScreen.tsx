import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCartStore } from '../store/cartStore';
import { colors, storeAccents } from '../theme/colors';
import { ProductImage } from '../components/ProductImage';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { RecommendationActions } from '../components/RecommendationActions';
import { AccordionSection } from '../components/filters/AccordionSection';
import { duration, easing } from '../theme/motion';
import { isOrganicProduct } from '../utils/filterProducts';
import { getCurrentCoordinates } from '../services/locationService';
import { haversineDistanceMiles, formatMiles } from '../utils/geo';
import { getStats, type PriceStats } from '../services/priceHistoryService';
import { findSubstitution, type Substitution } from '../services/substitutionService';
import { getPersonalizationProfile, type PersonalizationProfile } from '../services/personalizationService';
import { useUserStore } from '../store/userStore';
import { spacing, radius } from '../theme/metrics';
import type { RootStackParamList } from '../navigation/types';
import type { ApiProduct } from '../models/types';

type Props = NativeStackScreenProps<RootStackParamList, 'ProductDetail'>;

/** Mirrors shopsmart_web/src/components/ProductModal.tsx. The web modal
 * (dialog overlay) becomes a full-screen pushed page on mobile per the
 * instructions ("Desktop modal → Bottom sheet or full-screen page") — a
 * full page was chosen over a bottom sheet because this content is dense
 * (related products carousel, expandable sections, quantity stepper) and
 * benefits from a proper back-button/gesture rather than a partial sheet. */
export function ProductDetailScreen({ route, navigation }: Props) {
  const { product, allProducts } = route.params;
  const [qty, setQty] = useState(1);
  const [addedFeedback, setAddedFeedback] = useState(false);
  const [distanceMiles, setDistanceMiles] = useState<number | null>(null);
  const addToCart = useCartStore((s) => s.addToCart);
  const addedFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (addedFeedbackTimeoutRef.current) clearTimeout(addedFeedbackTimeoutRef.current);
    };
  }, []);

  const storeLat = product.location?.latitude;
  const storeLng = product.location?.longitude;
  useEffect(() => {
    if (storeLat == null || storeLng == null) return;
    let cancelled = false;
    getCurrentCoordinates().then((coords) => {
      if (cancelled || !coords) return;
      setDistanceMiles(haversineDistanceMiles(coords, { latitude: storeLat, longitude: storeLng }));
    });
    return () => {
      cancelled = true;
    };
  }, [storeLat, storeLng]);

  const accent = storeAccents[product.store];
  const isOrganic = isOrganicProduct(product);
  const perUnit = calcPerUnit(product.price, product.size);
  const saleEndsIn = product.discountPercent != null ? saleEndsDays(product.id) : null;
  const related = allProducts.filter((p) => p.id !== product.id && p.store === product.store).slice(0, 4);

  // Real, on-device price history for this exact product/store (see
  // priceHistoryService) — null (and so hidden entirely) until there are
  // at least two real observations to say anything true about.
  const [priceStats, setPriceStats] = useState<PriceStats | null>(null);
  useEffect(() => {
    let cancelled = false;
    getStats(product).then((stats) => {
      if (!cancelled) setPriceStats(stats);
    });
    return () => {
      cancelled = true;
    };
  }, [product]);

  // Real, silently-learned shopping preferences (personalizationService) —
  // biases which alternative gets suggested first, never anything the
  // shopper configured directly.
  const ownerEmail = useUserStore((s) => s.user?.email ?? '');
  const [profile, setProfile] = useState<PersonalizationProfile | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    if (!ownerEmail) return;
    getPersonalizationProfile(ownerEmail).then((p) => {
      if (!cancelled) setProfile(p);
    });
    return () => {
      cancelled = true;
    };
  }, [ownerEmail]);

  // A genuinely better alternative from the same search response, if one
  // exists — never shown when this product is already the good choice.
  const substitution = useMemo(() => findSubstitution(product, allProducts, profile), [product, allProducts, profile]);

  const entrance = useSharedValue(0);
  useEffect(() => {
    entrance.value = withTiming(1, { duration: duration.slow, easing: easing.standard });
  }, [entrance]);
  const entranceStyle = useAnimatedStyle(() => ({
    opacity: entrance.value,
    transform: [{ translateY: (1 - entrance.value) * 16 }],
  }));

  const handleAddToCart = () => {
    addToCart(product, qty);
    setAddedFeedback(true);
    if (addedFeedbackTimeoutRef.current) clearTimeout(addedFeedbackTimeoutRef.current);
    addedFeedbackTimeoutRef.current = setTimeout(() => setAddedFeedback(false), 2000);
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.white }} contentContainerStyle={{ paddingBottom: 32 }}>
      <View style={styles.imageWrap}>
        <ProductImage product={product} iconSize={72} />
        <View style={[styles.storeBadge, { backgroundColor: accent.background }]}>
          <Text style={{ color: accent.text, fontSize: 12, fontWeight: '600' }}>{product.store}</Text>
        </View>
        <AnimatedPressable
          onPress={() => navigation.goBack()}
          style={styles.closeButton}
          scaleTo={0.9}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityLabel="Close"
        >
          <Ionicons name="close" size={18} color={colors.charcoal} />
        </AnimatedPressable>
        {isOrganic && (
          <View style={styles.organicBadge}>
            <Ionicons name="leaf" size={14} color={colors.green} />
            <Text style={{ color: colors.green, fontSize: 12, fontWeight: '600', marginLeft: 4 }}>Organic</Text>
          </View>
        )}
      </View>

      <Animated.View style={[styles.content, entranceStyle]}>
        <StarRatingRow rating={product.rating} count={product.reviewCount} />
        <Text style={styles.name}>{product.name}</Text>
        {!!product.upc && <Text style={styles.upc}>UPC: {product.upc}</Text>}
        {(product.size || perUnit) && (
          <Text style={styles.sizeLine}>{[product.size, perUnit].filter(Boolean).join(' • ')}</Text>
        )}

        {product.certifications && product.certifications.length > 0 && (
          <View style={{ marginTop: 16 }}>
            <Text style={styles.sectionLabel}>Product information</Text>
            <View style={styles.certRow}>
              {product.certifications.map((cert) => (
                <View key={cert} style={styles.certChip}>
                  <Ionicons name="checkmark-circle" size={13} color={colors.green} />
                  <Text style={styles.certText}>{cert}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        <View style={styles.priceBox}>
          <View style={styles.priceRow}>
            <View style={styles.priceTag}>
              <Text style={styles.priceText}>{typeof product.price === 'number' ? `$${product.price.toFixed(2)}` : 'Price unavailable'}</Text>
            </View>
            {typeof product.originalPrice === 'number' && (
              <Text style={styles.originalPrice}>${product.originalPrice.toFixed(2)}</Text>
            )}
            {product.discountPercent != null && (
              <Text style={styles.discount}>{product.discountPercent}% off</Text>
            )}
          </View>
          {saleEndsIn != null && (
            <Text style={styles.saleEnds}>Sale ends in {saleEndsIn} day{saleEndsIn !== 1 ? 's' : ''}</Text>
          )}

          <View style={styles.qtyRow}>
            <Text style={styles.qtyLabel}>Qty:</Text>
            <View style={styles.stepper}>
              <AnimatedPressable
                onPress={() => setQty((q) => Math.max(1, q - 1))}
                style={styles.stepperButton}
                scaleTo={0.9}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="remove" size={16} color={`${colors.charcoal}b3`} />
              </AnimatedPressable>
              <Text style={styles.qtyValue}>{qty}</Text>
              <AnimatedPressable
                onPress={() => setQty((q) => q + 1)}
                style={styles.stepperButton}
                scaleTo={0.9}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="add" size={16} color={`${colors.charcoal}b3`} />
              </AnimatedPressable>
            </View>
          </View>

          <AnimatedPressable
            onPress={handleAddToCart}
            style={[styles.addToCartButton, addedFeedback && { backgroundColor: colors.mint }]}
          >
            <Text style={[styles.addToCartText, addedFeedback && { color: colors.green }]}>
              {addedFeedback ? '✓ Added to Cart' : 'Add to Cart'}
            </Text>
          </AnimatedPressable>
        </View>

        {priceStats && <PriceHistoryBlock stats={priceStats} />}

        {substitution && (
          <SubstitutionBox
            substitution={substitution}
            onSeeProduct={() => navigation.push('ProductDetail', { product: substitution.product, allProducts })}
            onAddToCart={() => addToCart(substitution.product)}
          />
        )}

        <View style={styles.accordionGroup}>
          <AccordionSection title="Details" defaultExpanded>
            <DetailRow label="Brand" value={product.brand} />
            <DetailRow label="Size" value={product.size} />
            {!!product.upc && <DetailRow label="UPC" value={product.upc} />}
            <DetailRow label="Available at" value={product.store} />
          </AccordionSection>

          <AccordionSection title="Store Location" defaultExpanded>
            {product.location ? (
              <View style={styles.storeLocationRow}>
                <View style={[styles.storeLocationDot, { backgroundColor: accent.dot }]} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.storeLocationName}>{product.location.name}</Text>
                  <Text style={styles.storeLocationAddress}>{product.location.address}</Text>
                  <Text style={styles.storeLocationAddress}>
                    {product.location.city}, {product.location.state} {product.location.zip}
                  </Text>
                  {distanceMiles != null && (
                    <Text style={styles.storeLocationDistance}>{formatMiles(distanceMiles)} away</Text>
                  )}
                  {product.location.latitude != null && product.location.longitude != null && (
                    <Text style={styles.storeLocationCoords}>
                      {product.location.latitude.toFixed(5)}, {product.location.longitude.toFixed(5)}
                    </Text>
                  )}
                </View>
              </View>
            ) : (
              // Never guess an address — if this store's real location
              // couldn't be resolved, say so explicitly rather than
              // silently hiding the section or showing stale/wrong data.
              <View style={styles.storeLocationRow}>
                <Ionicons name="location-outline" size={18} color={`${colors.charcoal}a6`} />
                <Text style={[styles.storeLocationAddress, { flex: 1 }]}>
                  Location unavailable for this store right now.
                </Text>
              </View>
            )}
          </AccordionSection>
        </View>

        {related.length > 0 && (
          <View style={{ marginTop: 20 }}>
            <Text style={styles.relatedTitle}>Picked For You</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12, marginTop: 12 }}>
              {related.map((p) => (
                <RelatedCard key={p.id} product={p} onAddToCart={() => addToCart(p)} onPress={() => navigation.push('ProductDetail', { product: p, allProducts: [] })} />
              ))}
            </ScrollView>
          </View>
        )}
      </Animated.View>
    </ScrollView>
  );
}

function StarRatingRow({ rating, count }: { rating: number; count?: number }) {
  const full = Math.floor(rating);
  const half = rating - full >= 0.5;
  const empty = Math.max(0, 5 - full - (half ? 1 : 0));
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
      <Text style={{ color: colors.amber, fontSize: 14 }}>{'★'.repeat(full)}{half ? '⯨' : ''}{'☆'.repeat(empty)}</Text>
      <Text style={{ fontWeight: '600', fontSize: 13.5 }}>{rating.toFixed(1)}</Text>
      {count != null && <Text style={{ color: `${colors.charcoal}66`, fontSize: 13 }}>({count})</Text>}
    </View>
  );
}

const SPARK_BAR_MIN_HEIGHT = 6;
const SPARK_BAR_MAX_HEIGHT = 28;

/** Compact price-history summary — current/average/lowest plus a small
 * bar sparkline built from plain Views (no charting library needed for
 * ten data points). Only ever rendered once priceStats exists, i.e. once
 * this device has genuinely observed the product at least twice. */
function PriceHistoryBlock({ stats }: { stats: PriceStats }) {
  const min = Math.min(...stats.sparkline);
  const max = Math.max(...stats.sparkline);
  const range = max - min || 1;
  const trendColor = stats.trend === 'down' ? colors.green : stats.trend === 'up' ? '#B91C1C' : `${colors.charcoal}66`;

  return (
    <View style={styles.priceHistoryBox}>
      <View style={styles.priceHistoryHeader}>
        <Ionicons name="stats-chart-outline" size={14} color={colors.charcoal} />
        <Text style={styles.priceHistoryTitle}>Price History</Text>
        {stats.trend !== 'flat' && (
          <View style={styles.trendChip}>
            <Ionicons name={stats.trend === 'down' ? 'arrow-down' : 'arrow-up'} size={10} color={trendColor} />
            <Text style={[styles.trendText, { color: trendColor }]}>{Math.abs(stats.changePercent)}% vs average</Text>
          </View>
        )}
      </View>

      {stats.sparkline.length > 2 && (
        <View style={styles.sparklineRow}>
          {stats.sparkline.map((price, i) => (
            <View
              key={i}
              style={[
                styles.sparkBar,
                { height: SPARK_BAR_MIN_HEIGHT + ((price - min) / range) * (SPARK_BAR_MAX_HEIGHT - SPARK_BAR_MIN_HEIGHT) },
              ]}
            />
          ))}
        </View>
      )}

      <View style={styles.priceStatsRow}>
        <PriceStat label="Current" value={stats.current} />
        <PriceStat label="Average" value={stats.average} />
        <PriceStat label="Lowest" value={stats.lowest} />
      </View>
    </View>
  );
}

function PriceStat({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.priceStat}>
      <Text style={styles.priceStatValue}>${value.toFixed(2)}</Text>
      <Text style={styles.priceStatLabel}>{label}</Text>
    </View>
  );
}

// A substitute is "an obvious recommended purchase" per the brief's own
// categorization — it gets both actions: a quick direct add, or a look at
// the full product page first. Explicit buttons rather than a
// whole-card tap so the two intents (glance vs. commit) aren't collapsed
// into one ambiguous gesture.
function SubstitutionBox({ substitution, onSeeProduct, onAddToCart }: {
  substitution: Substitution;
  onSeeProduct: () => void;
  onAddToCart: () => void;
}) {
  return (
    <View style={styles.substitutionBox}>
      <Ionicons name="swap-horizontal-outline" size={18} color={colors.green} />
      <View style={{ flex: 1 }}>
        <Text style={styles.substitutionTitle}>Try {substitution.product.name} instead</Text>
        <Text style={styles.substitutionReason}>{substitution.reason}</Text>
        <RecommendationActions onSeeProduct={onSeeProduct} onAddToCart={onAddToCart} />
      </View>
    </View>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <Text style={{ color: `${colors.charcoal}a6`, fontSize: 13, marginBottom: 4 }}>
      <Text style={{ color: `${colors.charcoal}d9`, fontWeight: '500' }}>{label}: </Text>
      {value}
    </Text>
  );
}

function RelatedCard({ product, onAddToCart, onPress }: { product: ApiProduct; onAddToCart: () => void; onPress: () => void }) {
  return (
    <AnimatedPressable onPress={onPress} style={styles.relatedCard} scaleTo={0.97}>
      <View style={styles.relatedImageWrap}>
        <ProductImage product={product} iconSize={28} />
        <AnimatedPressable
          onPress={onAddToCart}
          style={styles.relatedAddButton}
          scaleTo={0.85}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="add" size={14} color={colors.white} />
        </AnimatedPressable>
      </View>
      <View style={{ padding: 8 }}>
        <Text numberOfLines={2} style={{ fontSize: 11.5, fontWeight: '600' }}>{product.name}</Text>
        <Text style={{ color: colors.green, fontWeight: '700', fontSize: 12.5, marginTop: 3 }}>
          {typeof product.price === 'number' ? `$${product.price.toFixed(2)}` : 'Price unavailable'}
        </Text>
      </View>
    </AnimatedPressable>
  );
}

// ── Ported helpers (exact web logic) ──────────────────────────────────────

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function saleEndsDays(productId: string): number {
  return 2 + (hashCode(productId) % 10);
}

function calcPerUnit(price: number, size: string): string | null {
  const match = size.match(/(\d+(?:\.\d+)?)\s*(ct|count|oz|fl oz|lb|lbs|kg|g)/i);
  if (!match) return null;
  const qty = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (!(qty > 0)) return null;
  return `$${(price / qty).toFixed(2)} / ${unit}`;
}

const styles = StyleSheet.create({
  imageWrap: { aspectRatio: 1.1, backgroundColor: colors.imageBackground, position: 'relative' },
  storeBadge: { position: 'absolute', top: 50, left: 16, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  closeButton: {
    position: 'absolute', top: 46, right: 16, width: 32, height: 32, borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.08)', alignItems: 'center', justifyContent: 'center',
  },
  organicBadge: {
    position: 'absolute', bottom: 16, left: 16, flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.9)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
  },
  content: { padding: spacing.lg },
  name: { fontSize: 22, fontWeight: '700', color: colors.charcoal, lineHeight: 27, marginTop: spacing.xs },
  upc: { color: `${colors.charcoal}66`, fontSize: 11, marginTop: spacing.sm, fontFamily: 'monospace' },
  sizeLine: { color: `${colors.charcoal}99`, fontSize: 13.5, marginTop: spacing.sm },
  sectionLabel: { fontWeight: '600', fontSize: 13.5, color: colors.charcoal, marginBottom: spacing.sm },
  certRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  certChip: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.mint, paddingHorizontal: spacing.md, paddingVertical: spacing.xs + 2, borderRadius: radius.pill, gap: spacing.xs },
  certText: { color: colors.green, fontSize: 12, fontWeight: '600' },
  priceBox: { backgroundColor: colors.panelBg, borderWidth: 1, borderColor: colors.borderGray, borderRadius: radius.lg, padding: spacing.lg, marginTop: spacing.xl },
  priceRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm + 2 },
  priceTag: { backgroundColor: colors.priceBadge, paddingHorizontal: spacing.md + 2, paddingVertical: spacing.sm, borderRadius: radius.md },
  priceText: { color: colors.white, fontWeight: '800', fontSize: 22 },
  originalPrice: { color: `${colors.charcoal}66`, textDecorationLine: 'line-through', fontSize: 15 },
  discount: { color: colors.green, fontWeight: '700', fontSize: 13 },
  saleEnds: { color: `${colors.charcoal}80`, fontSize: 11.5, marginTop: spacing.sm },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.md + 2 },
  qtyLabel: { color: `${colors.charcoal}99`, fontSize: 13.5 },
  stepper: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#E5E7EB', borderRadius: radius.md, backgroundColor: colors.white },
  stepperButton: { padding: spacing.sm, minWidth: 40, minHeight: 40, alignItems: 'center', justifyContent: 'center' },
  qtyValue: { width: 24, textAlign: 'center', fontWeight: '600', fontSize: 13 },
  addToCartButton: { backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: spacing.md + 2, minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: spacing.md + 2 },
  addToCartText: { color: colors.white, fontWeight: '600', fontSize: 14 },
  priceHistoryBox: {
    backgroundColor: colors.white, borderWidth: 1, borderColor: colors.borderGray,
    borderRadius: radius.lg, padding: spacing.md + 2, marginTop: spacing.md,
  },
  priceHistoryHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs + 2 },
  priceHistoryTitle: { fontWeight: '700', fontSize: 12.5, color: colors.charcoal, flex: 1 },
  trendChip: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  trendText: { fontSize: 11, fontWeight: '600' },
  sparklineRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: SPARK_BAR_MAX_HEIGHT, marginTop: spacing.sm },
  sparkBar: { flex: 1, backgroundColor: colors.mint, borderRadius: 2, minHeight: SPARK_BAR_MIN_HEIGHT },
  priceStatsRow: { flexDirection: 'row', justifyContent: 'space-around', marginTop: spacing.md, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.borderGray },
  priceStat: { alignItems: 'center', gap: 1 },
  priceStatValue: { fontWeight: '700', fontSize: 13, color: colors.charcoal },
  priceStatLabel: { fontSize: 10.5, color: `${colors.charcoal}80` },
  substitutionBox: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    backgroundColor: colors.mint, borderRadius: radius.lg, padding: spacing.md + 2, marginTop: spacing.md,
  },
  substitutionTitle: { fontWeight: '700', fontSize: 12.5, color: colors.charcoal },
  substitutionReason: { fontSize: 11.5, color: `${colors.charcoal}99`, marginTop: 2 },
  accordionGroup: { marginTop: spacing.sm },
  storeLocationRow: { flexDirection: 'row', gap: spacing.md },
  storeLocationDot: { width: 10, height: 10, borderRadius: 5, marginTop: 4 },
  storeLocationName: { color: colors.charcoal, fontWeight: '600', fontSize: 13.5, marginBottom: 2 },
  storeLocationAddress: { color: `${colors.charcoal}a6`, fontSize: 13, lineHeight: 18 },
  storeLocationDistance: { color: colors.green, fontWeight: '600', fontSize: 12.5, marginTop: 6 },
  storeLocationCoords: { color: `${colors.charcoal}59`, fontSize: 10.5, marginTop: 4, fontFamily: 'monospace' },
  relatedTitle: { fontWeight: '700', fontSize: 15, color: colors.charcoal },
  relatedCard: { width: 128, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.borderGray, borderRadius: 14, overflow: 'hidden' },
  relatedImageWrap: { aspectRatio: 1, backgroundColor: colors.imageBackground, position: 'relative' },
  relatedAddButton: {
    position: 'absolute', top: 6, right: 6, width: 24, height: 24, borderRadius: 12,
    backgroundColor: colors.green, alignItems: 'center', justifyContent: 'center',
  },
});
