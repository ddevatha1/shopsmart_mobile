import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SectionList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import type { CartItem, StoreName, TripPlan } from '../models/types';
import { cartItemCount, cartTotal, useCartStore } from '../store/cartStore';
import { useSearchStore } from '../store/searchStore';
import { useUserStore } from '../store/userStore';
import { groupCartByStore, locationKey } from '../utils/groupCartByStore';
import { planShoppingTrip } from '../services/tripService';
import { categorizeProduct, GROCERY_CATEGORIES, type GroceryCategory } from '../services/groceryCategoryService';
import { getCartInsight, type AdvisorInsight } from '../services/advisorService';
import { getCartSuggestions } from '../services/cartSuggestionService';
import { ProductImage } from '../components/ProductImage';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { AdvisorCard } from '../components/AdvisorCard';
import { colors, storeAccents } from '../theme/colors';
import { duration, easing } from '../theme/motion';
import { spacing, radius } from '../theme/metrics';
import type { RootStackParamList } from '../navigation/types';

/** Mirrors shopsmart_web/src/components/CartDrawer.tsx. The web slide-over
 * drawer becomes a persistent bottom-nav tab on mobile (per instructions:
 * "Desktop sidebar → Bottom navigation") since the cart is a primary
 * destination a shopper returns to repeatedly, not a transient overlay. */

export function CartScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const items = useCartStore((s) => s.items);
  const updateQty = useCartStore((s) => s.updateQty);
  const remove = useCartStore((s) => s.remove);
  const addToCart = useCartStore((s) => s.addToCart);
  const activeZip = useSearchStore((s) => s.activeZip);
  const user = useUserStore((s) => s.user);

  const zipcode = activeZip || user?.zipcode || '';
  const total = cartTotal(items);
  const uniqueStores = Array.from(new Set(items.map((i) => i.product.store)));

  const byStore = uniqueStores.map((store) => {
    const storeItems = items.filter((i) => i.product.store === store);
    return { store, items: storeItems, subtotal: storeItems.reduce((s, i) => s + i.product.price * i.quantity, 0) };
  });

  // Automatic cart organization — the checklist groups itself by grocery
  // aisle (Produce, Dairy, Meat, ...) via a real name-keyword classifier
  // (groceryCategoryService), not a manual control. Route planning keeps
  // grouping by physical store instead (see RouteScreen) — a different,
  // deliberately unchanged concern.
  const sections = useMemo(() => {
    const byCategory = new Map<GroceryCategory, CartItem[]>();
    for (const item of items) {
      const category = categorizeProduct(item.product);
      const list = byCategory.get(category) ?? [];
      list.push(item);
      byCategory.set(category, list);
    }
    return GROCERY_CATEGORIES
      .filter((c) => byCategory.has(c))
      .map((c) => ({ title: c, data: byCategory.get(c)! }));
  }, [items]);

  // Real StoreLocation groups (not just store names) — the same shape
  // RouteScreen uses, needed here to lazily preview the real route so the
  // Advisor can reference genuine driving time before "Start Route" is
  // ever tapped.
  const { groups } = useMemo(() => groupCartByStore(items), [items]);
  const routeSignature = useMemo(() => groups.map((g) => locationKey(g.location)).sort().join(','), [groups]);

  const [tripPreview, setTripPreview] = useState<TripPlan | null>(null);
  const fetchedSignature = useRef<string | null>(null);
  useEffect(() => {
    if (groups.length < 2) {
      // No setState here on purpose — evaluateExtraStop (advisorService)
      // already ignores `trip` whenever groups.length < 2, so a stale
      // preview from a since-shrunk cart is harmless and never read.
      fetchedSignature.current = null;
      return;
    }
    if (fetchedSignature.current === routeSignature) return;
    fetchedSignature.current = routeSignature;
    let cancelled = false;
    planShoppingTrip(groups.map((g) => g.location), zipcode)
      .then((trip) => {
        if (!cancelled) setTripPreview(trip);
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn('[CartScreen] trip preview failed:', err);
          setTripPreview(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [groups, routeSignature, zipcode]);

  // The Advisor's one Cart-screen slot: worth-the-extra-stop (once the
  // real trip preview above resolves), a budget warning, or nothing —
  // never more than one at a time. Renders progressively: the cart itself
  // never waits on this.
  const [advisorInsight, setAdvisorInsight] = useState<AdvisorInsight | null>(null);
  useEffect(() => {
    let cancelled = false;
    getCartInsight({ groups, trip: tripPreview, cartTotal: total, weeklyBudget: user?.weeklyBudget }).then((insight) => {
      if (!cancelled) setAdvisorInsight(insight);
    });
    return () => {
      cancelled = true;
    };
  }, [groups, tripPreview, total, user?.weeklyBudget]);

  const cartSuggestions = useMemo(() => getCartSuggestions(items), [items]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.white }} edges={['top']}>
      <View style={styles.header}>
        <Ionicons name="cart-outline" size={20} color={colors.green} />
        <Text style={styles.headerTitle}>Your Cart</Text>
        {items.length > 0 && (
          <View style={styles.headerBadge}>
            <Text style={styles.headerBadgeText}>{cartItemCount(items)}</Text>
          </View>
        )}
      </View>

      {items.length === 0 ? (
        <EmptyCart />
      ) : (
        <>
          <SectionList
            sections={sections}
            keyExtractor={(item) => item.product.id}
            contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.md }}
            stickySectionHeadersEnabled={false}
            ListHeaderComponent={
              (advisorInsight || cartSuggestions.length > 0) ? (
                <View style={styles.advisorSlot}>
                  {advisorInsight && (
                    <AdvisorCard
                      insight={advisorInsight}
                      onSeeProduct={(product) => navigation.navigate('ProductDetail', { product, allProducts: [] })}
                      onAddToCart={(product) => addToCart(product)}
                    />
                  )}
                  {cartSuggestions.length > 0 && (
                    <Text style={styles.suggestionText}>
                      You may also need {cartSuggestions.join(' and ')}.
                    </Text>
                  )}
                </View>
              ) : null
            }
            renderSectionHeader={({ section }) => (
              <Text style={styles.categoryHeader}>{section.title}</Text>
            )}
            renderItem={({ item }) => (
              <CartRow item={item} onUpdateQty={updateQty} onRemove={remove} />
            )}
            ItemSeparatorComponent={() => <View style={{ height: spacing.md }} />}
          />
          <CartFooter
            total={total}
            uniqueStoreCount={uniqueStores.length}
            zipcode={zipcode}
            byStore={byStore}
            onStartRoute={() => navigation.navigate('Route')}
          />
        </>
      )}
    </SafeAreaView>
  );
}

