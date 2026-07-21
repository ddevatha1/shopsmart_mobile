import type { CartItem, StoreGroup, StoreLocation } from '../models/types';

/** Same dedup key shape as the backend's tripPlanner.ts — one group per
 * physical store, not per product/brand. Exported so callers can re-match
 * a TripPlan's stops (which only carry `location`) back to the StoreGroup
 * that produced them (e.g. for store-chain-accent coloring on the map). */
export function locationKey(loc: StoreLocation): string {
  return `${loc.storeId ?? ''}|${loc.address}|${loc.city}|${loc.state}|${loc.zip}`.toLowerCase();
}

/**
 * The "store selection" step of the route pipeline: groups a shopper's
 * cart by the exact StoreLocation each product came from — never by store
 * chain name alone, so two different physical Krogers never collapse into
 * one stop, and a product's pickup location is always the one its
 * inventory actually came from. Pure and React-free by design (the Route
 * screen calls it, it doesn't know the Route screen exists).
 *
 * Items whose product has no location data at all (e.g. an older cached
 * search result, or a store the location pipeline couldn't resolve) can't
 * be routed to — they're returned separately rather than silently dropped,
 * so the caller can tell the shopper instead of pretending those items
 * don't exist.
 */
export function groupCartByStore(items: CartItem[]): {
  groups: StoreGroup[];
  itemsWithoutLocation: CartItem[];
} {
  const groups = new Map<string, StoreGroup>();
  const itemsWithoutLocation: CartItem[] = [];

  for (const item of items) {
    const location = item.product.location;
    if (!location) {
      itemsWithoutLocation.push(item);
      continue;
    }
    const key = locationKey(location);
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
    } else {
      groups.set(key, { location, items: [item] });
    }
  }

  return { groups: Array.from(groups.values()), itemsWithoutLocation };
}
