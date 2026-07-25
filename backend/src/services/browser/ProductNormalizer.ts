/**
 * Turns a raw ProductCandidate — arbitrary source field names, already
 * confirmed product-shaped by ProductExtractor — into this framework's
 * canonical BrowserProduct shape. The same job `mapKrogerProduct`/
 * `normalizeAldiProduct` already do for one hardcoded store each,
 * generalized here to work from whatever field names ProductExtractor
 * actually matched rather than a store-specific schema.
 *
 * `rating`/`reviewCount` are synthesized from a deterministic hash, the
 * same convention every direct-API adapter in this app already uses
 * (see krogerLiveScraper.ts/aldiLiveScraper.ts) — real per-product ratings
 * aren't something a generic network-capture pass can discover any more
 * reliably than the direct adapters can, so this stays consistent with the
 * rest of the app rather than inventing a second convention.
 */
import { toTitleCase, hashCode } from '../../utils/textFormat.ts';
import type { StoreLocation } from '../../types/index.ts';
import type { BrowserProduct, CanonicalField, ProductCandidate } from './types.ts';

function fieldValue(candidate: ProductCandidate, field: CanonicalField): unknown {
  return candidate.matches.find(m => m.field === field)?.value;
}

function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'in stock', 'available', 'yes'].includes(normalized)) return true;
    if (['false', 'out of stock', 'unavailable', 'no'].includes(normalized)) return false;
  }
  return undefined;
}

export function normalizeCandidate(
  candidate: ProductCandidate,
  storeName: string,
  location?: StoreLocation,
): BrowserProduct | null {
  const name = fieldValue(candidate, 'name');
  const price = fieldValue(candidate, 'price');
  if (typeof name !== 'string' || typeof price !== 'number') return null;

  const idRaw = fieldValue(candidate, 'id');
  const upcRaw = fieldValue(candidate, 'upc');
  // Falls back to a stable hash of name+source when the site's response
  // has no id-like field at all — still deterministic across repeat
  // searches for the same product, just not the retailer's own id.
  const id = idRaw !== undefined ? String(idRaw) : `hash-${hashCode(name + candidate.sourceUrl)}`;
  const seed = hashCode(id);

  const imageRaw = fieldValue(candidate, 'image');
  const brandRaw = fieldValue(candidate, 'brand');
  const categoryRaw = fieldValue(candidate, 'category');
  const departmentRaw = fieldValue(candidate, 'department');
  const aisleRaw = fieldValue(candidate, 'aisle');
  const promotionsRaw = fieldValue(candidate, 'promotions');
  const availabilityRaw = fieldValue(candidate, 'availability');

  const storeSlug = storeName.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  return {
    id: `browser-${storeSlug}-${id}`,
    store: storeName,
    name: toTitleCase(name),
    brand: typeof brandRaw === 'string' ? toTitleCase(brandRaw) : '',
    price,
    image_url: typeof imageRaw === 'string' && imageRaw.startsWith('http') ? imageRaw : undefined,
    rating: Math.round((3.8 + (seed % 12) / 10) * 10) / 10,
    reviewCount: 20 + (seed % 1500),
    isLiveData: true,
    size: '',
    upc: typeof upcRaw === 'string' ? upcRaw : typeof upcRaw === 'number' ? String(upcRaw) : undefined,
    category: typeof categoryRaw === 'string' ? categoryRaw : undefined,
    department: typeof departmentRaw === 'string' ? departmentRaw : undefined,
    aisle: typeof aisleRaw === 'string' ? aisleRaw : undefined,
    inStock: coerceBoolean(availabilityRaw),
    promotions: Array.isArray(promotionsRaw) ? (promotionsRaw as string[]) : undefined,
    location,
    sourceUrl: candidate.sourceUrl,
  };
}
