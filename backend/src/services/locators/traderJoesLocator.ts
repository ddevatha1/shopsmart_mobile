import type { StoreLocation } from '../../types/index.ts';
import { TtlCache } from '../../utils/ttlCache.ts';
import { withTimeout } from '../../utils/withTimeout.ts';
import { geocodeAddress, geocodeZip, haversineDistanceMiles } from '../../utils/geocode.ts';
import { stateNameToCode } from './usStates.ts';
import type { StoreLocator } from './types.ts';

/**
 * Trader Joe's has no store-aware product-search API and no dynamic
 * "nearest store" search endpoint anywhere (confirmed via live GraphQL
 * schema introspection: `pickupLocations` — the one field shaped like a
 * real store search — returns `total_count: 0` for every query tried,
 * across six major cities/zips/states at up to 500-mile radius; it's an
 * unpopulated Magento platform feature, not a live TJ's feature).
 *
 * What Trader Joe's *does* publish is a complete, real store directory:
 * every store's URL, indexed by state/city/store-code, via their public
 * locator's sitemap (locations.traderjoes.com/sitemap.xml — a genuine,
 * first-party, complete list of ~660 real stores), with each store's own
 * page carrying real schema.org address + coordinates. This locator uses
 * that directory rather than any distance guess:
 *   1. Geocode the shopper's ZIP (OpenStreetMap, with address details) to
 *      find which US state it's in.
 *   2. Narrow the real directory to that state's real stores.
 *   3. Prefer an exact city-name match (free, no further lookups) — most
 *      shoppers search from a city TJ's directly lists a store in, or one
 *      that shares a name with a nearby store.
 *   4. Only if no exact match exists does it fall back to geocoding
 *      candidate city names to rank by real distance — bounded to a
 *      reasonable number of candidates so one shopper's request can't
 *      trigger geocoding an entire (very large) state; see
 *      MAX_FALLBACK_CANDIDATES below.
 *   5. Fetch the selected store's own real address/coordinates from its
 *      page — never fabricated, always from Trader Joe's own listing.
 *
 * OpenStreetMap is used only for step 1 (geocoding the ZIP) and step 4
 * (geocoding candidate city names to compute distance) — never to
 * discover or substitute a store; every candidate considered, and the one
 * finally selected, comes from Trader Joe's own directory.
 */
const SITEMAP_URL = 'https://locations.traderjoes.com/sitemap.xml';
const STORE_URL_PATTERN = /https:\/\/locations\.traderjoes\.com\/([a-z-]+)\/([a-z-]+)\/(\d+)\//g;

// Keeps a single shopper's request from triggering geocoding for an entire
// large state (California alone lists 150+ distinct cities) — the common
// case (an exact city match) never hits this path at all.
const MAX_FALLBACK_CANDIDATES = 25;

interface DirectoryEntry {
  state: string; // lowercase 2-letter code, e.g. "tx"
  city: string; // lowercase hyphenated slug, e.g. "san-antonio"
  storeCode: string;
}

// The full store directory changes rarely (new stores open occasionally) —
// cached for a day so every search doesn't refetch/reparse the sitemap.
const directoryCache = new TtlCache<DirectoryEntry[]>(24 * 60 * 60 * 1000);
const nearestStoreCache = new TtlCache<StoreLocation>(60 * 60 * 1000); // 1 hour

async function loadDirectory(): Promise<DirectoryEntry[]> {
  const cached = directoryCache.get('all');
  if (cached) return cached;

  const res = await withTimeout(fetch(SITEMAP_URL), 10000, "Trader Joe's sitemap");
  const xml = await res.text();
  const entries: DirectoryEntry[] = [];
  for (const match of xml.matchAll(STORE_URL_PATTERN)) {
    entries.push({ state: match[1], city: match[2], storeCode: match[3] });
  }
  directoryCache.set('all', entries);
  console.log(`[TraderJoesLocator] Loaded store directory: ${entries.length} stores.`);
  return entries;
}

interface SchemaOrgGroceryStore {
  '@type'?: string;
  address?: {
    streetAddress?: string;
    addressLocality?: string;
    addressRegion?: string;
    postalCode?: string;
  };
  geo?: { latitude?: number; longitude?: number };
}

const storeDetailCache = new TtlCache<StoreLocation | null>(30 * 24 * 60 * 60 * 1000);