function EmptyCart() {
  const entrance = useSharedValue(0);
  useEffect(() => {
    entrance.value = withTiming(1, { duration: duration.slow, easing: easing.emphasized });
  }, [entrance]);
  const style = useAnimatedStyle(() => ({
    opacity: entrance.value,
    transform: [{ scale: 0.94 + entrance.value * 0.06 }],
  }));

  return (
    <Animated.View style={[styles.emptyContainer, style]}>
      <View style={styles.emptyCircle}>
        <Ionicons name="cart-outline" size={36} color={`${colors.green}66`} />
      </View>
      <Text style={styles.emptyTitle}>Your cart is empty</Text>
      <Text style={styles.emptyText}>Search for groceries and tap &quot;Add to Cart&quot; on any product.</Text>
    </Animated.View>
  );
}

function CartRow({ item, onUpdateQty, onRemove }: {
  item: CartItem;
  onUpdateQty: (id: string, qty: number) => void;
  onRemove: (id: string) => void;
}) {
  const accent = storeAccents[item.product.store];
  return (
    <Animated.View
      style={styles.row}
      entering={FadeIn.duration(duration.base)}
      exiting={FadeOut.duration(duration.base)}
      layout={LinearTransition.duration(duration.base)}
    >
      <View style={styles.thumb}>
        <ProductImage product={item.product} iconSize={20} />
      </View>
      <View style={styles.rowBody}>
        <Text numberOfLines={2} style={styles.itemName}>{item.product.name}</Text>
        <View style={[styles.storeChip, { backgroundColor: accent.background }]}>
          <Text style={{ color: accent.text, fontSize: 10, fontWeight: '600' }}>{item.product.store}</Text>
        </View>
        <View style={styles.stepperRow}>
          <AnimatedPressable
            style={styles.stepperButton}
            scaleTo={0.88}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            onPress={() => (item.quantity > 1 ? onUpdateQty(item.product.id, item.quantity - 1) : onRemove(item.product.id))}
            accessibilityLabel={item.quantity > 1 ? 'Decrease quantity' : `Remove ${item.product.name}`}
          >
            <Ionicons name="remove" size={13} color={`${colors.charcoal}b3`} />
          </AnimatedPressable>
          <Text style={styles.qtyText}>{item.quantity}</Text>
          <AnimatedPressable
            style={styles.stepperButton}
            scaleTo={0.88}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            onPress={() => onUpdateQty(item.product.id, item.quantity + 1)}
            accessibilityLabel="Increase quantity"
          >
            <Ionicons name="add" size={13} color={`${colors.charcoal}b3`} />
          </AnimatedPressable>
        </View>
      </View>
      <View style={styles.rowActions}>
        <Text style={styles.itemPrice}>${(item.product.price * item.quantity).toFixed(2)}</Text>
        <AnimatedPressable
          onPress={() => onRemove(item.product.id)}
          scaleTo={0.85}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityLabel={`Remove ${item.product.name}`}
        >
          <Ionicons name="trash-outline" size={17} color={`${colors.charcoal}4d`} />
        </AnimatedPressable>
      </View>
    </Animated.View>
  );
}

