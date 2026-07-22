import type { ApiProduct } from '../models/types';

/**
 * A curated grocery taxonomy — how shoppers actually browse a store aisle,
 * not the generic 10-bucket aisle categories in groceryCategoryService.ts
 * (which this file is unrelated to; that one answers "what aisle," this one
 * answers "which specific variety of this item").
 *
 * Each entry maps a common search query (e.g. "milk") to the natural
 * subtypes a shopper expects to choose between (Whole, 2%, Skim, ...).
 * comparisonService.buildProductGroups consults this first: when the active
 * search query matches an entry, every returned product is classified into
 * one of that entry's subtypes (see classifyProductSubtype); anything that
 * doesn't match — because a taxonomy entry doesn't cover it, or a specific
 * product doesn't name a subtype the way this list anticipated — falls
 * through to the existing dynamic identity-clustering algorithm, same as
 * every query with no taxonomy entry at all. Products are never dropped and
 * never force-guessed into a subtype they don't actually name (see
 * defaultSubtypeId below for the one narrow exception).
 */

export interface TaxonomySubtype {
  id: string;
  /** Canonical display label — always shown verbatim as the group's name,
   * regardless of which specific listing represents it, so a marinated or
   * heavily-modified listing can never leak into the category card's title
   * the way a purely emergent (dynamic-clustering) label could. */
  label: string;
  /** Lowercase words/phrases matched as whole words/phrases (not raw
   * substrings — "salted" never matches inside "unsalted") against a
   * product's name + brand + category/aisle. Checked in entry order within
   * `subtypes`, first match wins — put the more specific/distinguishing
   * subtypes first and generic qualifiers (e.g. "organic") last, per the
   * rule "Organic Valley 2% Milk" is 2% Milk, not Organic Milk. */
  keywords: string[];
}

export interface TaxonomyEntry {
  id: string;
  /** Words/phrases that identify a search query as being about this item. */
  matchQuery: string[];
  /** Words/phrases that, if present in the query, rule this entry out even
   * though matchQuery matched — e.g. "peanut butter" must never resolve to
   * the plain "butter" entry. */
  excludeQuery?: string[];
  /** Word(s) that must appear in a product's own text for it to be eligible
   * for `defaultSubtypeId`. Guards against defaulting an unrelated product
   * that merely rode along in the search results (e.g. "Cottage Cheese"
   * showing up as a direct match for "yogurt") into a subtype it was never
   * actually labeled as. */
  parentKeywords: string[];
  subtypes: TaxonomySubtype[];
  /** Subtype id assigned to a product that names the parent item (per
   * parentKeywords) but no specific subtype from the list above — only set
   * where a genuine majority-default exists (e.g. unlabeled eggs are almost
   * always Large). Left unset for items with no safe default (milk has no
   * one dominant fat content; bread has no one dominant type) — those
   * products are left for the dynamic-clustering fallback instead of being
   * guessed into a subtype the label never actually claimed. */
  defaultSubtypeId?: string;
}

// ─── Text normalization + phrase matching ─────────────────────────────────

function normalizeText(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9%]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