async function fetchStoreDetail(entry: DirectoryEntry): Promise<StoreLocation | undefined> {
  const cached = storeDetailCache.get(entry.storeCode);
  if (cached !== undefined) return cached ?? undefined;

  let location: StoreLocation | null = null;
  try {
    const pageUrl = `https://locations.traderjoes.com/${entry.state}/${entry.city}/${entry.storeCode}/`;
    const res = await withTimeout(fetch(pageUrl), 8000, "Trader Joe's store page");
    const html = await res.text();
    for (const match of html.matchAll(/<script type="application\/ld\+json">([^<]+)<\/script>/g)) {
      try {
        const data = JSON.parse(match[1]) as SchemaOrgGroceryStore;
        if (data['@type'] !== 'GroceryStore') continue;
        const { streetAddress, addressLocality, addressRegion, postalCode } = data.address ?? {};
        if (streetAddress && addressLocality && addressRegion && postalCode) {
          location = {
            name: `Trader Joe's - ${addressLocality}`,
            storeId: entry.storeCode,
            address: streetAddress,
            city: addressLocality,
            state: addressRegion,
            zip: postalCode,
            latitude: data.geo?.latitude,
            longitude: data.geo?.longitude,
          };
        }
        break;
      } catch { /* not the JSON block we want */ }
    }
  } catch (err) {
    console.warn(`[TraderJoesLocator] store detail lookup failed for ${entry.storeCode}:`, err);
  }

  storeDetailCache.set(entry.storeCode, location);
  return location ?? undefined;
}

function citySlugToName(slug: string): string {
  return slug.replace(/-/g, ' ');
}

export function createTraderJoesLocator(): StoreLocator {
  return {
    async findNearestStore(zip: string): Promise<StoreLocation | undefined> {
      const cached = nearestStoreCache.get(zip);
      if (cached) return cached;

      const userGeo = await geocodeZip(zip);
      if (!userGeo?.state) {
        console.log(`[TraderJoesLocator] Could not determine the state for zip ${zip}.`);
        return undefined;
      }
      const stateCode = stateNameToCode(userGeo.state);
      if (!stateCode) {
        console.log(`[TraderJoesLocator] Unrecognized state name "${userGeo.state}" for zip ${zip}.`);
        return undefined;
      }

      const directory = await loadDirectory();
      const inState = directory.filter(e => e.state === stateCode);
      if (inState.length === 0) {
        console.log(`[TraderJoesLocator] Trader Joe's has no stores listed in state "${stateCode}" (zip ${zip}).`);
        return undefined;
      }

      // Tier 1: exact city-name match — free, and covers the common case.
      const userCity = (userGeo.city ?? '').trim().toLowerCase();
      const candidates = inState.filter(e => citySlugToName(e.city) === userCity);

      let selectedEntry: DirectoryEntry | undefined;
      if (candidates.length === 1) {
        selectedEntry = candidates[0];
      } else if (candidates.length > 1) {
        // Same city, multiple stores — geocode just these few real
        // addresses (cheap) and pick the nearest.
        selectedEntry = await pickNearestByAddress(userGeo, candidates);
      } else {
        // Tier 2: no exact city match — rank a bounded set of this state's
        // candidate cities by geocoded distance.
        const distinctCities = [...new Map(inState.map(e => [e.city, e])).values()].slice(
          0,
          MAX_FALLBACK_CANDIDATES,
        );
        if (inState.length > MAX_FALLBACK_CANDIDATES) {
          console.log(
            `[TraderJoesLocator] ${stateCode} has ${inState.length} stores across more cities than the ` +
              `${MAX_FALLBACK_CANDIDATES}-candidate cap — ranking only the first ${MAX_FALLBACK_CANDIDATES} ` +
              `for zip ${zip}. May not select the absolute nearest store in very large states.`,
          );
        }
        selectedEntry = await pickNearestByCity(userGeo, distinctCities, inState);
      }

      if (!selectedEntry) {
        console.log(`[TraderJoesLocator] Could not resolve a nearest store for zip ${zip}.`);
        return undefined;
      }

      const location = await fetchStoreDetail(selectedEntry);
      if (!location) return undefined;

      nearestStoreCache.set(zip, location);
      console.log(
        `[TraderJoesLocator] Selected storeCode=${selectedEntry.storeCode} "${location.name}" for zip ${zip}`,
      );
      return location;
    },
  };
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
  // Sequential with the shared geocode cache — most of these are one-time
  // per state (cached 30 days per city afterward), so this cost is paid
  // once per state, not once per search.
  for (const entry of distinctCities) {
    const coords = await geocodeAddress(`${citySlugToName(entry.city)}, ${entry.state.toUpperCase()}, USA`);
    if (!coords) continue;
    const distance = haversineDistanceMiles(userGeo, coords);
    if (!best || distance < best.distance) best = { city: entry.city, distance };
  }
  if (!best) return undefined;
  return allInState.find(e => e.city === best!.city);
}
