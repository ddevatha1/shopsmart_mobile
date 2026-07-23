import { haversineDistanceMiles, formatMiles } from '../geo';

describe('haversineDistanceMiles', () => {
  test('returns 0 for identical coordinates', () => {
    const point = { latitude: 30.2672, longitude: -97.7431 };
    expect(haversineDistanceMiles(point, point)).toBeCloseTo(0, 5);
  });

  test('computes a known distance (Austin to Dallas, ~182 miles)', () => {
    const austin = { latitude: 30.2672, longitude: -97.7431 };
    const dallas = { latitude: 32.7767, longitude: -96.7970 };
    const miles = haversineDistanceMiles(austin, dallas);
    expect(miles).toBeGreaterThan(170);
    expect(miles).toBeLessThan(195);
  });

  test('is symmetric regardless of argument order', () => {
    const a = { latitude: 30.2672, longitude: -97.7431 };
    const b = { latitude: 32.7767, longitude: -96.7970 };
    expect(haversineDistanceMiles(a, b)).toBeCloseTo(haversineDistanceMiles(b, a), 10);
  });

  test('handles the antimeridian/negative longitude correctly', () => {
    const a = { latitude: 0, longitude: 179 };
    const b = { latitude: 0, longitude: -179 };
    // These points are 2 degrees of longitude apart at the equator, not 358.
    const miles = haversineDistanceMiles(a, b);
    expect(miles).toBeLessThan(200);
  });
});

describe('formatMiles', () => {
  test('shows "nearby" for very small distances', () => {
    expect(formatMiles(0)).toBe('nearby');
    expect(formatMiles(0.05)).toBe('nearby');
  });

  test('shows one decimal place under 10 miles', () => {
    expect(formatMiles(3.456)).toBe('3.5 mi');
    expect(formatMiles(9.99)).toBe('10.0 mi');
  });

  test('rounds to a whole number at 10 miles and above', () => {
    expect(formatMiles(10)).toBe('10 mi');
    expect(formatMiles(142.6)).toBe('143 mi');
  });
});
