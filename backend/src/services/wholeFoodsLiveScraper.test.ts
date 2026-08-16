// Tests the pure, network-free pieces of the Whole Foods scraper:
// pulling the `__NEXT_DATA__` product payload out of the search page's raw
// HTML, and mapping a raw product record to an ApiProduct (or rejecting an
// incomplete one). Same convention as tomThumbLocator.test.ts/
// krogerLocator.test.ts — no network access, no fetch/cookie mocking (this
// repo's test suite doesn't mock fetch anywhere; the network-calling
// orchestration functions — getBaseCookies, getStoreSessionCookie,
// fetchSearchResults, searchWholeFoods — are exercised indirectly through
// these building blocks instead). Session/cache reuse itself isn't
// unit-tested here for the same reason — it's built on the already-tested
// TtlCache/dedupeInFlight utilities, same as every other store adapter.
//
// The fixtures (__fixtures__/wholefoods-products.json) are two real,
// live-captured product records from a real "bananas" search result: one
// plain item and one on sale.
//
// Run with: npm test (from backend/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractNextData, normalizeWholeFoodsProduct, type WholeFoodsRawProduct } from './wholeFoodsLiveScraper.ts';

const [PLAIN_PRODUCT, SALE_PRODUCT] = JSON.parse(
  readFileSync(new URL('./__fixtures__/wholefoods-products.json', import.meta.url), 'utf-8'),
) as WholeFoodsRawProduct[];

function wrapAsSearchPageHtml(nextData: unknown): string {
  return (
    `<!doctype html><html><head></head><body><div id="__next"></div>` +
    `<script id="__next_data" type="application/json" data-n-head=""></script>` +
    `<p>Some trailing markup with a stray {"not": "the payload"} object in it.</p>` +
    `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>` +
    `</body></html>`
  );
}

test('extractNextData pulls the real product payload out of a search page, ignoring braces elsewhere', () => {
  const html = wrapAsSearchPageHtml({ props: { pageProps: { pageType: 'search', productsInfo: [PLAIN_PRODUCT] } } });
  const data = extractNextData(html);
  assert.ok(data, 'expected parsed NEXT_DATA, got undefined');
  assert.equal(data!.props?.pageProps?.productsInfo?.length, 1);
  assert.equal(data!.props?.pageProps?.productsInfo?.[0].asin, PLAIN_PRODUCT.asin);
});

test('extractNextData returns undefined when the marker is not present', () => {
  assert.equal(extractNextData('<html><body>no next data here</body></html>'), undefined);
});

test('extractNextData returns undefined for malformed JSON rather than throwing', () => {
  const html = '<script id="__NEXT_DATA__" type="application/json">{not valid json</script>';
  assert.doesNotThrow(() => extractNextData(html));
  assert.equal(extractNextData(html), undefined);
});

test('normalizeWholeFoodsProduct maps a real plain product to a complete ApiProduct', () => {
  const p = normalizeWholeFoodsProduct(PLAIN_PRODUCT);
  assert.ok(p, 'expected an ApiProduct, got null');
  assert.equal(p!.id, `wholefoods-${PLAIN_PRODUCT.asin}`);
  assert.equal(p!.name, 'Organic Banana, 1 Each');
  // toTitleCase (shared with every other store adapter) title-cases per
  // space-separated token — "(Brands" isn't recognized as a word boundary,
  // so the letter right after the paren is lowercased, same as it would be
  // for any other store's brand string through this same shared utility.
  assert.equal(p!.brand, 'Fresh Produce (brands May Vary)');
  assert.equal(p!.price, 0.79);
  assert.equal(p!.originalPrice, undefined, 'no basisPriceAmount on this item — not a sale');
  assert.equal(p!.image_url, PLAIN_PRODUCT.productImages?.[0]);
  assert.equal(p!.size, '1 Each', 'derived from the text after the last comma in the name');
  assert.equal(p!.store, 'Whole Foods Market');
  assert.equal(p!.isLiveData, true);
  assert.equal(p!.inStock, true);
});

test('normalizeWholeFoodsProduct carries a real sale price through as originalPrice/discountPercent', () => {
  const p = normalizeWholeFoodsProduct(SALE_PRODUCT);
  assert.ok(p);
  const basis = SALE_PRODUCT.offerDetails!.price!.basisPriceAmount!;
  assert.equal(p!.price, SALE_PRODUCT.offerDetails!.price!.priceAmount);
  assert.equal(p!.originalPrice, basis);
  assert.ok(p!.discountPercent! > 0);
});

test('normalizeWholeFoodsProduct passes the given store location through unchanged', () => {
  const location = { name: 'Whole Foods Market - McKinney', address: '8701 W University Dr.', city: 'McKinney', state: 'TX', zip: '75071', source: 'wholefoodsmarket-api' };
  const p = normalizeWholeFoodsProduct(PLAIN_PRODUCT, location);
  assert.deepEqual(p!.location, location);
});

test('normalizeWholeFoodsProduct falls back to an empty size when the name has no comma', () => {
  const p = normalizeWholeFoodsProduct({ ...PLAIN_PRODUCT, name: 'Organic Blueberries Pint' });
  assert.equal(p!.size, '');
});

test('normalizeWholeFoodsProduct never fabricates a product — returns null when required fields are missing or invalid', () => {
  assert.equal(normalizeWholeFoodsProduct({ ...PLAIN_PRODUCT, name: undefined }), null, 'no name');
  assert.equal(normalizeWholeFoodsProduct({ ...PLAIN_PRODUCT, asin: undefined }), null, 'no asin');
  assert.equal(
    normalizeWholeFoodsProduct({ ...PLAIN_PRODUCT, offerDetails: undefined }),
    null,
    'no price at all',
  );
  assert.equal(
    normalizeWholeFoodsProduct({ ...PLAIN_PRODUCT, offerDetails: { price: { priceAmount: 0 } } }),
    null,
    'zero price is not a real, purchasable price',
  );
  assert.equal(
    normalizeWholeFoodsProduct({ ...PLAIN_PRODUCT, offerDetails: { price: { priceAmount: -1 } } }),
    null,
    'negative price is never valid',
  );
});

test('normalizeWholeFoodsProduct treats an explicit OUT_OF_STOCK as not in stock, everything else as in stock', () => {
  assert.equal(normalizeWholeFoodsProduct({ ...PLAIN_PRODUCT, availability: 'OUT_OF_STOCK' })!.inStock, false);
  assert.equal(normalizeWholeFoodsProduct({ ...PLAIN_PRODUCT, availability: undefined })!.inStock, true);
});
