// Run with: npm test
//
// Tests isStoreOpenNow/isKnownClosed — pure, synchronous, deterministic
// (a fixed `currentDate` is always passed explicitly, never `new Date()`),
// no network. Same convention as nutritionScoringService.test.ts /
// budgetAnalysisService.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStoreOpenNow, isKnownClosed } from './storeReliabilityService.ts';
import type { StoreLocation } from '../types/index.ts';

function fakeStore(hours?: StoreLocation['hours']): StoreLocation {
  return { name: 'Test Store', address: '1 Main St', city: 'Springfield', state: 'TX', zip: '78701', source: 'test-fixture', hours };
}

// A Wednesday (2024-01-03 is a Wednesday) at 10:00 local time.
const WEDNESDAY_10AM = new Date(2024, 0, 3, 10, 0);
const WEDNESDAY_11PM = new Date(2024, 0, 3, 23, 0);
// A Sunday (2024-01-07).
const SUNDAY_10AM = new Date(2024, 0, 7, 10, 0);

test('1. A store with no hours at all returns undefined (unknown), never a fabricated answer', () => {
  const store = fakeStore(undefined);
  assert.equal(isStoreOpenNow(store, WEDNESDAY_10AM), undefined);
  assert.equal(isKnownClosed(store, WEDNESDAY_10AM), false); // unknown is never "known closed"
});

test('2. A store with an explicit closed:true for today is confirmed closed, regardless of time', () => {
  const store = fakeStore({ wednesday: { closed: true } });
  assert.equal(isStoreOpenNow(store, WEDNESDAY_10AM), false);
  assert.equal(isKnownClosed(store, WEDNESDAY_10AM), true);
  assert.equal(isKnownClosed(store, WEDNESDAY_11PM), true);
});

test('3. A store within its open window right now is confirmed open', () => {
  const store = fakeStore({ wednesday: { open: '08:00', close: '22:00' } });
  assert.equal(isStoreOpenNow(store, WEDNESDAY_10AM), true);
  assert.equal(isKnownClosed(store, WEDNESDAY_10AM), false);
});

test('4. A store outside its open window right now is confirmed closed', () => {
  const store = fakeStore({ wednesday: { open: '08:00', close: '22:00' } });
  assert.equal(isStoreOpenNow(store, WEDNESDAY_11PM), false);
  assert.equal(isKnownClosed(store, WEDNESDAY_11PM), true);
});

test('5. Missing data for today specifically (other days present) does not crash and is unknown', () => {
  const store = fakeStore({ monday: { open: '08:00', close: '22:00' } }); // no wednesday entry
  assert.doesNotThrow(() => isStoreOpenNow(store, WEDNESDAY_10AM));
  assert.equal(isStoreOpenNow(store, WEDNESDAY_10AM), undefined);
  assert.equal(isKnownClosed(store, WEDNESDAY_10AM), false);
});

test('6. Invalid/malformed hour formatting does not crash and resolves to unknown', () => {
  const badFormat = fakeStore({ wednesday: { open: '9am', close: '11pm' } });
  assert.doesNotThrow(() => isStoreOpenNow(badFormat, WEDNESDAY_10AM));
  assert.equal(isStoreOpenNow(badFormat, WEDNESDAY_10AM), undefined);

  const wrongType = fakeStore({ wednesday: { open: 900, close: 2300 } } as any);
  assert.doesNotThrow(() => isStoreOpenNow(wrongType, WEDNESDAY_10AM));
  assert.equal(isStoreOpenNow(wrongType, WEDNESDAY_10AM), undefined);

  const onlyOpen = fakeStore({ wednesday: { open: '08:00' } });
  assert.doesNotThrow(() => isStoreOpenNow(onlyOpen, WEDNESDAY_10AM));
  assert.equal(isStoreOpenNow(onlyOpen, WEDNESDAY_10AM), undefined);

  const overnight = fakeStore({ wednesday: { open: '22:00', close: '02:00' } });
  assert.doesNotThrow(() => isStoreOpenNow(overnight, WEDNESDAY_11PM));
  assert.equal(isStoreOpenNow(overnight, WEDNESDAY_11PM), undefined, 'unmodeled overnight window stays unknown, never guessed');
});

test('checks the correct day of week — a Sunday-only closure does not affect a Wednesday check', () => {
  const store = fakeStore({ sunday: { closed: true }, wednesday: { open: '08:00', close: '22:00' } });
  assert.equal(isKnownClosed(store, SUNDAY_10AM), true);
  assert.equal(isKnownClosed(store, WEDNESDAY_10AM), false);
  assert.equal(isStoreOpenNow(store, WEDNESDAY_10AM), true);
});

test('a boundary time exactly at close is treated as closed (half-open interval)', () => {
  const store = fakeStore({ wednesday: { open: '08:00', close: '22:00' } });
  const exactlyAtClose = new Date(2024, 0, 3, 22, 0);
  assert.equal(isStoreOpenNow(store, exactlyAtClose), false);
});
