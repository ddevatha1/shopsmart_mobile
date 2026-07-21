import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CartItem } from '../models/types';

/**
 * Scoped per signed-in account (keyed by email) rather than one global
 * key — a cart belongs to whoever built it. Without this, a brand-new
 * sign-up on a device that previously had another account signed in would
 * inherit that account's leftover cart on first hydrate.
 */
function cartKey(ownerEmail: string): string {
  return `shopsmart_cart_${ownerEmail}`;
}

export const cartRepository = {
  async loadCart(ownerEmail: string): Promise<CartItem[]> {
    const raw = await AsyncStorage.getItem(cartKey(ownerEmail));
    if (!raw) return [];
    try {
      return JSON.parse(raw) as CartItem[];
    } catch {
      return [];
    }
  },

  async saveCart(ownerEmail: string, items: CartItem[]): Promise<void> {
    await AsyncStorage.setItem(cartKey(ownerEmail), JSON.stringify(items));
  },
};
