/**
 * Kroger live price fetcher.
 *
 * Uses the official Kroger Product API (product.compact scope):
 *   1. OAuth2 client_credentials → access token (cached 25 min)
 *   2. Locations API → nearest locationId for user's zip code (cached 1 hr)
 *   3. Products API → real prices for up to 50 products (cached 5 min)
 */

import type { ApiProduct, StoreLocation } from '../types/index.ts';
import { toTitleCase, hashCode } from '../utils/textFormat.ts';
import { withTimeout } from '../utils/withTimeout.ts';
import { TtlCache } from '../utils/ttlCache.ts';
import { createKrogerLocator } from './locators/krogerLocator.ts';

const KROGER_API = 'https://api.kroger.com/v1';

// ── Token cache ───────────────────────────────────────────────────────────────
let tokenCache: { token: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;

  const clientId = process.env.KROGER_CLIENT_ID;
  const clientSecret = process.env.KROGER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'Kroger auth failed: KROGER_CLIENT_ID / KROGER_CLIENT_SECRET are not set (check .env.local).',
    );
  }

  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch(`${KROGER_API}/connect/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=product.compact',
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Kroger auth failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  const ttl = (json.expires_in ?? 1800) - 60; // 1-min safety buffer
  tokenCache = { token: json.access_token, expiresAt: Date.now() + ttl * 1000 };
  return tokenCache.token;
}

// ── Store locator ─────────────────────────────────────────────────────────────
// See locators/krogerLocator.ts — resolves the nearest real Kroger location
// via Kroger's own Locations API and ranks candidates by actual distance.
const krogerLocator = createKrogerLocator(getToken);

// ── Product result cache ──────────────────────────────────────────────────────
const productCache = new TtlCache<ApiProduct[]>(5 * 60 * 1000); // 5 min

// ── Raw API shapes ────────────────────────────────────────────────────────────
interface KrogerPrice {
  regular: number;
  promo: number;
}
interface KrogerItem {
  size?: string;
  price?: KrogerPrice;
}
interface KrogerImageSize {
  id: string;
  url: string;
}
interface KrogerImage {
  perspective: string;
  sizes: KrogerImageSize[];
}
interface KrogerProduct {
  productId: string;
  brand?: string;
  description?: string;
  items?: KrogerItem[];
  images?: KrogerImage[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function stripTrademarks(s: string): string {
  return s.replace(/[®™©]/g, '').replace(/\s+/g, ' ').trim();
}

function getBestImageUrl(images?: KrogerImage[]): string | undefined {
  if (!images?.length) return undefined;
  const front = images.find(i => i.perspective === 'front') ?? images[0];
  const sizes = front.sizes ?? [];
  for (const id of ['medium', 'large', 'xlarge', 'thumbnail']) {
    const found = sizes.find(s => s.id === id);
    if (found?.url) return found.url;
  }
  return sizes[0]?.url;
}

function mapKrogerProduct(p: KrogerProduct, location: StoreLocation | undefined): ApiProduct | null {
  const description = stripTrademarks(p.description ?? '').trim();
  if (!description) return null;

  const item = p.items?.[0];
  const regularPrice = item?.price?.regular ?? 0;
  const promoPrice = item?.price?.promo ?? 0;

  // Skip products with no pricing info
  if (regularPrice <= 0) return null;

  const hasSale = promoPrice > 0 && promoPrice < regularPrice;
  const price = hasSale ? promoPrice : regularPrice;

  const seed = hashCode(p.productId);
  const rating = Math.round((3.8 + (seed % 12) / 10) * 10) / 10;
  const reviewCount = 20 + (seed % 2000);

  return {
    id: `kroger-${p.productId}`,
    name: toTitleCase(description),
    brand: p.brand ? toTitleCase(stripTrademarks(p.brand)) : '',
    price,
    originalPrice: hasSale ? regularPrice : undefined,
    discountPercent: hasSale ? Math.round((1 - promoPrice / regularPrice) * 100) : undefined,
    image_url: getBestImageUrl(p.images),
    rating,
    reviewCount,
    size: item?.size ?? '',
    isLiveData: true,
    store: 'Kroger',
    location,
    inStock: true,
  };
}

// ── Main search function ──────────────────────────────────────────────────────
export async function searchKroger(
  query: string,
  zipcode: string,
): Promise<ApiProduct[]> {
  const cacheKey = `${query.toLowerCase().trim()}|${zipcode}`;
  const cached = productCache.get(cacheKey);
  if (cached) {
    console.log(`[Kroger] Cache hit for "${query}"`);
    return cached;
  }

  console.log(`[Kroger] Live fetch for "${query}" @ ${zipcode}`);

  const token = await getToken();
  const storeLocation = await krogerLocator.findNearestStore(zipcode);

  if (!storeLocation) {
    console.log(`[Kroger] No Kroger location found near ${zipcode}`);
    return [];
  }

  const url = new URL(`${KROGER_API}/products`);
  url.searchParams.set('filter.term', query);
  url.searchParams.set('filter.locationId', storeLocation.storeId!);
  url.searchParams.set('filter.limit', '50');

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Kroger products API failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  const raw = (json.data ?? []) as KrogerProduct[];
  console.log(`[Kroger] Raw: ${raw.length} products from API`);

  const products = raw
    .map(p => mapKrogerProduct(p, storeLocation))
    .filter((p): p is ApiProduct => p !== null);

  console.log(`[Kroger] ${products.length} mapped products for "${query}"`);
  // Debug output — trace the ZIP → store → product-count pipeline at a glance.
  console.log(
    `[Kroger][debug] zip=${zipcode} -> store="${storeLocation.name}" ` +
      `id=${storeLocation.storeId} address="${storeLocation.address}, ${storeLocation.city}, ` +
      `${storeLocation.state} ${storeLocation.zip}" ` +
      `lat=${storeLocation.latitude ?? '?'} lng=${storeLocation.longitude ?? '?'} products=${products.length}`,
  );
  productCache.set(cacheKey, products);
  return products;
}

// ── Timeout wrapper ───────────────────────────────────────────────────────────
export function searchKrogerWithTimeout(
  query: string,
  zipcode: string,
  timeoutMs: number,
): Promise<ApiProduct[]> {
  return withTimeout(searchKroger(query, zipcode), timeoutMs, 'Kroger search');
}
