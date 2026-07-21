import type { StoreName } from '../models/types';

/**
 * ShopSmart brand palette — copied directly from shopsmart_web's hardcoded
 * hex values (src/app/page.tsx, ProductCard.tsx, AuthModal.tsx, etc.) so the
 * mobile app is visually identical, not just "inspired by."
 */
export const colors = {
  green: '#2C742F',
  greenDark: '#255F27', // hover state on web
  mint: '#E0F3E2',
  mintDark: '#D0EBD2', // hover state on web
  charcoal: '#1A1A1A',
  priceBadge: '#7B2D2D',
  imageBackground: '#F8FDF8',
  borderGray: '#F3F4F6', // Tailwind gray-100
  amber: '#FBBF24',
  errorRed: '#EF4444',
  errorBg: '#FEF2F2',
  errorBorder: '#FECACA',
  panelBg: '#F9FAFB',
  white: '#FFFFFF',
};

export interface StoreAccent {
  background: string;
  text: string;
  dot: string;
}

/** Mirrors STORE_STYLE / STORE_ACCENT / STORE_DOT in ProductCard.tsx /
 * CartDrawer.tsx / page.tsx exactly (Tailwind rose/emerald/sky/cyan
 * 100/500/700 shades). */
export const storeAccents: Record<StoreName, StoreAccent> = {
  "Trader Joe's": { background: '#FFE4E6', text: '#BE123C', dot: '#F43F5E' },
  Sprouts: { background: '#D1FAE5', text: '#047857', dot: '#10B981' },
  Kroger: { background: '#E0F2FE', text: '#0369A1', dot: '#0284C7' },
  Aldi: { background: '#CFFAFE', text: '#0E7490', dot: '#0E7490' },
};
