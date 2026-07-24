import { create } from 'zustand';
import type { ApiProduct, CartItem } from '../models/types';
import { cartRepository } from '../repositories/cartRepository';
import { useUserStore } from './userStore';

/** Mirrors the `cartItems` state + addToCart/updateCartQty/removeFromCart
 * handlers and localStorage persistence effect in page.tsx.
 *
 * The cart is scoped to whichever account is currently signed in (see
 * cartRepository) — this store only ever reads that owner at call time
 * rather than holding it as its own state, the same lazy-read pattern
 * searchStore already uses for the signed-in user's ZIP code. */
interface CartState {
  items: CartItem[];
  hydrated: boolean;
  /** The cart's contents immediately before the last Auto-Optimize "Apply
   * Plan" — a single-slot undo, not a full history. Cleared by any other
   * cart mutation (manual add/remove/qty-change, or the Planner's own
   * "Start Shopping") so Undo can never jump back over unrelated changes
   * the shopper made since applying — it only ever means "undo THAT
   * optimization," never "undo my last N actions." */
  lastOptimizationSnapshot: CartItem[] | null;
  hydrate: () => Promise<void>;
  addToCart: (product: ApiProduct, qty?: number) => Promise<void>;
  updateQty: (productId: string, qty: number) => Promise<void>;
  remove: (productId: string) => Promise<void>;
  /** Replaces the entire cart — used by the Smart Shopping Planner's
   * "Start Shopping" action to load a chosen plan's exact items, rather
   * than merging with whatever was in the cart before. */
  setCart: (items: CartItem[]) => Promise<void>;
  /** Cart Auto-Optimize's "Apply Plan" — replaces the cart the same way
   * `setCart` does, but also snapshots the pre-apply cart so
   * `undoLastOptimization` can restore it instantly. */
  applyOptimizedItems: (items: CartItem[]) => Promise<void>;
  /** Restores the cart to exactly what it was before the last Auto-
   * Optimize apply. A no-op if nothing's pending (`lastOptimizationSnapshot`
   * is null) — callers should gate the Undo affordance on that being set. */
  undoLastOptimization: () => Promise<void>;
}

function currentCartOwner(): string | null {
  return useUserStore.getState().user?.email ?? null;
}

export const useCartStore = create<CartState>((set, get) => ({
  items: [],
  hydrated: false,
  lastOptimizationSnapshot: null,

  hydrate: async () => {
    const owner = currentCartOwner();
    const items = owner ? await cartRepository.loadCart(owner) : [];
    set({ items, hydrated: true, lastOptimizationSnapshot: null });
  },

  addToCart: async (product, qty = 1) => {
    const owner = currentCartOwner();
    if (!owner) return;
    const items = get().items;
    const idx = items.findIndex((i) => i.product.id === product.id);
    const next =
      idx >= 0
        ? items.map((i, n) => (n === idx ? { ...i, quantity: i.quantity + qty } : i))
        : [...items, { product, quantity: qty }];
    set({ items: next, lastOptimizationSnapshot: null });
    await cartRepository.saveCart(owner, next);
  },

  updateQty: async (productId, qty) => {
    const owner = currentCartOwner();
    if (!owner) return;
    const items = get().items;
    const next =
      qty <= 0
        ? items.filter((i) => i.product.id !== productId)
        : items.map((i) => (i.product.id === productId ? { ...i, quantity: qty } : i));
    set({ items: next, lastOptimizationSnapshot: null });
    await cartRepository.saveCart(owner, next);
  },

  remove: async (productId) => {
    const owner = currentCartOwner();
    const next = get().items.filter((i) => i.product.id !== productId);
    set({ items: next, lastOptimizationSnapshot: null });
    if (owner) await cartRepository.saveCart(owner, next);
  },

  setCart: async (items) => {
    const owner = currentCartOwner();
    if (!owner) return;
    set({ items, lastOptimizationSnapshot: null });
    await cartRepository.saveCart(owner, items);
  },

  applyOptimizedItems: async (items) => {
    const owner = currentCartOwner();
    if (!owner) return;
    const previous = get().items;
    set({ items, lastOptimizationSnapshot: previous });
    await cartRepository.saveCart(owner, items);
  },

  undoLastOptimization: async () => {
    const owner = currentCartOwner();
    const snapshot = get().lastOptimizationSnapshot;
    if (!owner || snapshot === null) return;
    set({ items: snapshot, lastOptimizationSnapshot: null });
    await cartRepository.saveCart(owner, snapshot);
  },
}));

// Reload the cart whenever the signed-in account changes (sign in, sign
// out, switching accounts on the same device) — never keep showing the
// previous account's items. App.tsx's boot-time hydrate covers the
// initial load; this covers every change after that.
useUserStore.subscribe((state, prevState) => {
  if (state.user?.email !== prevState.user?.email) {
    useCartStore.getState().hydrate();
  }
});

export function cartItemCount(items: CartItem[]): number {
  return items.reduce((sum, i) => sum + i.quantity, 0);
}

export function cartTotal(items: CartItem[]): number {
  return items.reduce((sum, i) => sum + i.product.price * i.quantity, 0);
}
