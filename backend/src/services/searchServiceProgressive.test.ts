// Run with: npm test
//
// startProgressiveSearch itself isn't unit-tested here — it calls the real
// store scrapers directly (searchTraderJoesWithTimeout etc.), same as
// performSearch, and this codebase's convention for that kind of code is
// real end-to-end verification against a running server, not a mocked
// unit test (see this task's own "Production testing"/"Testing" sections).
// What IS meaningfully unit-testable without network access is
// getSearchSnapshot's own contract for a searchId no session exists for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSearchSnapshot } from './searchService.ts';

test('getSearchSnapshot returns null for an unknown searchId, never a fabricated empty result', () => {
  const result = getSearchSnapshot('does-not-exist');
  assert.equal(result, null);
});

test('getSearchSnapshot returns null for an empty-string searchId', () => {
  const result = getSearchSnapshot('');
  assert.equal(result, null);
});
