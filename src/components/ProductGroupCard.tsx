import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import type { ProductGroup } from '../services/comparisonService';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';
import { elevation, radius, spacing } from '../theme/metrics';
import { duration, easing, staggerDelay } from '../theme/motion';
import { AnimatedPressable } from './AnimatedPressable';
import { ProductImage } from './ProductImage';

interface Props {
  group: ProductGroup;
  onPress: () => void;
  index?: number;
}

/**
 * Stage 1's visual card — the semantic product category (e.g. "Fuji
 * Apples"), not yet any one store's listing. Deliberately simpler than
 * ProductCard: no price tag, no store badge, no add-to-cart, and critically
 * no store name or brand anywhere on the card — Stage 1 must read as
 * product-specific, never store-specific (that's the whole reason
 * comparison starts at Stage 2). The only secondary text is a neutral
 * store-count caption (see comparisonService.buildProductGroups). Image-
 * forward, same entrance/press treatment as ProductCard so the grid feels
 * like a continuation of the same visual language.
 */
export function ProductGroupCard({ group, onPress, index = 0 }: Props) {
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

  return (
    <Animated.View style={entranceStyle} layout={LinearTransition.duration(duration.base)}>
      <AnimatedPressable onPress={onPress} style={styles.card} scaleTo={0.98} liftOnPress>
        <View style={styles.imageWrap}>
          <ProductImage product={group} style={StyleSheet.absoluteFill} />
        </View>
        <View style={styles.body}>
          <Text style={styles.name} numberOfLines={2}>{group.name}</Text>
          <Text style={styles.subtitle} numberOfLines={1}>{group.subtitle}</Text>
        </View>
      </AnimatedPressable>
    </Animated.View>
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
  imageWrap: {
    aspectRatio: 1,
    backgroundColor: colors.imageBackground,
    position: 'relative',
  },
  body: { padding: spacing.md, gap: 2 },
  name: { ...typography.cardTitle, fontSize: 14.5 },
  subtitle: { ...typography.caption, fontWeight: '600', color: colors.green },
});
