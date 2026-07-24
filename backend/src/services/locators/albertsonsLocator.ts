import type { StoreLocation } from '../../types/index.ts';
import { TtlCache } from '../../utils/ttlCache.ts';
import { dedupeInFlight } from '../../utils/dedupeInFlight.ts';
import { withTimeout } from '../../utils/withTimeout.ts';
import { geocodeAddress, geocodeZip, haversineDistanceMiles } from '../../utils/geocode.ts';
import { stateNameToCode } from './usStates.ts';
import type { PreciseCoords, StoreLocator } from './types.ts';

/**
 * Albertsons has no public product-search API — its real shopping/product
 * catalog (the "Nimbus" API) sits behind full account-based Okta login, not
 * an app-level client_credentials grant like Kroger's official API, and not
 * an anonymous session cookie like Aldi/Sprouts/Trader Joe's. Building
 * against that would mean either scraping a real personal account's
 * authenticated session (fragile, ToS-fragile, and exactly the kind of
 * brittle hack this app avoids everywhere else) or simply not having a
 * legitimate source — so `albertsonsLiveScraper.ts`'s product search
 * intentionally always returns empty with a clear "unavailable" status
 * rather than faking data. See that file for the product side.
 *
 * STORE LOCATIONS are a different story: local.albertsons.com is a real,
 * public, unauthenticated Yext-powered store locator site (confirmed live:
 * a real `sitemap.xml`, robots.txt disallows only the interactive `/locator`
 * path, and each store's own page embeds its real address/coordinates/
 * store ID as a `Yext.Profile` JSON object in the page source — no browser
 * JS execution or login needed to read it). This locator uses that,
 * following the exact same shape as traderJoesLocator.ts: crawl the real
 * sitemap for the real store directory, narrow to the shopper's state, then
 * pick the nearest real store — never a fabricated or guessed address.
 */
const SITEMAP_URL = 'https://local.albertsons.com/sitemap.xml';
// Matches only store DETAIL pages (state/city/street-slug) — the sitemap
// also lists state index pages (/tx.html), city index pages
// (/tx/carrollton.html), and per-store department subpages
// (/tx/carrollton/2150-n-josey-ln/bakery.html), none of which are a store.
const STORE_URL_PATTERN = /https:\/\/local\.albertsons\.com\/([a-z]{2})\/([a-z0-9-]+)\/([a-z0-9-]+)\.html/g;

const MAX_FALLBACK_CANDIDATES = 25;

interface DirectoryEntry {
  state: string; // lowercase 2-letter code, e.g. "tx"
  city: string; // lowercase hyphenated slug, e.g. "carrollton"
  slug: string; // e.g. "2150-n-josey-ln"
}

const directoryCache = new TtlCache<DirectoryEntry[]>(24 * 60 * 60 * 1000);
const nearestStoreCache = new TtlCache<StoreLocation>(60 * 60 * 1000);

async function loadDirectory(): Promise<DirectoryEntry[]> {
  const cached = directoryCache.get('all');
  if (cached) return cached;

  const res = await withTimeout(fetch(SITEMAP_URL), 10000, 'Albertsons sitemap');
  const xml = await res.text();
  const seen = new Set<string>();
  const entries: DirectoryEntry[] = [];
  for (const match of xml.matchAll(STORE_URL_PATTERN)) {
    const [, state, city, slug] = match;
    const key = `${state}/${city}/${slug}`;
    if (seen.has(key)) continue; // sitemap lists each URL twice (hreflang alternates)
    seen.add(key);
    entries.push({ state, city, slug });
  }
  directoryCache.set('all', entries);
  console.log(`[AlbertsonsLocator] Loaded store directory: ${entries.length} stores.`);
  return entries;
}

/** Scans forward from `marker` for the first `{`, then returns the
 * substring up to its balanced matching `}` (tracking string/escape state
 * so braces inside string values don't confuse the count) — used to pull
 * the `Yext.Profile = {...}` object out of a store page's raw HTML without
 * needing a JS parser, since it's plain embedded JSON, not HTML-encoded. */
export function extractBalancedJson(html: string, marker: string): string | undefined {
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) return undefined;
  const start = html.indexOf('{', markerIdx);
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return undefined;
}

interface AlbertsonsProfile {
  address?: { line1?: string; city?: string; region?: string; postalCode?: string };
  geocodedCoordinate?: { lat?: number; long?: number };
  meta?: { id?: string };
  c_geomodifier?: string;
}

export function parseAlbertsonsProfile(html: string): StoreLocation | undefined {
  const json = extractBalancedJson(html, 'Yext.Profile');
  if (!json) return undefined;

  let profile: AlbertsonsProfile;
  try {
    profile = JSON.parse(json);
  } catch (err) {
    console.warn('[AlbertsonsLocator] Failed to parse Yext.Profile JSON:', err);
    return undefined;
  }

  const address = profile.address?.line1;
  const city = profile.address?.city;
  const state = profile.address?.region;
  const zip = profile.address?.postalCode;
  if (!address || !city || !state || !zip) return undefined;

  return {
    name: profile.c_geomodifier ? `Albertsons - ${profile.c_geomodifier}` : `Albertsons - ${city}`,
    storeId: profile.meta?.id,
    address,
    city,
    state,
    zip,
    latitude: profile.geocodedCoordinate?.lat,
    longitude: profile.geocodedCoordinate?.long,
    source: 'albertsons-sitemap',
    metadata: { entityId: profile.meta?.id },
  };
}

const storeDetailCache = new TtlCache<StoreLocation | null>(24 * 60 * 60 * 1000);

