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
  hydrate: () => Promise<void>;
  addToCart: (product: ApiProduct, qty?: number) => Promise<void>;
  updateQty: (productId: string, qty: number) => Promise<void>;
  remove: (productId: string) => Promise<void>;
}

function currentCartOwner(): string | null {
  return useUserStore.getState().user?.email ?? null;
}

export const useCartStore = create<CartState>((set, get) => ({
  items: [],
  hydrated: false,

  hydrate: async () => {
    const owner = currentCartOwner();
    const items = owner ? await cartRepository.loadCart(owner) : [];
    set({ items, hydrated: true });
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
    set({ items: next });
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
    set({ items: next });
    await cartRepository.saveCart(owner, next);
  },

  remove: async (productId) => {
    const owner = currentCartOwner();
    const next = get().items.filter((i) => i.product.id !== productId);
    set({ items: next });
    if (owner) await cartRepository.saveCart(owner, next);
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
