// Tests the pure, network-free pieces of the Kroger locator: mapping a raw
// Locations API record to a StoreLocation (or rejecting an incomplete one),
// and ranking candidates by real distance. No network access needed.
//
// Run with: npm test (from backend/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toStoreLocation, sortByDistanceFrom, type KrogerLocationRecord } from './krogerLocator.ts';

const FRISCO_STORE: KrogerLocationRecord = {
  locationId: '01400943',
  name: 'Frisco Main Street Village',
  address: { addressLine1: '3205 Main St', city: 'Frisco', state: 'TX', zipCode: '75034' },
  geolocation: { latitude: 33.1510134, longitude: -96.8619029 },
};

test('toStoreLocation maps a complete Kroger record, including source/metadata', () => {
  const loc = toStoreLocation(FRISCO_STORE);
  assert.ok(loc, 'expected a StoreLocation, got undefined');
  assert.equal(loc!.address, '3205 Main St');
  assert.equal(loc!.city, 'Frisco');
  assert.equal(loc!.state, 'TX');
  assert.equal(loc!.zip, '75034');
  assert.equal(loc!.latitude, 33.1510134);
  assert.equal(loc!.longitude, -96.8619029);
  assert.equal(loc!.source, 'kroger-api');
  assert.equal(loc!.metadata?.locationId, '01400943');
});

test('toStoreLocation never fabricates an address — returns undefined when required fields are missing', () => {
  assert.equal(toStoreLocation({ locationId: '1', address: { city: 'Frisco' } }), undefined, 'missing street/state/zip');
  assert.equal(toStoreLocation({ locationId: '2' }), undefined, 'no address object at all');
  assert.equal(
    toStoreLocation({ locationId: '3', address: { addressLine1: '1 Main St', city: 'X', state: 'TX', zipCode: '' } }),
    undefined,
    'empty zip still counts as missing',
  );
});

test('sortByDistanceFrom picks the true nearest candidate, not API order', () => {
  const near: KrogerLocationRecord = { ...FRISCO_STORE, locationId: 'near', geolocation: { latitude: 33.15, longitude: -96.86 } };
  const far: KrogerLocationRecord = { ...FRISCO_STORE, locationId: 'far', geolocation: { latitude: 32.7, longitude: -97.3 } }; // Fort Worth-ish
  // API returns the farther one first — sort should still put `near` first.
  const ranked = sortByDistanceFrom({ latitude: 33.1510134, longitude: -96.8619029 }, [far, near]);
  assert.equal(ranked[0].locationId, 'near');
  assert.equal(ranked[1].locationId, 'far');
});

test('sortByDistanceFrom sorts candidates without coordinates last, not dropped', () => {
  const noCoords: KrogerLocationRecord = { ...FRISCO_STORE, locationId: 'no-coords', geolocation: undefined };
  const withCoords: KrogerLocationRecord = { ...FRISCO_STORE, locationId: 'with-coords' };
  const ranked = sortByDistanceFrom({ latitude: 33.1510134, longitude: -96.8619029 }, [noCoords, withCoords]);
  assert.equal(ranked.length, 2, 'candidate with no coordinates should be kept, not dropped');
  assert.equal(ranked[0].locationId, 'with-coords');
  assert.equal(ranked[1].locationId, 'no-coords');
});
