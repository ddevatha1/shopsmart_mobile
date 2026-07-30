import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { spacing } from '../theme/metrics';
import { ScreenContainer } from '../components/ScreenContainer';
import { ScreenHeader } from '../components/ScreenHeader';
import { ContextualHint } from '../components/onboarding/ContextualHint';
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
  // uses (ZIP, cart, and every other app-level store are untouched by it),
  // then returns to the existing `SearchResults` screen already in this
  // stack (Navigation Redesign — Compare is only ever reached FROM
  // SearchResults, so it's always there to pop back to), where the
  // results are already updated by the time it's visible again.
  //
  // Deliberately `navigate`, not `popToTop`: `popToTop` would pop all the
  // way to the Home Hub tab at the bottom of this stack, past
  // SearchResults entirely — a real regression the Navigation Redesign's
  // Hub/Search/Results split introduced here (Home is no longer the
  // screen showing results, so "the top of the stack" and "the screen
  // with the results" stopped being the same screen).
  const runSearchMore = (term: string) => {
    useSearchStore.getState().search(term);
    navigation.navigate('SearchResults');
  };

  return (
    <ScreenContainer>
      <ScreenHeader title={group.name} onBack={() => navigation.goBack()} />

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.hintSlot}>
          <ContextualHint hintKey="compare" message="Compare prices and savings across stores." />
        </View>
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
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  scrollContent: { paddingBottom: spacing.xxl },
  hintSlot: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
});
