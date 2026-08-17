import { create } from 'zustand';
import type { ApiProduct, CartItem } from '../models/types';
import { cartRepository } from '../repositories/cartRepository';
import { GUEST_OWNER_KEY } from '../services/guestIdentity';

/** Mirrors the `cartItems` state + addToCart/updateCartQty/removeFromCart
 * handlers and localStorage persistence effect in page.tsx.
 *
 * No accounts anymore — every device has exactly one cart, scoped under
 * the fixed GUEST_OWNER_KEY (see guestIdentity.ts's own header comment
 * for why a fixed key rather than a per-install random one). */
interface CartState {
  items: CartItem[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addToCart: (product: ApiProduct, qty?: number) => Promise<void>;
  updateQty: (productId: string, qty: number) => Promise<void>;
  remove: (productId: string) => Promise<void>;
  /** Replaces the entire cart — used by the Smart Shopping Planner's
   * "Start Shopping" action to load a chosen plan's exact items, rather
   * than merging with whatever was in the cart before. */
  setCart: (items: CartItem[]) => Promise<void>;
}

export const useCartStore = create<CartState>((set, get) => ({
  items: [],
  hydrated: false,

  hydrate: async () => {
    const items = await cartRepository.loadCart(GUEST_OWNER_KEY);
    set({ items, hydrated: true });
  },

  addToCart: async (product, qty = 1) => {
    const owner = GUEST_OWNER_KEY;
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
    const items = get().items;
    const next =
      qty <= 0
        ? items.filter((i) => i.product.id !== productId)
        : items.map((i) => (i.product.id === productId ? { ...i, quantity: qty } : i));
    set({ items: next });
    await cartRepository.saveCart(GUEST_OWNER_KEY, next);
  },

  remove: async (productId) => {
    const next = get().items.filter((i) => i.product.id !== productId);
    set({ items: next });
    await cartRepository.saveCart(GUEST_OWNER_KEY, next);
  },

  setCart: async (items) => {
    set({ items });
    await cartRepository.saveCart(GUEST_OWNER_KEY, items);
  },
}));

export function cartItemCount(items: CartItem[]): number {
  return items.reduce((sum, i) => sum + i.quantity, 0);
}

export function cartTotal(items: CartItem[]): number {
  return items.reduce((sum, i) => sum + i.product.price * i.quantity, 0);
}
