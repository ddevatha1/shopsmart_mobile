import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ProductCard } from '../ProductCard';
import { useCartStore } from '../../store/cartStore';
import { getPreferences } from '../../services/shopperPreferenceService';
import { getAllRecords, getMostRecentPurchase, type PurchaseRecord } from '../../services/purchaseHistoryService';
import { getWhyChosenBadges } from '../../services/recommendationExplanationService';
import type { ApiProduct, PlanLineItem, ShopperPreferences } from '../../models/types';
import { colors } from '../../theme/colors';
import { spacing } from '../../theme/metrics';

/**
 * Universal Shopping Item Card Renderer (Phase 5.5 Part 2) — the ONE
 * place a `PlanLineItem[]` becomes real product cards, anywhere in this
 * app. Extracted out of PlanStoreSection.tsx (which now just wraps this
 * with its own collapsible store-header chrome) so PlannerScreen,
 * AssistantScreen, and any future by-item (non-store-grouped) view all
 * render products through the exact same code — never a second
 * product-card implementation.
 *
 * Every card is the same `ProductCard` component search results already
 * use, fed the exact real `ApiProduct` the backend's optimizer already
 * resolved (see backend/src/services/shoppingPlanOptimizer.ts's
 * `evaluateSubset`) — this component never computes, guesses, or
 * invents a product. A line with no real product (`product: null`)
 * gets an honest fallback row, never a fabricated card; a real
 * `alternativeSuggestion`, when present, is shown as its own clearly
 * labeled real `ProductCard` — never substituted in as if it were the
 * chosen product.
 *
 * "Add to cart" reuses the SAME direct, tap-to-add action already
 * available on every other `ProductCard` in this app (Search/Compare/
 * ProductDetail) — not a new cart-mutation path, and not the
 * assistant's own confirmation-gated `add_to_cart` intent flow, which
 * nothing rendered by this component ever goes through.
 *
 * Phase 6 Part 5 — "why chosen" badges. When `ownerEmail` is provided,
 * this component fetches real preferences (`shopperPreferenceService`)
 * and real purchase history (`purchaseHistoryService`) ONCE per render
 * (never per card) and runs `explainProductSelection` — the exact same
 * evidence-gated function ProductDetailScreen already uses — for each
 * resolved product, passing the flattened messages down as
 * `ProductCard`'s `whyChosenBadges`. A plan's own resolved items are the
 * one context where "CartIQ chose this" is literally true (the
 * optimizer picked them), which is why this wiring lives here and not on
 * every `ProductCard` in a plain search grid. Omitting `ownerEmail`
 * (every pre-existing call site) computes nothing and renders exactly as
 * before.
 */

interface Props {
  items: PlanLineItem[];
  /** Optional — when provided, tapping a resolved (or alternative-
   * suggestion) product card opens it. Omitted call sites (e.g. a modal
   * with no navigation context) just don't navigate — never a
   * fabricated fallback destination. */
  onPressProduct?: (product: ApiProduct) => void;
  /** Shown above an unresolved item's fallback row, when set — lets a
   * caller (e.g. PlanResultsView's top-level "not found" list) label the
   * item by its original list text; PlanStoreSection omits this since
   * its own item rows never reach the unresolved branch in practice. */
  showRawTextForUnresolved?: boolean;
  /** Optional (Phase 6 Part 5) — see this file's own header comment.
   * Signed-out/omitted means no badges, never a broken lookup. */
  ownerEmail?: string;
}

export function PlanItemProductGrid({ items, onPressProduct, showRawTextForUnresolved = true, ownerEmail }: Props) {
  const addToCart = useCartStore((s) => s.addToCart);

  const [preferences, setPreferences] = useState<ShopperPreferences>({});
  const [purchaseRecords, setPurchaseRecords] = useState<PurchaseRecord[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!ownerEmail) {
      setPreferences({});
      setPurchaseRecords([]);
      return;
    }
    Promise.all([getPreferences(ownerEmail), getAllRecords(ownerEmail)]).then(([prefs, records]) => {
      if (!cancelled) {
        setPreferences(prefs);
        setPurchaseRecords(records);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [ownerEmail]);

  const resolvedProducts = items.map((line) => line.product).filter((p): p is ApiProduct => p != null);

  function whyChosenBadgesFor(product: ApiProduct): string[] | undefined {
    if (!ownerEmail) return undefined;
    const previousPurchase = getMostRecentPurchase(product, purchaseRecords);
    return getWhyChosenBadges(product, {
      preferredStores: preferences.preferredStores,
      dietaryPreferences: preferences.dietaryPreferences,
      previousPurchase: previousPurchase ? { price: previousPurchase.price } : undefined,
      comparableProducts: resolvedProducts,
    });
  }

  return (
    <View style={styles.grid}>
      {items.map((line, i) =>
        line.product ? (
          <View key={line.listItemId} style={styles.cardSlot}>
            <ProductCard
              product={line.product}
              index={i}
              onPress={() => onPressProduct?.(line.product!)}
              onAddToCart={() => addToCart(line.product!)}
              whyChosenBadges={whyChosenBadgesFor(line.product)}
            />
          </View>
        ) : (
          <View key={line.listItemId} style={styles.unresolvedSlot}>
            {showRawTextForUnresolved && (
              <Text style={styles.unresolvedText}>
                Couldn&apos;t confirm a real product for &quot;{line.rawText}&quot;.
              </Text>
            )}
            {/* A real alternative suggestion only — never a fabricated
                substitute, and never presented as the chosen product. */}
            {line.alternativeSuggestion && (
              <View style={styles.alternativeCardSlot}>
                <Text style={styles.alternativeLabel}>Closest match:</Text>
                <ProductCard
                  product={line.alternativeSuggestion}
                  onPress={() => onPressProduct?.(line.alternativeSuggestion!)}
                  onAddToCart={() => addToCart(line.alternativeSuggestion!)}
                />
              </View>
            )}
          </View>
        ),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  cardSlot: { width: '47%' },
  unresolvedSlot: { width: '100%', gap: spacing.xs, paddingVertical: spacing.xs },
  unresolvedText: { color: `${colors.charcoal}80`, fontSize: 12.5, fontStyle: 'italic' },
  alternativeCardSlot: { width: '55%', gap: spacing.xs },
  alternativeLabel: { color: '#92400E', fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
});
