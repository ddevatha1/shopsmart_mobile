/**
 * The candidate-tracking list `StoreDiscoveryRunner.runDiscoveryBatch`
 * reads from and updates. `region`/`estimatedProductAvailability` are
 * research-level judgment calls (not verified), kept separate from the
 * `compatibilityStatus`/`failureReason` fields, which only ever reflect an
 * actual live check — either a lightweight reconnaissance pass (see the
 * matching storeConfigs/*.ts file's own header for what was checked) or a
 * full discovery run.
 */
import type { DiscoveryCandidate } from './StoreDiscoveryRunner.ts';

export const DISCOVERY_CANDIDATES: DiscoveryCandidate[] = [
  {
    storeName: 'Food Bazaar',
    homepage: 'https://www.foodbazaar.com/',
    region: 'NYC metro (NY/NJ)',
    estimatedProductAvailability: 'medium',
    compatibilityStatus: 'compatible',
  },
  {
    storeName: 'Piggly Wiggly',
    homepage: 'https://www.pigglywiggly.com/',
    region: 'Southeast/Midwest — franchised, fragmented independent ownership',
    estimatedProductAvailability: 'unknown',
    compatibilityStatus: 'incompatible',
    failureReason: 'Site loaded, but no search input was found and no URL/network change was observed after attempting a search — likely a corporate/directory site, not a real storefront with product search.',
  },
  {
    storeName: 'H Mart',
    homepage: 'https://www.hmart.com/',
    region: 'Nationwide (Korean-American grocery)',
    estimatedProductAvailability: 'high',
    compatibilityStatus: 'incompatible',
    failureReason: 'Search ran (URL changed to a real search-results page), but no captured network response contained anything product-shaped — results are most likely rendered server-side rather than via a JSON API this framework can intercept.',
  },
  {
    storeName: 'Sprouts (validation control)',
    homepage: 'https://www.sprouts.com/',
    region: 'Nationwide — already a production direct-API adapter',
    estimatedProductAvailability: 'high',
    compatibilityStatus: 'compatible',
  },
  {
    storeName: "Trader Joe's (validation control)",
    homepage: 'https://www.traderjoes.com/home/products',
    region: 'Nationwide — already a production direct-API adapter',
    estimatedProductAvailability: 'high',
    compatibilityStatus: 'blocked',
    failureReason: 'Homepage responded with HTTP 403 (Akamai) during this run — the second time this session, corroborating rather than a one-off fluke. The existing production adapter still works via its own tuned session-bootstrap approach; this is a framework-reliability data point, not a finding that Trader Joe\'s stopped working.',
  },
  {
    storeName: 'Aldi (validation control)',
    homepage: 'https://www.aldi.us/',
    region: 'Nationwide — already a production direct-API adapter',
    estimatedProductAvailability: 'high',
    compatibilityStatus: 'compatible',
  },
  {
    storeName: 'Lidl',
    homepage: 'https://www.lidl.com/',
    region: 'East Coast US',
    estimatedProductAvailability: 'medium',
    compatibilityStatus: 'incompatible',
    failureReason: 'Search ran (real search-results URL), but no product-shaped network response was captured — likely server-rendered search results.',
  },
  {
    storeName: 'Save Mart',
    homepage: 'https://www.savemart.com/',
    region: 'California/Nevada',
    estimatedProductAvailability: 'medium',
    compatibilityStatus: 'incompatible',
    failureReason: 'Search ran (real search-results URL), but no product-shaped network response was captured — likely server-rendered search results.',
  },
  {
    storeName: 'Grocery Outlet',
    homepage: 'https://www.groceryoutlet.com/',
    region: 'West Coast (CA/OR/WA/PA/NV/ID/MD) — independently-operated stores, discount/closeout model',
    estimatedProductAvailability: 'low',
    compatibilityStatus: 'incompatible',
    failureReason: 'Site loaded, but no search input was found and no URL/network change was observed after attempting a search.',
  },
  {
    storeName: "Raley's",
    homepage: 'https://www.raleys.com/',
    region: 'Northern California/Nevada',
    estimatedProductAvailability: 'medium',
    compatibilityStatus: 'incompatible',
    failureReason: 'Search ran (real search-results URL), but no product-shaped network response was captured — likely server-rendered search results.',
  },
  {
    storeName: 'Stater Bros',
    homepage: 'https://www.staterbros.com/',
    region: 'Southern California',
    estimatedProductAvailability: 'medium',
    compatibilityStatus: 'blocked',
    failureReason: 'Live reconnaissance: HTTP 403 with a Cloudflare "Just a moment..." managed-challenge interstitial. Not run through the full discovery pipeline.',
  },
  {
    storeName: "Bashas'",
    homepage: 'https://www.bashas.com/',
    region: 'Arizona',
    estimatedProductAvailability: 'medium',
    compatibilityStatus: 'incompatible',
    failureReason: 'Search ran (real search-results URL), but no product-shaped network response was captured — likely server-rendered search results.',
  },
  {
    storeName: 'Central Market',
    homepage: 'https://www.centralmarket.com/',
    region: 'Texas (H-E-B banner)',
    estimatedProductAvailability: 'medium',
    compatibilityStatus: 'blocked',
    failureReason: 'Live reconnaissance: near-empty response carrying an Imperva Incapsula challenge marker, consistent with H-E-B (its parent banner), which this app already found Incapsula-protected. Not run through the full discovery pipeline.',
  },
  {
    storeName: 'Fresh Thyme',
    homepage: 'https://www.freshthyme.com/',
    region: 'Midwest',
    estimatedProductAvailability: 'medium',
    compatibilityStatus: 'incompatible',
    failureReason: 'Site loaded, but no search input was found and no URL/network change was observed after attempting a search.',
  },
  {
    storeName: 'Natural Grocers',
    homepage: 'https://www.naturalgrocers.com/',
    region: 'Mountain West/Midwest',
    estimatedProductAvailability: 'medium',
    compatibilityStatus: 'incompatible',
    failureReason: 'Search ran (real search-results URL), but no product-shaped network response was captured — likely server-rendered search results.',
  },
  {
    storeName: 'Walmart',
    homepage: 'https://www.walmart.com/',
    region: 'Nationwide',
    estimatedProductAvailability: 'high',
    compatibilityStatus: 'incompatible',
    failureReason: 'Homepage loaded cleanly and search produced a real results URL, but zero product-shaped network responses were captured. Confirmed live PerimeterX bot-management is present in the page source — given that, this reads as PerimeterX suppressing/withholding real API data from a detected automated session (a "soft block" — a normal-looking page with no real backing data) rather than the site simply lacking a JSON API. Not classified "blocked" by the tool\'s own strict definition (no explicit 4xx/challenge-page/login signal fired), but should not be read as "just needs a config tweak" either.',
  },
  {
    storeName: 'H-E-B',
    homepage: 'https://www.heb.com/',
    region: 'Texas',
    estimatedProductAvailability: 'high',
    compatibilityStatus: 'blocked',
    failureReason: 'Confirmed (three times now: docs/store_api_audit.md, this session\'s reconnaissance, and this discovery run) to serve an Imperva Incapsula challenge — no real search UI ever rendered.',
  },
  {
    storeName: 'Target',
    homepage: 'https://www.target.com/',
    region: 'Nationwide',
    estimatedProductAvailability: 'high',
    compatibilityStatus: 'incompatible',
    failureReason: 'Homepage loaded cleanly and search produced a real results URL, but zero product-shaped network responses were captured — consistent with Target\'s known mature anti-bot posture (docs/store_api_audit.md) suppressing real data from an automated session rather than a missing API. Also separately subject to Target\'s Terms of Service, which explicitly prohibit automated data collection regardless of technical outcome.',
  },
  {
    storeName: 'Whole Foods',
    homepage: 'https://www.wholefoodsmarket.com/',
    region: 'Nationwide (Amazon-owned)',
    estimatedProductAvailability: 'high',
    compatibilityStatus: 'incompatible',
    failureReason: 'Homepage loaded cleanly and search produced a real results URL, but zero product-shaped network responses were captured. Less independently confirmed than Walmart/Target\'s anti-bot posture — could be server-rendered results or filtered/degraded automated-traffic handling; not conclusively distinguished by this run.',
  },
];
