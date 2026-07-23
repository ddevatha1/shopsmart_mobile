import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View, type ImageStyle, type StyleProp, type ViewStyle } from 'react-native';
import { Image, type ImageContentFit } from 'expo-image';
import { GroceryFallbackIcon } from './GroceryFallbackIcon';
import { resolveProductImage } from '../services/productImageService';
import { duration } from '../theme/motion';

interface Props {
  product: { name: string; image_url?: string; store?: string; storeProductUrl?: string };
  style?: StyleProp<ViewStyle>;
  contentFit?: ImageContentFit;
  /** Icon size for the last-resort category placeholder. */
  iconSize?: number;
}

/**
 * The single place every screen renders a product photo — replaces the
 * `image_url ? <Image/> : <GroceryFallbackIcon/>` snippet that used to be
 * duplicated in ProductCard, ProductDetailScreen, and CartScreen.
 *
 * Fallback chain: (1) the store-provided image_url, if any; (2) on missing
 * or failed load, one lookup via resolveProductImage (cached — see
 * productImageService); (3) the category placeholder icon as the final,
 * always-available fallback. Each product only ever triggers at most one
 * network lookup, ever, on this device (see the cache in
 * productImageService) — a second card for the same product name resolves
 * instantly from cache.
 */
function productIdentityKey(product: Props['product']): string {
  return `${product.name}|${product.image_url ?? ''}|${product.store ?? ''}|${product.storeProductUrl ?? ''}`;
}

export function ProductImage({ product, style, contentFit = 'contain', iconSize }: Props) {
  const [uri, setUri] = useState<string | null>(product.image_url ?? null);
  const [showIcon, setShowIcon] = useState(false);
  // A ref, not state — starting the lookup doesn't need to trigger a
  // re-render itself, only its eventual result (setUri/setShowIcon) does.
  const fallbackTriedRef = useRef(false);

  // Re-syncs local state whenever this instance is handed a *different*
  // product (e.g. the Compare screen's single "Best Value" slot swapping
  // which product it renders after a filter/sort change) — without this,
  // `uri`/`showIcon` would keep reflecting whichever product first mounted
  // this component, showing a stale photo even though the new product's
  // own image_url/lookup would resolve correctly. Adjusting state during
  // render (rather than in an effect) is React's recommended pattern for
  // "reset state when a prop changes" — see react.dev's "Adjusting state
  // when a prop changes" — since it avoids an extra render showing the
  // stale photo before an effect gets a chance to run.
  const key = productIdentityKey(product);
  const [renderedKey, setRenderedKey] = useState(key);
  if (key !== renderedKey) {
    setRenderedKey(key);
    setUri(product.image_url ?? null);
    setShowIcon(false);
  }

  // Refs can't be written during render, so the ref half of the same reset
  // lives here — declared before the lookup effect below so it always runs
  // first within the same commit and the lookup effect sees the reset value.
  useEffect(() => {
    fallbackTriedRef.current = false;
  }, [key]);

  useEffect(() => {
    if (uri || fallbackTriedRef.current) return;
    fallbackTriedRef.current = true;
    let cancelled = false;
    resolveProductImage(product.name, product.store, product.storeProductUrl).then((resolved) => {
      if (cancelled) return;
      if (resolved) setUri(resolved);
      else setShowIcon(true);
    });
    return () => {
      cancelled = true;
    };
  }, [uri, product.name, product.store, product.storeProductUrl]);

  const handleError = () => {
    if (fallbackTriedRef.current) {
      setShowIcon(true);
      return;
    }
    // Clears the (broken) direct URL, which re-arms the effect above to
    // attempt exactly one fallback lookup.
    setUri(null);
  };

  if (showIcon || !uri) {
    return (
      <View style={style ?? styles.fill}>
        <GroceryFallbackIcon productName={product.name} size={iconSize} />
      </View>
    );
  }

  return (
    <Image
      // expo-image's web implementation crossfades by stacking the outgoing
      // and incoming image as two layers; reusing the same element across a
      // `uri` change left the outgoing (wrong-product) layer stuck on top
      // instead of fading out (visible as a stale/wrong photo even though
      // the correct image had already loaded — see productIdentityKey's own
      // comment above for when this happens). Keying by `uri` forces a full
      // remount instead of an in-place update, sidestepping that stuck
      // layer entirely.
      key={uri}
      source={{ uri }}
      // Callers pass plain layout styles (flex, StyleSheet.absoluteFill)
      // valid for both View and Image; only ImageStyle's narrower
      // `overflow` type differs, which none of them use.
      style={(style ?? styles.fill) as StyleProp<ImageStyle>}
      contentFit={contentFit}
      transition={duration.base}
      onError={handleError}
    />
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
