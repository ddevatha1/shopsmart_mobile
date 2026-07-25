// Pure, network-free tests for the compatibility-classification logic —
// no real browser involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCompatibility } from './StoreDiscoveryRunner.ts';
import type { DiscoveryReport } from './StoreDiscoveryRunner.ts';

function baseReport(overrides: Partial<DiscoveryReport> = {}): DiscoveryReport {
  return {
    store: 'Example Grocer',
    websiteLoaded: true,
    searchAvailable: true,
    locationCanBeSet: true,
    productApiDetected: true,
    productsExtracted: 5,
    confidenceScore: 0.9,
    blockers: [],
    ...overrides,
  };
}

test('a clean run with real products and no blockers is compatible', () => {
  const result = classifyCompatibility(baseReport());
  assert.equal(result.status, 'compatible');
});

test('a bot-challenge blocker is classified as blocked, not incompatible', () => {
  const report = baseReport({
    websiteLoaded: false,
    productsExtracted: 0,
    blockers: ['Homepage appears to be a bot-challenge interstitial (matched "just a moment").'],
  });
  const result = classifyCompatibility(report);
  assert.equal(result.status, 'blocked');
  assert.match(result.reason ?? '', /challenge/);
});

test('a login-wall blocker is classified as blocked', () => {
  const report = baseReport({
    blockers: ['A password input is visible on the homepage — this store appears to require login before browsing.'],
  });
  const result = classifyCompatibility(report);
  assert.equal(result.status, 'blocked');
});

test('an HTTP error status is classified as blocked', () => {
  const report = baseReport({ websiteLoaded: false, blockers: ['Homepage responded with HTTP 403.'] });
  const result = classifyCompatibility(report);
  assert.equal(result.status, 'blocked');
});

test('a site that loads fine but yields zero products is incompatible, not blocked', () => {
  const report = baseReport({ productsExtracted: 0, searchAvailable: false, blockers: ['No search input was found and no URL/network change was observed after attempting a search.'] });
  const result = classifyCompatibility(report);
  assert.equal(result.status, 'incompatible');
});

test('products extracted but with unreliable relevance ranking is incompatible, not compatible', () => {
  const report = baseReport({
    productsExtracted: 3,
    blockers: ['Products were extracted, but none ranked as a confident match — relevance ranking is not reliable for this store yet.'],
  });
  const result = classifyCompatibility(report);
  assert.equal(result.status, 'incompatible');
});
