import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { AnimatedPressable } from './AnimatedPressable';
import { AddToCartButton } from './AddToCartButton';
import { colors } from '../theme/colors';
import { spacing, radius } from '../theme/metrics';

interface Props {
  /** Present only when the recommendation holds a direct reference to a
   * real product it can navigate straight to — never re-triggers a
   * search. Omit to render no "See Product" action. */
  onSeeProduct?: () => void;
  /** Present only when adding the referenced product directly makes
   * sense for this recommendation. Omit to render no "Add to Cart"
   * action. */
  onAddToCart?: () => void;
}

/**
 * The shared action row for any recommendation surface that references a
 * specific product — AdvisorCard (deal insights) and the Product Detail
 * substitution box both render through this, so "how a recommendation
 * lets you act on it" stays one consistent pattern instead of two
 * bespoke button rows. Renders nothing when neither action applies.
 */
export function RecommendationActions({ onSeeProduct, onAddToCart }: Props) {
  if (!onSeeProduct && !onAddToCart) return null;
  return (
    <View style={styles.row}>
      {onSeeProduct && (
        <AnimatedPressable onPress={onSeeProduct} style={styles.seeButton} scaleTo={0.95}>
          <Text style={styles.seeText}>See Product</Text>
        </AnimatedPressable>
      )}
      {onAddToCart && <AddToCartButton onPress={onAddToCart} />}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  seeButton: {
    borderWidth: 1,
    borderColor: colors.borderGray,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  seeText: { color: colors.charcoal, fontWeight: '700', fontSize: 12 },
});