function normalizePhrase(phrase: string): string {
  return ` ${phrase.toLowerCase().replace(/[^a-z0-9%]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

function hasPhrase(normalizedHaystack: string, phrase: string): boolean {
  return normalizedHaystack.includes(normalizePhrase(phrase));
}

// Sørensen–Dice bigram coefficient — same measure comparisonService and the
// backend's relevance classifier use, re-implemented locally for the same
// "no shared runtime" reason the rest of this app's normalization is.
// Fallback tier only: catches a typo or irregular plural a keyword's exact
// phrase didn't anticipate ("Cheddars", "Wholemilk") without ever misreading
// two genuinely different words as the same concept.
function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const counts = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      counts.set(bg, (counts.get(bg) ?? 0) + 1);
    }
    return counts;
  };
  const ba = bigrams(a);
  const bb = bigrams(b);
  let overlap = 0;
  for (const [bg, count] of ba) {
    const countB = bb.get(bg);
    if (countB) overlap += Math.min(count, countB);
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

const FUZZY_THRESHOLD = 0.75;

/** Fuzzy fallback for single-word keywords only — multi-word phrases (e.g.
 * "pasture-raised") are precise enough that a fuzzy per-word pass would risk
 * false positives, so they rely on the exact-phrase pass alone. */
function hasFuzzyWord(normalizedHaystack: string, keyword: string): boolean {
  if (keyword.includes(' ')) return false;
  const words = normalizedHaystack.trim().split(' ');
  return words.some((w) => diceCoefficient(w, keyword.toLowerCase()) >= FUZZY_THRESHOLD);
}

function productText(product: Pick<ApiProduct, 'name' | 'brand' | 'category' | 'aisle'>): string {
  return normalizeText(
    [product.name, product.brand, product.category, product.aisle].filter(Boolean).join(' '),
  );
}

/** The taxonomy entry a search query is about, or null when nothing in the
 * catalog covers it (the query falls through entirely to dynamic
 * clustering). First match in `GROCERY_TAXONOMY` order wins — entries whose
 * matchQuery could be a substring of a more specific entry's own query (e.g.
 * "butter" inside "peanut butter") are ordered so the more specific entry is
 * checked first, with excludeQuery as a second line of defense. */
export function findTaxonomyEntry(query: string): TaxonomyEntry | null {
  const normalized = normalizeText(query);
  for (const entry of GROCERY_TAXONOMY) {
    if (entry.excludeQuery?.some((kw) => hasPhrase(normalized, kw))) continue;
    if (entry.matchQuery.some((kw) => hasPhrase(normalized, kw))) return entry;
  }
  return null;
}

/** Classifies one product into an entry's subtype using product title,
 * brand metadata, and (Aldi-only) store-supplied category/aisle — keyword
 * matching first (exact phrase, ordered most-specific-first), a fuzzy
 * single-word pass second, and finally `defaultSubtypeId` when the product
 * genuinely names the parent item but no specific subtype. Returns null
 * (never a forced guess) when none of that applies — the caller folds
 * unclassified products into the existing dynamic-clustering pass instead
 * of dropping or mis-bucketing them. */
export function classifyProductSubtype(
  product: Pick<ApiProduct, 'name' | 'brand' | 'category' | 'aisle'>,
  entry: TaxonomyEntry,
): TaxonomySubtype | null {
  const text = productText(product);

  for (const subtype of entry.subtypes) {
    if (subtype.keywords.some((kw) => hasPhrase(text, kw))) return subtype;
  }
  for (const subtype of entry.subtypes) {
    if (subtype.keywords.some((kw) => hasFuzzyWord(text, kw))) return subtype;
  }
  if (entry.defaultSubtypeId && entry.parentKeywords.some((kw) => hasPhrase(text, kw))) {
    return entry.subtypes.find((s) => s.id === entry.defaultSubtypeId) ?? null;
  }
  return null;
}

// ─── The taxonomy ──────────────────────────────────────────────────────────

export const GROCERY_TAXONOMY: TaxonomyEntry[] = [
  {
    id: 'milk',
    matchQuery: ['milk'],
    parentKeywords: ['milk'],
    subtypes: [
      { id: 'plant-based', label: 'Plant-Based Milk', keywords: ['oat milk', 'almond milk', 'soy milk', 'coconut milk', 'cashew milk', 'plant-based', 'plant based', 'non-dairy', 'nondairy'] },
      { id: 'chocolate', label: 'Chocolate Milk', keywords: ['chocolate'] },
      { id: 'lactose-free', label: 'Lactose-Free Milk', keywords: ['lactose-free', 'lactose free', 'lactaid'] },
      { id: 'skim', label: 'Skim Milk', keywords: ['skim', 'fat-free', 'fat free', 'nonfat', 'non-fat'] },
      { id: 'one-percent', label: '1% Milk', keywords: ['1%', 'low fat', 'low-fat'] },
      { id: 'two-percent', label: '2% Milk', keywords: ['2%', 'reduced fat', 'reduced-fat'] },
      { id: 'whole', label: 'Whole Milk', keywords: ['whole milk', 'whole'] },
      { id: 'organic', label: 'Organic Milk', keywords: ['organic'] },
    ],
  },
  {
    id: 'chicken',
    matchQuery: ['chicken'],
    parentKeywords: ['chicken'],
    subtypes: [
      { id: 'ground', label: 'Ground Chicken', keywords: ['ground chicken', 'ground'] },
      { id: 'tenderloins', label: 'Chicken Tenderloins', keywords: ['tenderloin', 'tenderloins', 'tender', 'tenders'] },
      { id: 'wings', label: 'Chicken Wings', keywords: ['wing'] },
      { id: 'drumsticks', label: 'Drumsticks', keywords: ['drumstick'] },
      { id: 'thighs', label: 'Chicken Thighs', keywords: ['thigh'] },
      { id: 'breast', label: 'Chicken Breast', keywords: ['breast'] },
      { id: 'whole', label: 'Whole Chicken', keywords: ['whole chicken', 'whole fryer', 'rotisserie chicken'] },
    ],
  },
  {
    id: 'apples',
    matchQuery: ['apple', 'apples'],
    parentKeywords: ['apple'],
    subtypes: [
      { id: 'honeycrisp', label: 'Honeycrisp Apples', keywords: ['honeycrisp'] },
      { id: 'gala', label: 'Gala Apples', keywords: ['gala'] },
      { id: 'fuji', label: 'Fuji Apples', keywords: ['fuji'] },
      { id: 'granny-smith', label: 'Granny Smith Apples', keywords: ['granny smith'] },
      { id: 'pink-lady', label: 'Pink Lady Apples', keywords: ['pink lady'] },
      { id: 'red-delicious', label: 'Red Delicious Apples', keywords: ['red delicious'] },
      { id: 'golden-delicious', label: 'Golden Delicious Apples', keywords: ['golden delicious'] },
      { id: 'braeburn', label: 'Braeburn Apples', keywords: ['braeburn'] },
      { id: 'mcintosh', label: 'McIntosh Apples', keywords: ['mcintosh', 'mac apple'] },
      { id: 'cosmic-crisp', label: 'Cosmic Crisp Apples', keywords: ['cosmic crisp'] },
    ],
  },
  {
    id: 'eggs',
    matchQuery: ['egg', 'eggs'],
    parentKeywords: ['egg', 'eggs'],
    defaultSubtypeId: 'large',
    subtypes: [
      { id: 'pasture-raised', label: 'Pasture-Raised Eggs', keywords: ['pasture-raised', 'pasture raised', 'pastured'] },
      { id: 'cage-free', label: 'Cage-Free Eggs', keywords: ['cage-free', 'cage free'] },
      { id: 'organic', label: 'Organic Eggs', keywords: ['organic'] },
      { id: 'extra-large', label: 'Extra Large Eggs', keywords: ['extra large'] },
      { id: 'large', label: 'Large Eggs', keywords: ['large'] },
      { id: 'brown', label: 'Brown Eggs', keywords: ['brown'] },
      { id: 'white', label: 'White Eggs', keywords: ['white'] },
    ],
  },
  {
    id: 'bread',
    matchQuery: ['bread'],
    parentKeywords: ['bread'],
    subtypes: [
      { id: 'gluten-free', label: 'Gluten-Free Bread', keywords: ['gluten-free', 'gluten free'] },
      { id: 'sourdough', label: 'Sourdough Bread', keywords: ['sourdough'] },
      { id: 'rye', label: 'Rye Bread', keywords: ['rye'] },
      { id: 'brioche', label: 'Brioche Bread', keywords: ['brioche'] },
      { id: 'multigrain', label: 'Multigrain Bread', keywords: ['multigrain', 'multi-grain', 'multi grain'] },
      { id: 'wheat', label: 'Wheat Bread', keywords: ['wheat', 'whole wheat'] },
      { id: 'white', label: 'White Bread', keywords: ['white'] },
    ],
  },
  {
    id: 'rice',
    matchQuery: ['rice'],
    parentKeywords: ['rice'],
    subtypes: [
      { id: 'wild', label: 'Wild Rice', keywords: ['wild rice', 'wild'] },
      { id: 'arborio', label: 'Arborio Rice', keywords: ['arborio'] },
      { id: 'basmati', label: 'Basmati Rice', keywords: ['basmati'] },
      { id: 'jasmine', label: 'Jasmine Rice', keywords: ['jasmine'] },
      { id: 'brown', label: 'Brown Rice', keywords: ['brown'] },
      { id: 'white', label: 'White Rice', keywords: ['white'] },
    ],
  },
  {
    id: 'cheese',
    matchQuery: ['cheese'],
    parentKeywords: ['cheese'],
    subtypes: [
      { id: 'pepper-jack', label: 'Pepper Jack Cheese', keywords: ['pepper jack'] },
      { id: 'colby-jack', label: 'Colby Jack Cheese', keywords: ['colby jack'] },
      { id: 'parmesan', label: 'Parmesan Cheese', keywords: ['parmesan', 'parmigiano'] },
      { id: 'swiss', label: 'Swiss Cheese', keywords: ['swiss'] },
      { id: 'mozzarella', label: 'Mozzarella Cheese', keywords: ['mozzarella'] },
      { id: 'cheddar', label: 'Cheddar Cheese', keywords: ['cheddar'] },
      { id: 'american', label: 'American Cheese', keywords: ['american'] },
    ],
  },
  {
    id: 'yogurt',
    matchQuery: ['yogurt', 'yoghurt'],
    parentKeywords: ['yogurt', 'yoghurt'],
    defaultSubtypeId: 'regular',
    subtypes: [
      { id: 'dairy-free', label: 'Dairy-Free Yogurt', keywords: ['dairy-free', 'dairy free', 'non-dairy', 'plant-based'] },
      { id: 'drinkable', label: 'Drinkable Yogurt', keywords: ['drinkable', 'kefir', 'smoothie'] },
      { id: 'high-protein', label: 'High Protein Yogurt', keywords: ['high protein', 'protein'] },
      { id: 'kids', label: 'Kids Yogurt', keywords: ['kids', 'toddler'] },
      { id: 'greek', label: 'Greek Yogurt', keywords: ['greek'] },
      { id: 'regular', label: 'Regular Yogurt', keywords: ['regular'] },
    ],
  },
  {
    id: 'orange-juice',
    matchQuery: ['orange juice', 'oj'],
    parentKeywords: ['orange juice', 'oj'],
    subtypes: [
      { id: 'pulp-free', label: 'Pulp-Free Orange Juice', keywords: ['pulp free', 'pulp-free', 'no pulp'] },
      { id: 'some-pulp', label: 'Some Pulp Orange Juice', keywords: ['some pulp'] },
      { id: 'lots-of-pulp', label: 'Lots of Pulp Orange Juice', keywords: ['lots of pulp', 'high pulp', 'extra pulp'] },
      { id: 'calcium-fortified', label: 'Calcium-Fortified Orange Juice', keywords: ['calcium'] },
      { id: 'low-sugar', label: 'Low Sugar Orange Juice', keywords: ['low sugar', 'no sugar added'] },
      { id: 'organic', label: 'Organic Orange Juice', keywords: ['organic'] },
    ],
  },
  {
    id: 'peanut-butter',
    matchQuery: ['peanut butter'],
    parentKeywords: ['peanut butter'],
    subtypes: [
      { id: 'crunchy', label: 'Crunchy Peanut Butter', keywords: ['crunchy', 'chunky'] },
      { id: 'natural', label: 'Natural Peanut Butter', keywords: ['natural'] },
      { id: 'reduced-fat', label: 'Reduced Fat Peanut Butter', keywords: ['reduced fat'] },
      { id: 'creamy', label: 'Creamy Peanut Butter', keywords: ['creamy', 'smooth'] },
      { id: 'organic', label: 'Organic Peanut Butter', keywords: ['organic'] },
    ],
  },
  {
    id: 'butter',
    matchQuery: ['butter'],
    excludeQuery: ['peanut butter', 'almond butter', 'cashew butter', 'sunflower butter', 'apple butter', 'cocoa butter', 'shea butter'],
    parentKeywords: ['butter'],
    subtypes: [
      { id: 'plant-based', label: 'Plant-Based Butter', keywords: ['plant-based', 'plant based', 'vegan', 'dairy-free'] },
      { id: 'whipped', label: 'Whipped Butter', keywords: ['whipped'] },
      { id: 'european', label: 'European Style Butter', keywords: ['european style', 'european-style', 'irish'] },
      { id: 'unsalted', label: 'Unsalted Butter', keywords: ['unsalted'] },
      { id: 'salted', label: 'Salted Butter', keywords: ['salted'] },
    ],
  },
  {
    id: 'bananas',
    matchQuery: ['banana', 'bananas'],
    parentKeywords: ['banana', 'bananas'],
    defaultSubtypeId: 'conventional',
    subtypes: [
      { id: 'organic', label: 'Organic Bananas', keywords: ['organic'] },
      { id: 'conventional', label: 'Conventional Bananas', keywords: ['conventional'] },
    ],
  },
  {
    id: 'beef',
    matchQuery: ['beef'],
    parentKeywords: ['beef'],
    subtypes: [
      { id: 'ground', label: 'Ground Beef', keywords: ['ground beef', 'ground'] },
      { id: 'ribeye', label: 'Ribeye Steak', keywords: ['ribeye', 'rib eye'] },
      { id: 'sirloin', label: 'Sirloin Steak', keywords: ['sirloin'] },
      { id: 't-bone', label: 'T-Bone Steak', keywords: ['t-bone', 'tbone'] },
      { id: 'filet-mignon', label: 'Filet Mignon', keywords: ['filet mignon', 'filet'] },
      { id: 'flank', label: 'Flank Steak', keywords: ['flank'] },
      { id: 'stew-meat', label: 'Beef Stew Meat', keywords: ['stew meat', 'stew'] },
    ],
  },
  {
    id: 'pork',
    matchQuery: ['pork'],
    parentKeywords: ['pork'],
    subtypes: [
      { id: 'chops', label: 'Pork Chops', keywords: ['chop'] },
      { id: 'tenderloin', label: 'Pork Tenderloin', keywords: ['tenderloin'] },
      { id: 'ribs', label: 'Pork Ribs', keywords: ['rib'] },
      { id: 'ground', label: 'Ground Pork', keywords: ['ground pork', 'ground'] },
      { id: 'loin', label: 'Pork Loin', keywords: ['loin'] },
    ],
  },
  {
    id: 'turkey',
    matchQuery: ['turkey'],
    parentKeywords: ['turkey'],
    subtypes: [
      { id: 'ground', label: 'Ground Turkey', keywords: ['ground'] },
      { id: 'breast', label: 'Turkey Breast', keywords: ['breast'] },
      { id: 'whole', label: 'Whole Turkey', keywords: ['whole turkey', 'whole'] },
      { id: 'deli', label: 'Deli Turkey', keywords: ['deli', 'sliced'] },
    ],
  },
  {
    id: 'bacon',
    matchQuery: ['bacon'],
    parentKeywords: ['bacon'],
    defaultSubtypeId: 'regular',
    subtypes: [
      { id: 'turkey', label: 'Turkey Bacon', keywords: ['turkey'] },
      { id: 'thick-cut', label: 'Thick-Cut Bacon', keywords: ['thick-cut', 'thick cut'] },
      { id: 'center-cut', label: 'Center-Cut Bacon', keywords: ['center-cut', 'center cut'] },
      { id: 'uncured', label: 'Uncured Bacon', keywords: ['uncured'] },
      { id: 'low-sodium', label: 'Low Sodium Bacon', keywords: ['low sodium'] },
      { id: 'regular', label: 'Regular Bacon', keywords: ['classic', 'original'] },
    ],
  },
  {
    id: 'sausage',
    matchQuery: ['sausage'],
    parentKeywords: ['sausage'],
    subtypes: [
      { id: 'breakfast', label: 'Breakfast Sausage', keywords: ['breakfast'] },
      { id: 'italian', label: 'Italian Sausage', keywords: ['italian'] },
      { id: 'chicken', label: 'Chicken Sausage', keywords: ['chicken'] },
      { id: 'turkey', label: 'Turkey Sausage', keywords: ['turkey'] },
      { id: 'plant-based', label: 'Plant-Based Sausage', keywords: ['plant-based', 'plant based', 'vegan'] },
      { id: 'bratwurst', label: 'Bratwurst', keywords: ['bratwurst', 'brat'] },
    ],
  },
  {
    id: 'salmon',
    matchQuery: ['salmon'],
    parentKeywords: ['salmon'],
    subtypes: [
      { id: 'smoked', label: 'Smoked Salmon', keywords: ['smoked'] },
      { id: 'wild-caught', label: 'Wild-Caught Salmon', keywords: ['wild-caught', 'wild caught', 'wild'] },
      { id: 'farm-raised', label: 'Farm-Raised Salmon', keywords: ['farm-raised', 'farm raised', 'atlantic'] },
      { id: 'fillet', label: 'Salmon Fillet', keywords: ['fillet', 'filet'] },
    ],
  },
  {
    id: 'shrimp',
    matchQuery: ['shrimp'],
    parentKeywords: ['shrimp'],
    subtypes: [
      { id: 'cooked', label: 'Cooked Shrimp', keywords: ['cooked'] },
      { id: 'raw', label: 'Raw Shrimp', keywords: ['raw'] },
      { id: 'peeled-deveined', label: 'Peeled & Deveined Shrimp', keywords: ['peeled', 'deveined'] },
      { id: 'jumbo', label: 'Jumbo Shrimp', keywords: ['jumbo'] },
    ],
  },
  {
    id: 'pasta',
    matchQuery: ['pasta'],
    parentKeywords: ['pasta'],
    subtypes: [
      { id: 'gluten-free', label: 'Gluten-Free Pasta', keywords: ['gluten-free', 'gluten free'] },
      { id: 'whole-wheat', label: 'Whole Wheat Pasta', keywords: ['whole wheat'] },
      { id: 'spaghetti', label: 'Spaghetti', keywords: ['spaghetti'] },
      { id: 'penne', label: 'Penne Pasta', keywords: ['penne'] },
      { id: 'rigatoni', label: 'Rigatoni Pasta', keywords: ['rigatoni'] },
      { id: 'fettuccine', label: 'Fettuccine Pasta', keywords: ['fettuccine'] },
    ],
  },
  {
    id: 'coffee',
    matchQuery: ['coffee'],
    excludeQuery: ['coffee creamer', 'coffee cake'],
    parentKeywords: ['coffee'],
    subtypes: [
      { id: 'decaf', label: 'Decaf Coffee', keywords: ['decaf'] },
      { id: 'cold-brew', label: 'Cold Brew Coffee', keywords: ['cold brew'] },
      { id: 'pods', label: 'Coffee Pods', keywords: ['k-cup', 'k cup', 'pods', 'pod'] },
      { id: 'instant', label: 'Instant Coffee', keywords: ['instant'] },
      { id: 'whole-bean', label: 'Whole Bean Coffee', keywords: ['whole bean'] },
      { id: 'ground', label: 'Ground Coffee', keywords: ['ground'] },
    ],
  },
  {
    id: 'cereal',
    matchQuery: ['cereal'],
    parentKeywords: ['cereal'],
    subtypes: [
      { id: 'kids', label: 'Kids Cereal', keywords: ['kids'] },
      { id: 'frosted', label: 'Frosted Cereal', keywords: ['frosted'] },
      { id: 'bran', label: 'Bran Cereal', keywords: ['bran'] },
      { id: 'granola', label: 'Granola Cereal', keywords: ['granola'] },
      { id: 'whole-grain', label: 'Whole Grain Cereal', keywords: ['whole grain'] },
    ],
  },
  {
    id: 'potatoes',
    matchQuery: ['potato', 'potatoes'],
    parentKeywords: ['potato'],
    subtypes: [
      { id: 'sweet', label: 'Sweet Potatoes', keywords: ['sweet potato', 'sweet'] },
      { id: 'russet', label: 'Russet Potatoes', keywords: ['russet'] },
      { id: 'red', label: 'Red Potatoes', keywords: ['red'] },
      { id: 'yukon-gold', label: 'Yukon Gold Potatoes', keywords: ['yukon gold', 'yukon'] },
      { id: 'fingerling', label: 'Fingerling Potatoes', keywords: ['fingerling'] },
    ],
  },
  {
    id: 'tomatoes',
    matchQuery: ['tomato', 'tomatoes'],
    parentKeywords: ['tomato'],
    subtypes: [
      { id: 'cherry', label: 'Cherry Tomatoes', keywords: ['cherry'] },
      { id: 'grape', label: 'Grape Tomatoes', keywords: ['grape'] },
      { id: 'roma', label: 'Roma Tomatoes', keywords: ['roma'] },
      { id: 'beefsteak', label: 'Beefsteak Tomatoes', keywords: ['beefsteak'] },
      { id: 'heirloom', label: 'Heirloom Tomatoes', keywords: ['heirloom'] },
      { id: 'canned', label: 'Canned Tomatoes', keywords: ['canned', 'can'] },
    ],
  },
  {
    id: 'onions',
    matchQuery: ['onion', 'onions'],
    parentKeywords: ['onion'],
    subtypes: [
      { id: 'sweet', label: 'Sweet Onions', keywords: ['sweet', 'vidalia'] },
      { id: 'red', label: 'Red Onions', keywords: ['red'] },
      { id: 'white', label: 'White Onions', keywords: ['white'] },
      { id: 'yellow', label: 'Yellow Onions', keywords: ['yellow'] },
      { id: 'green', label: 'Green Onions', keywords: ['green onion', 'scallion', 'green'] },
    ],
  },
  {
    id: 'avocados',
    matchQuery: ['avocado', 'avocados'],
    parentKeywords: ['avocado', 'avocados'],
    defaultSubtypeId: 'conventional',
    subtypes: [
      { id: 'organic', label: 'Organic Avocados', keywords: ['organic'] },
      { id: 'conventional', label: 'Conventional Avocados', keywords: ['conventional'] },
    ],
  },
  {
    id: 'tortillas',
    matchQuery: ['tortilla', 'tortillas'],
    parentKeywords: ['tortilla'],
    subtypes: [
      { id: 'corn', label: 'Corn Tortillas', keywords: ['corn'] },
      { id: 'low-carb', label: 'Low Carb Tortillas', keywords: ['low carb', 'low-carb'] },
      { id: 'gluten-free', label: 'Gluten-Free Tortillas', keywords: ['gluten-free', 'gluten free'] },
      { id: 'whole-wheat', label: 'Whole Wheat Tortillas', keywords: ['whole wheat'] },
      { id: 'flour', label: 'Flour Tortillas', keywords: ['flour'] },
    ],
  },
  {
    id: 'chips',
    matchQuery: ['chips'],
    parentKeywords: ['chip'],
    subtypes: [
      { id: 'tortilla', label: 'Tortilla Chips', keywords: ['tortilla'] },
      { id: 'kettle-cooked', label: 'Kettle-Cooked Chips', keywords: ['kettle-cooked', 'kettle cooked', 'kettle'] },
      { id: 'baked', label: 'Baked Chips', keywords: ['baked'] },
      { id: 'multigrain', label: 'Multigrain Chips', keywords: ['multigrain'] },
      { id: 'potato', label: 'Potato Chips', keywords: ['potato'] },
    ],
  },
  {
    id: 'crackers',
    matchQuery: ['crackers', 'cracker'],
    parentKeywords: ['cracker'],
    subtypes: [
      { id: 'gluten-free', label: 'Gluten-Free Crackers', keywords: ['gluten-free', 'gluten free'] },
      { id: 'whole-wheat', label: 'Whole Wheat Crackers', keywords: ['whole wheat'] },
      { id: 'cheese', label: 'Cheese Crackers', keywords: ['cheese'] },
      { id: 'saltine', label: 'Saltine Crackers', keywords: ['saltine'] },
      { id: 'water', label: 'Water Crackers', keywords: ['water cracker', 'water'] },
    ],
  },
  {
    id: 'ice-cream',
    matchQuery: ['ice cream'],
    parentKeywords: ['ice cream'],
    subtypes: [
      { id: 'non-dairy', label: 'Non-Dairy Ice Cream', keywords: ['non-dairy', 'dairy-free', 'vegan', 'plant-based'] },
      { id: 'low-sugar', label: 'Low Sugar Ice Cream', keywords: ['low sugar', 'light', 'keto'] },
      { id: 'cookies-and-cream', label: 'Cookies and Cream Ice Cream', keywords: ['cookies and cream', 'cookies & cream'] },
      { id: 'chocolate', label: 'Chocolate Ice Cream', keywords: ['chocolate'] },
      { id: 'vanilla', label: 'Vanilla Ice Cream', keywords: ['vanilla'] },
    ],
  },
];
