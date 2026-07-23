import { buildAttributeDefs, buildSizeOptions, buildSortOptions, buildFilterSchema } from '../filterSchemaService';
import type { ApiProduct } from '../../models/types';

function makeProduct(overrides: Partial<ApiProduct> = {}): ApiProduct {
  return {
    id: `p-${Math.random()}`,
    name: 'Whole Milk',
    brand: 'Store Brand',
    price: 3.99,
    rating: 4.5,
    size: '1 gal',
    store: 'Aldi',
    ...overrides,
  };
}

describe('buildAttributeDefs', () => {
  test('offers a milk fat-content facet only with the fat levels actually present', () => {
    const listings = [
      makeProduct({ name: 'Whole Milk' }),
      makeProduct({ name: '2% Reduced Fat Milk' }),
    ];
    const defs = buildAttributeDefs(listings);
    const fatContent = defs.find((d) => d.key === 'fat-content');
    expect(fatContent).toBeDefined();
    expect(fatContent!.options.map((o) => o.value).sort()).toEqual(['2%', 'whole']);
    // Skim wasn't present in this result set, so it must not be offered.
    expect(fatContent!.options.some((o) => o.value === 'skim')).toBe(false);
  });

  test('does not offer a facet with zero matching listings', () => {
    const listings = [makeProduct({ name: 'Whole Milk' })];
    const defs = buildAttributeDefs(listings);
    expect(defs.find((d) => d.key === 'lactose-free')).toBeUndefined();
  });

  test('offers the universal "Organic" facet only when at least one listing is organic', () => {
    const withOrganic = buildAttributeDefs([makeProduct({ name: 'Organic Whole Milk' })]);
    expect(withOrganic.find((d) => d.key === 'organic')).toBeDefined();

    const withoutOrganic = buildAttributeDefs([makeProduct({ name: 'Whole Milk' })]);
    expect(withoutOrganic.find((d) => d.key === 'organic')).toBeUndefined();
  });

  test('offers a Brand/Store facet only when more than one distinct value is present', () => {
    const oneStore = buildAttributeDefs([makeProduct({ store: 'Aldi' }), makeProduct({ store: 'Aldi' })]);
    expect(oneStore.find((d) => d.key === 'store')).toBeUndefined();

    const twoStores = buildAttributeDefs([makeProduct({ store: 'Aldi' }), makeProduct({ store: 'Kroger' })]);
    expect(twoStores.find((d) => d.key === 'store')).toBeDefined();
  });

  test('falls back to only universal facets for a product kind with no curated taxonomy', () => {
    const defs = buildAttributeDefs([makeProduct({ name: 'Sparkling Water', store: 'Aldi' }), makeProduct({ name: 'Sparkling Water', store: 'Kroger' })]);
    expect(defs.find((d) => d.key === 'fat-content')).toBeUndefined();
    expect(defs.find((d) => d.key === 'store')).toBeDefined();
  });
});

describe('buildSizeOptions', () => {
  test('returns each distinct real size, deduplicated', () => {
    const sizes = buildSizeOptions([
      makeProduct({ size: '1 gal' }),
      makeProduct({ size: '1 gal' }),
      makeProduct({ size: 'Half Gallon' }),
    ]);
    expect(sizes).toEqual(['1 gal', 'Half Gallon']);
  });

  test('never invents a size for a listing without one', () => {
    const sizes = buildSizeOptions([makeProduct({ size: '' })]);
    expect(sizes).toEqual([]);
  });
});

describe('buildSortOptions', () => {
  test('always offers the universal sort options', () => {
    const options = buildSortOptions([makeProduct()]).map((o) => o.value);
    expect(options).toEqual(expect.arrayContaining(['best_value', 'lowest_unit_price', 'lowest_total', 'closest', 'highest_rated']));
  });

  test('offers "Organic First" only when at least one listing is organic', () => {
    const withOrganic = buildSortOptions([makeProduct({ name: 'Organic Whole Milk' })]);
    expect(withOrganic.some((o) => o.value === 'organic_first')).toBe(true);

    const withoutOrganic = buildSortOptions([makeProduct({ name: 'Whole Milk' })]);
    expect(withoutOrganic.some((o) => o.value === 'organic_first')).toBe(false);
  });

  test('never offers a "Freshest" option — no such data exists on ApiProduct', () => {
    const options = buildSortOptions([makeProduct()]);
    expect(options.some((o) => o.label.toLowerCase().includes('fresh'))).toBe(false);
  });
});

describe('buildFilterSchema', () => {
  test('combines sort options, size options, and attribute defs into one schema', () => {
    const schema = buildFilterSchema([makeProduct({ name: 'Organic Whole Milk', size: '1 gal' })]);
    expect(schema.sortOptions.length).toBeGreaterThan(0);
    expect(schema.sizeOptions).toEqual(['1 gal']);
    expect(schema.attributes.some((a) => a.key === 'organic')).toBe(true);
  });
});