function CartFooter({ total, uniqueStoreCount, zipcode, byStore, onStartRoute }: {
  total: number;
  uniqueStoreCount: number;
  zipcode: string;
  byStore: { store: StoreName; items: CartItem[]; subtotal: number }[];
  onStartRoute: () => void;
}) {
  return (
    <View style={styles.footer}>
      <View style={styles.tripBox}>
        <View style={styles.tripHeader}>
          <Ionicons name="storefront-outline" size={16} color={colors.green} />
          <Text style={styles.tripHeaderText}>
            {uniqueStoreCount} store{uniqueStoreCount !== 1 ? 's' : ''} near {zipcode || 'your area'}
          </Text>
        </View>
        <View style={styles.tripDivider} />
        {byStore.map(({ store, items, subtotal }) => (
          <View key={store} style={styles.tripRow}>
            <Text style={styles.tripSubtext}>
              {store} ({items.reduce((s, i) => s + i.quantity, 0)} item{items.reduce((s, i) => s + i.quantity, 0) !== 1 ? 's' : ''})
            </Text>
            <Text style={styles.tripSubtotal}>${subtotal.toFixed(2)}</Text>
          </View>
        ))}
      </View>
      <View style={styles.totalRow}>
        <Text style={styles.totalLabel}>Total</Text>
        <Text style={styles.totalValue}>${total.toFixed(2)}</Text>
      </View>
      <AnimatedPressable style={styles.startRouteButton} onPress={onStartRoute}>
        <Ionicons name="navigate" size={17} color={colors.white} />
        <Text style={styles.startRouteText}>Start Route</Text>
      </AnimatedPressable>
      <Text style={styles.disclaimer}>Prices are estimates and may vary in-store.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  headerTitle: { fontWeight: '700', fontSize: 18, color: colors.charcoal },
  headerBadge: { backgroundColor: colors.green, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  headerBadgeText: { color: colors.white, fontSize: 11, fontWeight: '700' },
  emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: spacing.sm },
  emptyCircle: { width: 80, height: 80, borderRadius: 40, backgroundColor: colors.mint, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md },
  emptyTitle: { fontWeight: '600', fontSize: 15, color: colors.charcoal },
  emptyText: { color: `${colors.charcoal}73`, fontSize: 13, textAlign: 'center' },
  advisorSlot: { gap: spacing.sm, marginBottom: spacing.md },
  suggestionText: { color: `${colors.charcoal}80`, fontSize: 12, fontStyle: 'italic', paddingHorizontal: spacing.xs },
  categoryHeader: {
    color: `${colors.charcoal}80`, fontWeight: '700', fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase',
    marginBottom: spacing.sm, marginTop: spacing.xs,
  },
  row: { flexDirection: 'row', backgroundColor: colors.panelBg, borderRadius: radius.lg, padding: spacing.md },
  thumb: { width: 56, height: 56, borderRadius: 12, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.borderGray, overflow: 'hidden' },
  rowBody: { flex: 1, marginLeft: spacing.md, gap: 2 },
  rowActions: { alignItems: 'flex-end', gap: spacing.md, marginLeft: spacing.sm },
  itemName: { fontSize: 12.5, fontWeight: '600', color: colors.charcoal },
  storeChip: { alignSelf: 'flex-start', paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.pill, marginTop: spacing.xs },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  stepperButton: { width: 30, height: 30, borderRadius: 15, borderWidth: 1, borderColor: '#E5E7EB', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.white },
  qtyText: { width: 22, textAlign: 'center', fontWeight: '600', fontSize: 13 },
  itemPrice: { fontWeight: '700', fontSize: 13, color: colors.charcoal },
  footer: { borderTopWidth: 1, borderTopColor: colors.borderGray, padding: spacing.lg, gap: spacing.md },
  tripBox: { backgroundColor: colors.mint, borderRadius: radius.lg, padding: spacing.lg },
  tripHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  tripHeaderText: { color: colors.green, fontWeight: '600', fontSize: 12.5 },
  tripRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.xs },
  tripSubtext: { color: `${colors.charcoal}99`, fontSize: 11.5 },
  tripSubtotal: { color: `${colors.charcoal}cc`, fontWeight: '600', fontSize: 11.5 },
  tripDivider: { height: 1, backgroundColor: `${colors.green}26`, marginVertical: spacing.sm },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  totalLabel: { fontWeight: '600', fontSize: 15, color: colors.charcoal },
  totalValue: { color: colors.green, fontWeight: '800', fontSize: 20 },
  startRouteButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
    backgroundColor: colors.green, borderRadius: radius.md, paddingVertical: spacing.md + 2, minHeight: 48,
  },
  startRouteText: { color: colors.white, fontWeight: '600', fontSize: 14 },
  disclaimer: { textAlign: 'center', color: `${colors.charcoal}59`, fontSize: 11, marginTop: spacing.xs },
});
