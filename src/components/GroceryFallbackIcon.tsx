import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';

/**
 * Mirrors the category-matching logic in
 * shopsmart_web/src/utils/groceryFallbackImage.ts exactly (same keyword
 * groups, same precedence order) but renders a native vector icon instead
 * of an embedded SVG data URI — there's no reason to parse SVG strings in
 * React Native when @expo/vector-icons (bundled with every Expo project)
 * has a first-class icon system. Icon names verified against the installed
 * Ionicons glyphmap.
 */
type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

interface Category {
  pattern: RegExp;
  icon: IoniconName;
  color: string;
}

const CATEGORIES: Category[] = [
  { pattern: /milk|dairy|creamer|cream|yogurt|yoghurt|butter|cheese/i, icon: 'ice-cream-outline', color: '#2C742F' },
  { pattern: /bread|loaf|toast|bakery|bagel|baguette|sourdough|roll|bun|muffin|biscuit/i, icon: 'restaurant-outline', color: '#C4923A' },
  { pattern: /\begg/i, icon: 'egg-outline', color: '#D4A040' },
  { pattern: /chicken|turkey|poultry|beef|steak|meat|pork|lamb|bacon|sausage/i, icon: 'fast-food-outline', color: '#922B21' },
  { pattern: /fish|salmon|tuna|shrimp|seafood|cod|tilapia/i, icon: 'fish-outline', color: '#2980B9' },
  { pattern: /apple|banana|orange|berry|berries|fruit|grape|peach|plum|mango|kiwi|pear/i, icon: 'nutrition-outline', color: '#C0392B' },
  { pattern: /spinach|kale|lettuce|salad|broccoli|vegetable|veggie|celery|carrot|tomato/i, icon: 'leaf-outline', color: '#1E8449' },
  { pattern: /coffee|espresso|latte/i, icon: 'cafe-outline', color: '#4A3728' },
  { pattern: /water|soda|juice|beverage|drink|tea|lemonade/i, icon: 'water-outline', color: '#2E86C1' },
  { pattern: /cereal|oat|granola|grain|rice|pasta|noodle/i, icon: 'basket-outline', color: '#E59866' },
];

const GENERIC: Category = { pattern: /(?:)/, icon: 'storefront-outline', color: '#2C742F' };

function resolveCategory(productName: string): Category {
  const name = productName.toLowerCase();
  return CATEGORIES.find((c) => c.pattern.test(name)) ?? GENERIC;
}

export function groceryFallbackIcon(productName: string): IoniconName {
  return resolveCategory(productName).icon;
}

interface Props {
  productName: string;
  size?: number;
}

export function GroceryFallbackIcon({ productName, size = 48 }: Props) {
  const category = resolveCategory(productName);
  return (
    <View style={{ flex: 1, backgroundColor: colors.imageBackground, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name={category.icon} size={size} color={`${category.color}99`} />
    </View>
  );
}