async function fetchStoreDetail(entry: DirectoryEntry): Promise<StoreLocation | undefined> {
  const cacheKeyStr = `${entry.state}/${entry.city}/${entry.slug}`;
  const cached = storeDetailCache.get(cacheKeyStr);
  if (cached !== undefined) return cached ?? undefined;

  let location: StoreLocation | null = null;
  try {
    const pageUrl = `https://local.albertsons.com/${entry.state}/${entry.city}/${entry.slug}.html`;
    const res = await withTimeout(fetch(pageUrl), 10000, 'Albertsons store page');
    const html = await res.text();
    location = parseAlbertsonsProfile(html) ?? null;
  } catch (err) {
    console.warn(`[AlbertsonsLocator] store detail lookup failed for ${cacheKeyStr}:`, err);
  }

  storeDetailCache.set(cacheKeyStr, location);
  return location ?? undefined;
}

function citySlugToName(slug: string): string {
  return slug.replace(/-/g, ' ');
}

export async function warmAlbertsonsDirectory(): Promise<void> {
  await loadDirectory();
}

export function createAlbertsonsLocator(): StoreLocator {
  return {
    async findNearestStore(zip: string, preciseCoords?: PreciseCoords): Promise<StoreLocation | undefined> {
      const key = preciseCoords ? `${zip}:${preciseCoords.latitude.toFixed(2)},${preciseCoords.longitude.toFixed(2)}` : zip;
      return dedupeInFlight(`albertsons-locate:${key}`, () => findNearestStoreUncached(zip, preciseCoords));
    },
  };
}

async function findNearestStoreUncached(zip: string, preciseCoords?: PreciseCoords): Promise<StoreLocation | undefined> {
  const cacheKey = preciseCoords ? `${zip}:${preciseCoords.latitude.toFixed(2)},${preciseCoords.longitude.toFixed(2)}` : zip;
  const cached = nearestStoreCache.get(cacheKey);
  if (cached) return cached;

  const zipGeo = await geocodeZip(zip);
  const zipState = zipGeo?.state;
  if (!zipState) {
    console.log(`[AlbertsonsLocator] Could not determine the state for zip ${zip}.`);
    return undefined;
  }
  const userGeo = preciseCoords ? { ...preciseCoords, state: zipState, city: zipGeo.city } : { ...zipGeo, state: zipState };
  const stateCode = stateNameToCode(userGeo.state);
  if (!stateCode) {
    console.log(`[AlbertsonsLocator] Unrecognized state name "${userGeo.state}" for zip ${zip}.`);
    return undefined;
  }

  const directory = await loadDirectory();
  const inState = directory.filter(e => e.state === stateCode.toLowerCase());
  if (inState.length === 0) {
    console.log(`[AlbertsonsLocator] Albertsons has no stores listed in state "${stateCode}" (zip ${zip}).`);
    return undefined;
  }

  const userCity = (userGeo.city ?? '').trim().toLowerCase();
  const candidates = inState.filter(e => citySlugToName(e.city) === userCity);

  let selectedEntry: DirectoryEntry | undefined;
  if (candidates.length === 1) {
    selectedEntry = candidates[0];
  } else if (candidates.length > 1) {
    selectedEntry = await pickNearestByAddress(userGeo, candidates);
  } else {
    const distinctCities = [...new Map(inState.map(e => [e.city, e])).values()].slice(0, MAX_FALLBACK_CANDIDATES);
    if (inState.length > MAX_FALLBACK_CANDIDATES) {
      console.log(
        `[AlbertsonsLocator] ${stateCode} has ${inState.length} stores across more cities than the ` +
          `${MAX_FALLBACK_CANDIDATES}-candidate cap — ranking only the first ${MAX_FALLBACK_CANDIDATES} for zip ${zip}.`,
      );
    }
    selectedEntry = await pickNearestByCity(userGeo, distinctCities, inState);
  }

  if (!selectedEntry) {
    console.log(`[AlbertsonsLocator] Could not resolve a nearest store for zip ${zip}.`);
    return undefined;
  }

  const location = await fetchStoreDetail(selectedEntry);
  if (!location) return undefined;

  nearestStoreCache.set(cacheKey, location);
  console.log(`[AlbertsonsLocator] Selected "${location.name}" for zip ${zip}`);
  return location;
}

async function pickNearestByAddress(
  userGeo: { latitude: number; longitude: number },
  candidates: DirectoryEntry[],
): Promise<DirectoryEntry | undefined> {
  const details = await Promise.all(candidates.map(fetchStoreDetail));
  let best: { entry: DirectoryEntry; distance: number } | undefined;
  for (let i = 0; i < candidates.length; i++) {
    const loc = details[i];
    if (!loc?.latitude || !loc.longitude) continue;
    const distance = haversineDistanceMiles(userGeo, { latitude: loc.latitude, longitude: loc.longitude });
    if (!best || distance < best.distance) best = { entry: candidates[i], distance };
  }
  return best?.entry ?? candidates[0];
}

async function pickNearestByCity(
  userGeo: { latitude: number; longitude: number },
  distinctCities: DirectoryEntry[],
  allInState: DirectoryEntry[],
): Promise<DirectoryEntry | undefined> {
  let best: { city: string; distance: number } | undefined;
  for (const entry of distinctCities) {
    const coords = await geocodeAddress(`${citySlugToName(entry.city)}, ${entry.state.toUpperCase()}, USA`);
    if (!coords) continue;
    const distance = haversineDistanceMiles(userGeo, coords);
    if (!best || distance < best.distance) best = { city: entry.city, distance };
  }
  if (!best) return undefined;
  return allInState.find(e => e.city === best!.city);
}
