import type { StoreLocation } from '../../types/index.ts';
import { TtlCache } from '../../utils/ttlCache.ts';
import { dedupeInFlight } from '../../utils/dedupeInFlight.ts';
import { withTimeout } from '../../utils/withTimeout.ts';
import { geocodeZip } from '../../utils/geocode.ts';
import { markStoreReady } from '../storeReadiness.ts';
import type { PreciseCoords, StoreLocator } from './types.ts';

/**
 * Publix has no e-commerce platform of its own — publix.com and
 * delivery.publix.com both just front Instacart's actual consumer
 * marketplace (confirmed live: delivery.publix.com/ redirects straight to
 * /store/publix/storefront, issues a plain anonymous `__Host-instacart_sid`
 * cookie from an ordinary homepage GET — same mechanism as aldi.us/
 * shop.sprouts.com — and its GraphQL responses carry Instacart's own
 * `RetailersShop`/`RetailersRetailer` types verbatim). Unlike Aldi/Sprouts,
 * there's no retailer-specific `idp/v1/shops` REST locator here — store
 * resolution goes through Instacart's own multi-retailer GraphQL operations
 * instead, all confirmed live and reachable with plain HTTP (no browser,
 * no login):
 *
 *   1. `DefaultShop(postalCode, coordinates)` -> `{ id: shopId,
 *      retailerLocationId }`. Coordinates come from this app's own
 *      `geocodeZip` (or the shopper's real GPS fix, when available) — the
 *      real site's own address form geocodes the same way before calling
 *      this same operation.
 *   2. `GetRetailerLocationAddress(id: retailerLocationId)` -> real store
 *      name (`locationDisplayNameString`, e.g. "Publix #714 - Baypoint"),
 *      street address, and precise lat/lng — this persisted-query hash was
 *      confirmed to work verbatim across two different Instacart-fronted
 *      domains (instacart.com's own Market Street storefront and
 *      delivery.publix.com), so it's a platform-wide operation, not
 *      something reverse-engineered per retailer.
 *
 * Both calls are plain `GET /graphql?operationName=...` requests carrying
 * only the anonymous session cookie — no CAPTCHA, no WAF challenge, no
 * account anywhere in this flow (confirmed live, repeatedly, across
 * multiple fresh sessions and zips).
 */
const PUBLIX_GRAPHQL_URL = 'https://delivery.publix.com/graphql';
// Real, previously-documented, platform-wide persisted-query identifiers —
// API contract identifiers baked into every visitor's page load (same
// status as Tom Thumb's `ocp-apim-subscription-key`, not a secret), not
// something this app invented.
const DEFAULT_SHOP_QUERY_HASH = 'd389a8d33d63801f1ce5c4929fb181dd10c57b49c3a2dcb6a6baa44212e8e069';
const RETAILER_LOCATION_ADDRESS_QUERY_HASH = 'b80a5ef08c6fe88df0b9a2e78a099dd6141345b213df0f9f517803674b6eee94';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

interface DefaultShopResponse {
  data?: {
    defaultShop?: {
      id?: string;
      retailerLocationId?: string;
    } | null;
  };
}
interface RetailerLocationAddressResponse {
  data?: {
    retailerLocation?: {
      coordinates?: { latitude?: number; longitude?: number };
      viewSection?: {
        locationDisplayNameString?: string;
        address?: {
          lineOneString?: string;
          lineTwoString?: string; // "City, ST 12345"
        };
      };
    } | null;
  };
}

const locationCache = new TtlCache<StoreLocation>(60 * 60 * 1000); // 1 hour

