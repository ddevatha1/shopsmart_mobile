import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';
import { spacing } from '../theme/metrics';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { ComparisonView } from '../components/comparison/ComparisonView';
import { useCartStore } from '../store/cartStore';
import { useSearchStore } from '../store/searchStore';
import type { ApiProduct } from '../models/types';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Compare'>;

/**
 * Stage 2 screen chrome — header (back button + category name) around
 * ComparisonView, which owns the actual hero/filter/store-section/
 * refinement content. See ComparisonView for why the content itself is
 * factored out: SearchScreen mounts the exact same component directly,
 * without this header, when a search's category layer isn't worth the
 * click (comparisonService.categoryLayerIsMeaningful).
 */
export function CompareScreen({ route, navigation }: Props) {
  const { group } = route.params;
  // Falls back to just this group's own listings if a screen ever pushes
  // Compare without it, so the related categories/"Browse all store
  // products" options degrade to "nothing more to show" rather than
  // crashing.
  const allDirectProducts = route.params.allDirectProducts ?? group.listings;
  const addToCart = useCartStore((s) => s.addToCart);

  // The "Still can't find it?" card's search field — continues the
  // workflow with a more specific query rather than sending the shopper
  // back to Search by hand. Fires the same global search() action Stage 1
  // uses (ZIP, cart, and every other app-level store are untouched by it)
  // and pops back to the Search tab, where the results are already
  // updated by the time it's visible again.
  const runSearchMore = (term: string) => {
    useSearchStore.getState().search(term);
    navigation.popToTop();
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.header}>
        <AnimatedPressable
          onPress={() => navigation.goBack()}
          style={styles.closeButton}
          scaleTo={0.9}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="arrow-back" size={20} color={colors.charcoal} />
        </AnimatedPressable>
        <Text style={styles.headerTitle} numberOfLines={1}>{group.name}</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <ComparisonView
          group={group}
          allDirectProducts={allDirectProducts}
          onPressProduct={(product: ApiProduct) =>
            navigation.navigate('ProductDetail', { product, allProducts: group.listings })}
          onAddToCart={(product: ApiProduct) => addToCart(product)}
          onOpenCategory={(g) => navigation.replace('Compare', { group: g, allDirectProducts })}
          onSearchMore={runSearchMore}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.white },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.panelBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: { ...typography.h2, flex: 1, textAlign: 'center', marginHorizontal: spacing.sm },
  scrollContent: { paddingBottom: spacing.xxl },
});
