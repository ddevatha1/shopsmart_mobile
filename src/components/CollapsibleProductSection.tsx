import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import type { ApiProduct } from '../models/types';
import { AnimatedPressable } from './AnimatedPressable';
import { ProductCard } from './ProductCard';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';
import { radius, spacing } from '../theme/metrics';
import { fadeIn } from '../theme/motion';

interface Props {
  products: ApiProduct[];
  expanded: boolean;
  onToggle: () => void;
  onPressProduct: (product: ApiProduct) => void;
  onAddToCart: (product: ApiProduct) => void;
  /** Divider heading shown above the grid once expanded, e.g. `Related to
   * "milk"` or `Single-Store Options`. */
  sectionLabel: string;
  /** Toggle button text while collapsed. */
  collapsedLabel: string;
  /** Toggle button text while expanded. */
  expandedLabel: string;
  /** Changing this collapses the section and forces a remeasure — e.g. the
   * active search query, so a stale reveal from a prior search is never
   * left expanded (or fully mounted) behind a new one. */
  resetKey: string;
}

/**
 * A toggleable secondary product grid, generalized over two call sites on
 * SearchScreen: tangentially-related search results (the query as an
 * ingredient/flavor/component) and products only a single store carries
 * (which can't be meaningfully compared, so they're set aside rather than
 * shown in the Stage 1 comparison grid — see comparisonService.ProductGroup
 * / buildProductGroups). Both are secondary content a shopper may never
 * open, so content only mounts after the first expand, and re-arms whenever
 * `resetKey` changes, so a reveal from a prior search never sits fully
 * mounted (images loading, entrance animations running) behind a collapsed
 * toggle. Animates open/closed the same measured-height way
 * AccordionSection does — a proven, consistent pattern rather than a new one.
 */
export function CollapsibleProductSection({
  products, expanded, onToggle, onPressProduct, onAddToCart, sectionLabel, collapsedLabel, expandedLabel, resetKey,
}: Props) {
  const [everExpanded, setEverExpanded] = useState(expanded);
  const [contentHeight, setContentHeight] = useState(0);
  const [measuredForKey, setMeasuredForKey] = useState(resetKey);

  if (resetKey !== measuredForKey) {
    setMeasuredForKey(resetKey);
    setContentHeight(0);
    setEverExpanded(expanded);
  } else if (expanded && !everExpanded) {
    setEverExpanded(true);
  }

  const progress = useSharedValue(expanded ? 1 : 0);
  useEffect(() => {
    progress.value = withTiming(expanded ? 1 : 0, fadeIn());
  }, [expanded, progress]);

  const bodyStyle = useAnimatedStyle(() => ({
    height: progress.value * contentHeight,
    opacity: progress.value,
  }));
  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${progress.value * 180}deg` }],
  }));

  if (products.length === 0) return null;

  return (
    <View>
      <AnimatedPressable onPress={onToggle} style={styles.toggleButton} scaleTo={0.98}>
        <Ionicons name={expanded ? 'remove-circle-outline' : 'add-circle-outline'} size={17} color={colors.green} />
        <Text style={styles.toggleText}>{expanded ? expandedLabel : collapsedLabel}</Text>
        <Animated.View style={chevronStyle}>
          <Ionicons name="chevron-down" size={16} color={colors.green} />
        </Animated.View>
      </AnimatedPressable>

      <Animated.View style={[styles.revealBody, bodyStyle]}>
        {everExpanded && (
          <View
            style={contentHeight === 0 ? styles.measureAbsolute : undefined}
            onLayout={(e) => {
              const h = e.nativeEvent.layout.height;
              if (h > 0 && h !== contentHeight) setContentHeight(h);
            }}
          >
            <View style={styles.sectionHeaderRow}>
              <View style={styles.divider} />
              <Text style={styles.sectionLabel}>{sectionLabel}</Text>
              <View style={styles.divider} />
            </View>
            <View style={styles.grid}>
              {products.map((p, i) => (
                <View key={p.id} style={styles.cell}>
                  <ProductCard product={p} index={i} onPress={() => onPressProduct(p)} onAddToCart={() => onAddToCart(p)} />
                </View>
              ))}
            </View>
          </View>
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  toggleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginHorizontal: 4,
    marginTop: 4,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.green,
    borderStyle: 'dashed',
  },
  toggleText: { ...typography.button, color: colors.green, flexShrink: 1, textAlign: 'center' },
  revealBody: { overflow: 'hidden' },
  // First measurement pass: render off-flow so we can read natural height
  // without a visible layout jump, before the collapsed height is known —
  // same trick AccordionSection uses.
  measureAbsolute: { position: 'absolute', left: 0, right: 0 },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xl,
    marginBottom: spacing.md,
  },
  divider: { flex: 1, height: 1, backgroundColor: colors.borderGray },
  sectionLabel: { ...typography.overline, color: `${colors.charcoal}80` },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  cell: { width: '47%' },
});
