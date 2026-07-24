// Tests the pure, network-free pieces of the Albertsons locator: pulling
// the embedded `Yext.Profile` JSON out of a real store page's HTML (no JS
// execution, no login) and mapping it to a StoreLocation. The fixture is a
// trimmed real capture from a live local.albertsons.com store page (see
// __fixtures__/albertsons-profile.json) — real address/coordinates/store
// ID, just with the ~700 unrelated amenity/hours/link fields stripped out.
//
// Run with: npm test (from backend/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractBalancedJson, parseAlbertsonsProfile } from './albertsonsLocator.ts';

const REAL_PROFILE_JSON = readFileSync(new URL('./__fixtures__/albertsons-profile.json', import.meta.url), 'utf-8');

// Wraps the real fixture the same way a real store page embeds it — a
// `<script>` tag assigning `Yext.Profile = {...}` inline, with unrelated
// surrounding markup, matching what extractBalancedJson has to scan past.
function wrapAsStorePageHtml(profileJson: string): string {
  return (
    `<!doctype html><html><head><script>window.Yext = (function(Yext){Yext["locale"] = "en"; return Yext;})(window.Yext || {});</script></head>` +
    `<body><script type="text/javascript">window.Yext = (function(Yext){Yext.Profile = ${profileJson}; return Yext;})(window.Yext || {});</script>` +
    `<p>Some trailing markup with a stray {"not": "the profile"} object in it.</p></body></html>`
  );
}

test('extractBalancedJson pulls out exactly the Yext.Profile object, ignoring braces elsewhere on the page', () => {
  const html = wrapAsStorePageHtml(REAL_PROFILE_JSON);
  const extracted = extractBalancedJson(html, 'Yext.Profile');
  assert.ok(extracted, 'expected a match');
  const parsed = JSON.parse(extracted!);
  assert.equal(parsed.meta.id, '269');
});

test('extractBalancedJson returns undefined when the marker is not present', () => {
  assert.equal(extractBalancedJson('<html><body>no profile here</body></html>', 'Yext.Profile'), undefined);
});

test('parseAlbertsonsProfile maps a real captured store page to a complete StoreLocation', () => {
  const html = wrapAsStorePageHtml(REAL_PROFILE_JSON);
  const loc = parseAlbertsonsProfile(html);
  assert.ok(loc, 'expected a StoreLocation, got undefined');
  assert.equal(loc!.address, '2150 N Josey Ln');
  assert.equal(loc!.city, 'Carrollton');
  assert.equal(loc!.state, 'TX');
  assert.equal(loc!.zip, '75006');
  assert.equal(loc!.latitude, 32.9743051);
  assert.equal(loc!.longitude, -96.888423);
  assert.equal(loc!.storeId, '269');
  assert.equal(loc!.source, 'albertsons-sitemap');
  assert.match(loc!.name, /Carrollton/);
});

test('parseAlbertsonsProfile never fabricates an address — returns undefined when required fields are missing', () => {
  const incomplete = JSON.stringify({ address: { city: 'Carrollton' }, meta: { id: '1' } });
  assert.equal(parseAlbertsonsProfile(wrapAsStorePageHtml(incomplete)), undefined);
  assert.equal(parseAlbertsonsProfile('<html><body>no Yext.Profile at all</body></html>'), undefined);
});