async function graphqlGet<T>(
  operationName: string,
  variables: Record<string, unknown>,
  queryHash: string,
  sessionCookie: string,
): Promise<T> {
  const url = new URL(PUBLIX_GRAPHQL_URL);
  url.searchParams.set('operationName', operationName);
  url.searchParams.set('variables', JSON.stringify(variables));
  url.searchParams.set('extensions', JSON.stringify({ persistedQuery: { version: 1, sha256Hash: queryHash } }));

  const res = await withTimeout(
    fetch(url.toString(), {
      headers: {
        accept: '*/*',
        'user-agent': USER_AGENT,
        referer: 'https://delivery.publix.com/store/publix/storefront',
        cookie: sessionCookie,
      },
    }),
    8000,
    `Publix ${operationName}`,
  );
  if (!res.ok) throw new Error(`Publix ${operationName} failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

// "City, ST 12345" — the only shape observed live across every store this
// app has queried; falls back to leaving city/state/zip unset (caller
// treats that as an incomplete candidate) rather than guessing. Exported
// so this parsing (the one genuinely pure, network-free piece of this
// locator) is directly testable — see publixLocator.test.ts.
export function parseCityStateZip(lineTwo: string | undefined): { city?: string; state?: string; zip?: string } {
  const match = lineTwo?.match(/^(.+),\s*([A-Z]{2})\s+(\d{5})/);
  if (!match) return {};
  return { city: match[1], state: match[2], zip: match[3] };
}

function cacheKey(zip: string, preciseCoords?: PreciseCoords): string {
  return preciseCoords
    ? `${zip}:${preciseCoords.latitude.toFixed(2)},${preciseCoords.longitude.toFixed(2)}`
    : zip;
}

export function createPublixLocator(getSessionCookie: () => Promise<string>): StoreLocator {
  return {
    async findNearestStore(zip: string, preciseCoords?: PreciseCoords): Promise<StoreLocation | undefined> {
      return dedupeInFlight(`publix-locate:${cacheKey(zip, preciseCoords)}`, () =>
        findNearestStoreUncached(zip, preciseCoords, getSessionCookie),
      );
    },
  };
}

export async function findNearestStoreUncached(
  zip: string,
  preciseCoords: PreciseCoords | undefined,
  getSessionCookie: () => Promise<string>,
): Promise<StoreLocation | undefined> {
  const key = cacheKey(zip, preciseCoords);
  const cached = locationCache.get(key);
  if (cached) return cached;

  const coords = preciseCoords ?? (await geocodeZip(zip)) ?? undefined;
  if (!coords) {
    console.log(`[PublixLocator] zip=${zip} -> could not geocode a coordinate to resolve a store from.`);
    return undefined;
  }

  const sessionCookie = await getSessionCookie();

  let shopId: string | undefined;
  let retailerLocationId: string | undefined;
  try {
    const shopJson = await graphqlGet<DefaultShopResponse>(
      'DefaultShop',
      { postalCode: zip, coordinates: { latitude: coords.latitude, longitude: coords.longitude }, addressId: null },
      DEFAULT_SHOP_QUERY_HASH,
      sessionCookie,
    );
    shopId = shopJson.data?.defaultShop?.id;
    retailerLocationId = shopJson.data?.defaultShop?.retailerLocationId;
  } catch (err) {
    console.warn(`[PublixLocator] zip=${zip} -> DefaultShop lookup failed:`, err);
    return undefined;
  }

  if (!shopId || !retailerLocationId) {
    console.log(`[PublixLocator] zip=${zip} -> no Publix shop resolved for this location.`);
    return undefined;
  }

  let name: string | undefined;
  let address: string | undefined;
  let city: string | undefined;
  let state: string | undefined;
  let resultZip: string | undefined;
  let latitude: number | undefined;
  let longitude: number | undefined;
  try {
    const addrJson = await graphqlGet<RetailerLocationAddressResponse>(
      'GetRetailerLocationAddress',
      { id: retailerLocationId },
      RETAILER_LOCATION_ADDRESS_QUERY_HASH,
      sessionCookie,
    );
    const loc = addrJson.data?.retailerLocation;
    name = loc?.viewSection?.locationDisplayNameString;
    address = loc?.viewSection?.address?.lineOneString;
    ({ city, state, zip: resultZip } = parseCityStateZip(loc?.viewSection?.address?.lineTwoString));
    latitude = loc?.coordinates?.latitude;
    longitude = loc?.coordinates?.longitude;
  } catch (err) {
    console.warn(`[PublixLocator] zip=${zip} -> GetRetailerLocationAddress lookup failed:`, err);
    return undefined;
  }

  if (!address || !city || !state || !resultZip) {
    console.log(`[PublixLocator] zip=${zip} -> retailerLocationId=${retailerLocationId} missing a complete address.`);
    return undefined;
  }

  const location: StoreLocation = {
    name: name?.trim() || `Publix - ${city}`,
    storeId: shopId,
    address,
    city,
    state,
    zip: resultZip,
    latitude,
    longitude,
    source: 'publix-instacart',
    metadata: { shopId, retailerLocationId },
  };

  locationCache.set(key, location);
  console.log(
    `[PublixLocator] zip=${zip} -> SELECTED shopId=${shopId} "${location.name}" ` +
      `${location.address}, ${location.city}, ${location.state} ${location.zip}`,
  );
  return location;
}

// No session/token beyond the shared anonymous cookie (see
// publixLiveScraper.ts) — "ready" here just means we've confirmed a
// lookup succeeds, same as aldiLocator.ts.
export async function warmPublixLocator(zip: string | undefined, getSessionCookie: () => Promise<string>): Promise<void> {
  if (zip) await findNearestStoreUncached(zip, undefined, getSessionCookie);
  markStoreReady('publix');
}
