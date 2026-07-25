# ShopSmart Store API Audit

**Purpose:** the engineering reference for every current and prospective grocery-retailer
integration in ShopSmart. The goal is *not* "support as many stores as possible" — it's
identifying which retailers can supply reliable, maintainable, accurate pricing and store
data over the long term, and being explicit about which ones can't, even when data for them
technically exists somewhere online.

This audit reflects the code as of this branch (`feat/retailer-api-expansion`), read directly
from `backend/src/services/*LiveScraper.ts` and `backend/src/services/locators/*.ts`. Where a
claim is about a retailer ShopSmart does *not* yet integrate, it's marked as research/estimate
rather than verified-in-code.

**Update (Phase 2):** Harris Teeter is now implemented (Section 1) after live verification
confirmed it runs on the exact same official Kroger API. Section 2 has also been updated with
live reconnaissance findings (not just research/estimates) for Meijer, H-E-B, Hy-Vee, and the
Ahold Delhaize family (Food Lion/Giant/Stop & Shop) — see the **Verified** / **Research-based**
labels throughout Section 2 for exactly which claims were tested against a live endpoint versus
inferred from general knowledge. A new [Phase 2 Implementation Roadmap](#phase-2-implementation-roadmap)
section at the end ranks every researched retailer by effort, maintainability, and impact.

---

## 1. Audit of Current Integrations

ShopSmart currently wires in six retailers via `backend/src/services/searchService.ts`'s
`performSearch`, which fans out to all six in parallel with `Promise.allSettled` and never lets
one store's failure affect another's.

### Kroger

| | |
|---|---|
| **Data source** | Official public/partner REST API (`developer.kroger.com`) — Locations API + Products API (`product.compact` scope) |
| **Implementation** | `krogerLiveScraper.ts`, `locators/krogerLocator.ts` |

**How data is obtained:** OAuth2 `client_credentials` grant against Kroger's own token
endpoint → nearest store via Kroger's official Locations API (`filter.zipCode.near`, escalating
15/30/50-mile radius, real distance-ranked) → live prices via Kroger's official Products API
filtered by that `locationId`. No browser, no scraping — this is the one integration that's a
genuine documented, first-party API end to end.

**Available data:**
- Product search — yes
- Pricing — yes, real `regular`/`promo` price from the exact resolved store
- Promotions — partial: promo price and computed discount % are surfaced; no promotion
  metadata (name, dates, terms)
- Product images — yes, multiple sizes, picks best available
- Store locations — yes, official, with real lat/lng
- Inventory/availability — **no**: `inStock` is hardcoded `true`, not read from any API field
- Categories — **no**: no category/aisle field is populated from Kroger's response
- Product metadata — brand, size; no UPC

**Authentication:** API key pair (`KROGER_CLIENT_ID`/`KROGER_CLIENT_SECRET`, app-level, no
shopper login) → OAuth2 client_credentials token, cached ~25 min with a 1-min safety buffer,
auto-refreshed. No user-facing auth at all.

**Reliability: Excellent.**
Official, documented, versioned API with a real credentialed client. The one real gotcha found
during integration — `filter.zipCode.near` vs. the deceptively similar but wrong
`filter.zipCode` (the latter returns HTTP 200 with an unrelated region's stores, no error) — is
already root-caused and permanently guarded with an in-code warning comment. Documented rate
limits exist on Kroger's developer portal (this app does not yet track usage against them — see
Risks). No undocumented-endpoint dependency at all.

**Current implementation status: Mostly complete.**
Search, pricing, images, and store locations are production-grade. Missing: real
inventory/availability, categories/aisle, UPC, and rich promotion metadata. `rating`/
`reviewCount` are **synthetic** (deterministic hash of the product ID, not real Kroger data) —
true for every live store in this app, called out once here and treated as a cross-cutting
issue in Risks/Architecture rather than repeated five times.

**Bonus finding (verified live, not yet acted on):** the raw Products API response carries real
fields this app doesn't map yet — `items[0].inventory.stockLevel` (e.g. `"LOW"`),
`items[0].fulfillment` (`curbside`/`delivery`/`inStore`/`shipToHome` booleans), and
`ratingsAndReviews.averageOverallRating`/`totalReviewCount` — **genuine Kroger review data**,
sitting unused while `mapKrogerProduct` synthesizes a fake rating instead. This is a real,
low-effort fix opportunity for the "synthetic ratings" issue called out above and in Risks/
Architecture, discovered incidentally while verifying Harris Teeter (Section 1 → Harris Teeter,
below) — flagged here rather than fixed, since it's out of scope for this round of changes.

---

### Harris Teeter

| | |
|---|---|
| **Data source** | The exact same official Kroger Product API as the Kroger entry above — Harris Teeter is a Kroger Co. banner, not a separate integration |
| **Implementation** | `krogerLiveScraper.ts` (shared with Kroger), `locators/krogerLocator.ts` (shared with Kroger) |
| **Status** | **Implemented this phase**, after live experimental verification per the brief — not assumed compatible |

**How this was verified (live, not assumed):** Kroger's Locations API was queried directly
(`GET /v1/locations?filter.zipCode.near=28202` — Charlotte, NC, Harris Teeter's home market)
using the exact same OAuth2 client_credentials token already configured for Kroger. Every one of
the 20 nearest results carried `"chain": "HART"` and a real name like `"Harris Teeter - Fifth and
Poplar"` — confirming Harris Teeter locations are returned by the existing Locations API with
zero new credentials or endpoints. A follow-up query against that resolved `locationId` on the
same `/v1/products` endpoint returned real Harris Teeter-branded products — `"Harris Teeter™ 2%
Reduced Fat Milk"` at $1.79, `"Harris Teeter Boneless Skinless Chicken Breasts Small Pack"` at
$4.99 regular / $2.49 promo — with real promo pricing, real sizes, and real images, in the
identical response shape Kroger's own products use.

**Answering the brief's specific investigation questions, all verified live:**
- Harris Teeter stores returned by the Locations API? **Yes.**
- Harris Teeter products searchable via the existing product endpoint? **Yes**, same
  `/v1/products?filter.locationId=...` call, no new endpoint.
- Pricing available? **Yes**, real regular/promo pricing, same response shape as Kroger.
- Promotions available? **Yes**, to the same (partial) extent Kroger's own promo/discount% fields
  already are — no additional gap versus the existing Kroger integration.
- Store-specific inventory supported? **No** — same gap as Kroger itself (Section 1 → Kroger);
  this app doesn't map the `inventory`/`fulfillment` fields for either banner today (see the
  Kroger section's "Bonus finding," above).
- Same OAuth flow/token as Kroger? **Yes, literally the same token** — one `client_credentials`
  grant authorizes Locations/Products calls for both banners; no second credential pair, no
  second `.env` entry.
- Additional configuration required? **One thing only:** which banner's `chain` code to filter
  by. Kroger's Locations API supports a genuine server-side `filter.chain` parameter (verified
  live — `filter.chain=HART` returns only Harris Teeter stores; `filter.chain=KROGER` for the
  same Charlotte ZIP returns a single non-consumer distribution "Shed" record, not a real
  storefront). Everything else — OAuth, the search pipeline, product normalization, pricing
  normalization — is reused unchanged.

**A real bug this also found and fixed, not just a feature added:** before this change, the
Kroger locator resolved "nearest store" from *any* chain in the Locations API response, with no
chain filter at all. For a Charlotte, Raleigh, or Charleston shopper, that meant a "Kroger"
search was silently resolving to the nearest Harris Teeter store and reporting its real
prices/products under the `"Kroger"` label — a live, confirmed mislabeling bug, not a
hypothetical one (there is no real consumer-facing Kroger-banner store in Charlotte at all;
`filter.chain=KROGER` there returns only a distribution facility). Implementing Harris Teeter as
its own correctly-scoped banner fixes this as a direct consequence: **Kroger search results in
Harris Teeter markets now honestly report "no results" instead of silently mislabeling another
banner's data.** Verified live both directions post-fix: Charlotte (28202) now returns 43 real
Harris Teeter products and zero mislabeled "Kroger" products; Nashville (37201, real Kroger
territory) returns real Kroger products and zero Harris Teeter results, as expected.

**Implementation approach — reuse, not a new scraper (per the brief's instruction):**
- **OAuth:** reused verbatim — the same module-level `getToken()`/token cache in
  `krogerLiveScraper.ts` now serves both banners.
- **Search pipeline:** reused — `searchKroger` and the new `searchHarrisTeeter` are both thin
  wrappers around one shared internal `searchKrogerBanner()` function; the HTTP call shape,
  caching, and error handling are identical code, not duplicated code.
- **Product normalization:** reused — `mapKrogerProduct()` is unchanged except for taking a
  `banner` parameter (display name + id-prefix) instead of hardcoding `'Kroger'`.
- **Pricing normalization:** reused verbatim — same regular/promo/discount% logic, no changes.
- **Store-location logic:** reused and *hardened* — `krogerLocator.ts`'s `createKrogerLocator`
  now takes a `chain` argument and scopes every request to it server-side via `filter.chain`,
  with per-chain cache/dedupe keys so the two banners' resolved stores can never leak into each
  other's cache slot.
- **No new file was created.** Everything lives in the existing `krogerLiveScraper.ts` and
  `krogerLocator.ts` — see the PR summary for the exact diff.

**Available data:** identical to Kroger's own table above (search/pricing/promotions/images/
locations all yes; inventory/categories/UPC all no) — same API, same gaps, same strengths.

**Reliability: Excellent** — same official, documented, credentialed API as Kroger; no new risk
surface introduced.

**Current implementation status: Mostly complete**, matching Kroger exactly (same source, same
gaps). Verified live in two real markets (Charlotte NC, Raleigh/Charleston NC/SC) before being
called done.

---

### Aldi

| | |
|---|---|
| **Data source** | Undocumented GraphQL endpoint on Aldi's Instacart-backed white-label ordering platform |
| **Implementation** | `aldiLiveScraper.ts`, `locators/aldiLocator.ts` |

**How data is obtained:** A plain anonymous `GET https://www.aldi.us/` issues a
`__Host-instacart_sid` session cookie — the same bootstrap any visitor's browser goes through,
done here with a single HTTP call, no JS execution, no login. That cookie authorizes a
`SearchResultsPlacements` GraphQL query against `aldi.us/graphql`, using a **persisted-query
hash** captured from a real browser session and empirically minimized (documented in the file's
header: only `x-ic-view-layer: true` turned out to matter; several other headers a captured cURL
included were verified unnecessary). Store location comes from the same platform's
`idp/v1/shops?postal_code=` endpoint, pre-sorted nearest-first by Aldi's own backend.

**Available data:**
- Product search — yes
- Pricing — yes, real per-store price
- Promotions — **no**: only a flat price string is parsed, no sale/original-price field
- Product images — yes
- Store locations — yes, real, via the same platform, geocoded for lat/lng (the shops endpoint
  doesn't return coordinates itself)
- Inventory/availability — yes — `availability.available` is read and surfaced
- Categories — **partial** — `product_category_name` is present and used, but only for Aldi
  (no other store's response includes an equivalent field)
- Product metadata — brand, size; no UPC

**Authentication:** Anonymous session cookie only — no API key, no OAuth, no login. Session is
cached in memory 6h (cookie itself is valid ~30 days server-side) with automatic re-establishment
on 401/placeholder response.

**Reliability: Moderate.**
Functions well today and has a real self-healing pattern (detects the platform's
`noopQueryField` placeholder response — HTTP 200 with no data, which the platform returns
instead of an error when the session is stale — and retries once with a fresh session). But it
depends entirely on:
1. An undocumented, unversioned GraphQL schema with a hardcoded persisted-query hash that Aldi's
   platform vendor (Instacart) could rotate at any time with zero notice.
2. A private third-party platform (not even Aldi's own infrastructure) whose stability is out of
   both ShopSmart's and Aldi's direct control.

No documented rate limits exist for this endpoint, so throttling risk is unknown and unmanaged.

**Current implementation status: Mostly complete.**
Search/pricing/images/locations/availability all work. Categories are Aldi's one edge over the
other four working stores (Kroger, Harris Teeter, Sprouts, Trader Joe's). No promotions, no UPC.
Elevated stability risk relative to Kroger despite currently working well.

---

### Sprouts

| | |
|---|---|
| **Data source** | Same Instacart-backed platform as Aldi (identical GraphQL shape, identical persisted-query hash) for search/pricing; **Playwright headless browser** for a secondary image-fallback path |
| **Implementation** | `sproutsLiveScraper.ts`, `locators/sproutsLocator.ts` |

**How data is obtained:** Core search/pricing is the same anonymous-session GraphQL pattern as
Aldi (`shop.sprouts.com/graphql`, same persisted query hash, same self-healing retry). Store
location resolution additionally cross-references a second real first-party source — Sprouts'
own public corporate site (`sprouts.com/wp-json/spr-wp-rest/v1/store/{number}`) — for
retailer-native lat/lng rather than geocoding, which is a stronger provenance story than Aldi's
locator has. Separately, `fetchSproutsProductImage` launches a real headless Chromium (Playwright)
to visit a specific product's page and read its photo via `alt`-text word-overlap matching, used
only when a search result comes back with no image.

**Notable history (from the file's own comments):** this scraper *used to* drive the entire
search flow through Playwright (visit storefront, dismiss a modal, intercept the GraphQL
response) — and that approach had a real, live-verified correctness bug: Sprouts resolves "which
store is active" from the request's **real server IP**, not the browser's spoofed
`navigator.geolocation`, so every search was silently using whichever store the server happened
to be near, ignoring the shopper's ZIP entirely. This was only caught by deliberately setting
Playwright's geolocation to a different city and observing no change in the selected store. The
current plain-GraphQL-plus-explicit-`shopId` approach fixes this. This is a good illustration of
why undocumented-platform integrations need empirical verification, not just "it returned data
so it must be right."

**Available data:**
- Product search — yes
- Pricing — yes
- Promotions — **no**
- Product images — yes, with a same-site Playwright fallback for the cases search doesn't return
  one
- Store locations — yes, with genuinely precise (non-geocoded) coordinates
- Inventory/availability — **no**: `inStock` is hardcoded `true`
- Categories — **no**
- Product metadata — brand, size, `storeProductUrl`; no UPC

**Authentication:** Anonymous session cookie (identical mechanism to Aldi) for search/pricing.
No auth for the image-fallback path beyond a realistic browser fingerprint.

**Reliability: Moderate**, and lower than Aldi specifically because of the added Playwright
dependency:
- Same undocumented-platform/persisted-query-hash risk as Aldi for the core data path.
- The image-fallback path adds a full headless-browser dependency (`navigator.webdriver`
  patching, spoofed user-agent, `--disable-blink-features=AutomationControlled`) purely to
  backfill photos — real maintenance surface for a non-essential feature.
- A Playwright session-state file (`.sprouts-session.json`, ~28KB, checked into the working
  directory) persists browser cookies to disk — see Risks for why this is a deployment concern.

**Current implementation status: Mostly complete** for search/pricing/locations.
**Experimental** for the image-fallback path specifically — it works, but is disproportionately
heavy machinery (a full browser launch per missing image) for what it does, and is the single
most fragile piece of this integration.

---

### Trader Joe's

| | |
|---|---|
| **Data source** | Trader Joe's own public storefront GraphQL API (first-party, not a third-party platform) |
| **Implementation** | `traderJoesLiveScraper.ts`, `locators/traderJoesLocator.ts` |

**How data is obtained:** `traderjoes.com/api/graphql` is TJ's real Magento-based storefront
schema. A one-time Playwright visit to the storefront establishes session cookies (persisted to
`.traderjoes-session.json`); every subsequent search reuses those cookies through a **plain HTTP
request context** (Playwright's `request.newContext`, not a rendered browser) — no browser
process per search, only for the initial bootstrap. This was a deliberate optimization: launching
headless Chromium for every search was "the single biggest first-search cost in the whole app."
Store locations come from TJ's own public locator sitemap (~660 real stores) plus each store
page's embedded `schema.org/GroceryStore` JSON-LD — fully public, no auth, no guessing.

**Verified-live finding documented in the locator's header comment:** TJ's GraphQL schema
exposes a `pickupLocations` field that looks like a real store-search API, but returns
`total_count: 0` for every query tried across six cities/zips/states — confirmed to be an
unpopulated Magento platform feature, not a working TJ's feature. The sitemap-based directory
approach is used instead specifically because this was checked and ruled out, not assumed.

**Available data:**
- Product search — yes
- Pricing — yes
- Promotions — **no**
- Product images — yes (relative path resolved to an absolute URL)
- Store locations — yes, real, public, ~660 stores
- Inventory/availability — the query filters on `availability: {match: "1"}` server-side, but no
  per-item boolean is surfaced to the app — `inStock` is hardcoded `true`
- Categories — used internally only to filter to the "Food" department; not exposed
- Product metadata — brand is always literally `"Trader Joe's"` (TJ's doesn't sell third-party
  brands); no UPC

**Authentication:** Anonymous storefront session cookies, established via a one-time headless
browser visit and reused as plain HTTP thereafter. No API key, no login.

**Reliability: Good.**
Stronger than Aldi/Sprouts because this is TJ's *own* first-party schema, not a third-party
platform's — one fewer vendor in the risk chain. Still not documented or versioned, so shape
changes are unannounced. Two real operational risks: (1) the Playwright-based session bootstrap
(3–30s on a cold cache) is real added latency the app works around via startup warm-up, not a
guarantee; (2) the session is persisted to a local JSON file, which is a deployment risk under
horizontal scaling (see Risks).

**Current implementation status: Mostly complete.**
Search/pricing/images/locations all work well. Missing promotions, per-item availability,
categories, and UPC — same gaps as Aldi/Sprouts, structurally, even though the underlying source
is more trustworthy.

---

### Albertsons

| | |
|---|---|
| **Data source (products)** | **None — intentionally unimplemented** |
| **Data source (locations)** | Public, unauthenticated Yext-powered store locator (`local.albertsons.com`) |
| **Implementation** | `albertsonsLiveScraper.ts`, `locators/albertsonsLocator.ts` |

**How data is obtained:** Albertsons' real shopping/product catalog (internally called the
"Nimbus" API) sits behind full Okta account login — a real username/password, not an app-level
credential like Kroger's OAuth client, and not an anonymous session like Aldi/Sprouts/TJ. The
code deliberately does not build against it: scraping a real personal account's authenticated
session would be the exact brittle, ToS-fragile pattern this app avoids everywhere else, and
there's no app-level credential Albertsons issues instead. `searchAlbertsons` always resolves to
an empty array — never throws, never blocks the other five stores, never fabricates a price.

Store *locations* are a separate, genuinely solvable problem: `local.albertsons.com` is a real
public Yext-powered locator site (confirmed live: a real `sitemap.xml`; `robots.txt` disallows
only the interactive `/locator` path, not the static store pages) whose per-store pages embed a
`Yext.Profile` JSON object with real address/coordinates/store ID directly in the HTML — readable
with a plain unauthenticated GET, no JS execution, no login. The locator implementation is
structurally identical to Trader Joe's (sitemap crawl → filter by state → exact-city match, with
a bounded geocode-ranked fallback for ties).

**Available data:**
- Product search — **no**
- Pricing — **no**
- Promotions — **no**
- Product images — **no**
- Store locations — **yes**, real, public
- Inventory/availability — **no**
- Categories — **no**
- Product metadata — `entityId` only

**Authentication:** None for locations (fully public). Products would require full Okta
user-account OAuth — not implemented, by design.

**Reliability:** **Good** for what exists (locations — same sitemap/embedded-JSON pattern as
Trader Joe's, a proven-reliable shape in this codebase). **Not applicable / by-design absent**
for products — this isn't a broken integration, it's a boundary the team drew deliberately.

**Current implementation status: Partial, and honestly labeled as such.**
`searchService.ts` marks Albertsons' `StoreStatus` as `'unavailable'` rather than `'error'`
specifically so the UI can say "temporarily unavailable" instead of implying something is
broken. This is the correct design for a retailer with no legitimate data source, and should be
the template for any future retailer that turns out to have the same structural blocker (see
Safeway/Vons/Jewel-Osco/Tom Thumb/Randalls below — all Albertsons banners, same wall).

---

## 2 & 3. Additional Retailers — Research & Classification

Findings below are labeled per-claim: **[Verified]** means tested against a live endpoint this
session (an actual HTTP request, not a memory of how the site behaves); **[Research]** means an
informed estimate from general knowledge, not tested this session. Classified into: **Ready to
Integrate**, **Feasible with Additional Work**, **Experimental**, **Not Recommended**.

A recurring, important fact: several retailers on the requested list are **banners of the same
parent company** and likely share backend infrastructure. Grouping by parent avoids treating
many separate research efforts as independent unknowns.

### Kroger family — RESOLVED, see Section 1

**Harris Teeter** was the Phase 1 candidate from this family. It's now **implemented** — see
Section 1 → Harris Teeter, above, for the full live-verified writeup (Locations API, Products
API, OAuth reuse, and the real mislabeling bug it fixed along the way). Moved out of "candidate"
status entirely; no longer a research item.

Kroger Co.'s other banners (Ralphs, Fred Meyer, King Soopers, Smith's, QFC, Fry's, Dillons, City
Market, Mariano's, Pick 'n Save, and others) were **not** investigated this round — out of scope
for this phase, but **[Research]**: given Harris Teeter's `chain` code turned out to be a plain,
queryable Locations API field (`filter.chain=HART`), it's a reasonable expectation that these
banners work the identical way, each needing only its own confirmed `chain` code — the same
one-banner-at-a-time pattern this file's `KrogerBanner` config now supports. Worth a follow-up
audit if/when ShopSmart's geographic footprint expands toward those regions (mostly
Midwest/West).

### Albertsons family

**Safeway, Vons, Jewel-Osco, Tom Thumb, Randalls** are all Albertsons Companies banners — the
same Nimbus/Okta wall documented in Section 1 almost certainly applies to product data for all
five identically. Their store locators are plausibly also Yext-powered (Albertsons' own is), but
this has not been checked live for each banner site.

- Pricing reliably obtainable: **no** — same account-login wall as Albertsons itself.
- Store locations: **plausible**, pending live confirmation per banner domain (e.g.
  `local.safeway.com`) — if confirmed, the existing `albertsonsLocator.ts` pattern is directly
  reusable.
- Location-specific pricing: N/A (no pricing source).
- Auth required: none for locations if the Yext pattern holds; full Okta login for pricing
  (same as Albertsons, not pursued).
- Sustainable: locations only.
- Legally/technically reasonable: locations yes; pricing no (same reasoning as Albertsons).

**Classification: Feasible with Additional Work** for **locations only** (cheap, high-confidence
extension of an existing pattern). **Not Recommended** for pricing (identical blocker to
Albertsons). See Section 4 for why "cheap" doesn't automatically mean "prioritize" here — a
locations-only store adds little real value on its own, per Albertsons' own current experience.

### Ahold Delhaize family

**Food Lion, Giant** *(Giant Food, the Ahold Delhaize banner — not Giant Eagle, an unrelated
independent Pittsburgh-based chain; the name collision is a real gotcha worth remembering)*, and
**Stop & Shop** are all Ahold Delhaize USA banners, alongside Hannaford and others not on this
list.

**[Verified]** A light, single-request reconnaissance pass (`GET /robots.txt` on each domain —
the same risk profile as this app's existing anonymous session-bootstrap requests, no login, no
deep crawling) confirms the "shared infrastructure" hypothesis from the prior audit: `giantfood.com`,
`stopandshop.com`, and `foodlion.com` (after its redirect) all serve a **byte-for-byte identical
`robots.txt`** — same comments, same rule groups, same legacy `.jhtml` URL patterns
(`consumerIndex.jhtml`, `merchantIndex.jhtml`, `itemDetailView.jhtml`, characteristic of an older
enterprise e-commerce platform), same `Disallow: /api/`, `/apis/`, `/v1/` entries. This is strong,
directly-observed evidence all three banners run one shared platform, consistent with Ahold
Delhaize's known "Peapod Digital Labs" shared tech stack — a single research/integration effort
would very likely apply to all three, exactly as hypothesized.

**[Verified] — and this is the decisive finding:** that shared `robots.txt` explicitly lists
`ClaudeBot`, `GPTBot`, `ChatGPT-User`, `PerplexityBot`, and `Google-Extended` by name, and
disallows exactly those crawlers from `/product/`, `/product-search/`, and `/browse-aisles/` —
the paths a price-comparison integration would need. This is a machine-readable, explicit policy
statement naming this exact class of agent (including the one auditing this document) as
unwelcome on the pages this integration would depend on. That's a materially stronger signal
than "no known public API" — it's the retailer's own stated position, discovered directly rather
than assumed.

- Pricing reliably obtainable: **[Verified] no confirmed path** — `/api/`, `/apis/`, and `/v1/`
  are explicitly disallowed for all crawlers in `robots.txt`, and the specific pages needed are
  disallowed by name for AI agents specifically.
- Store locations: unconfirmed — not investigated further once the robots.txt policy was found
  (see below for why).
- Auth required: unconfirmed.
- Sustainable: **no**, given the explicit policy.
- Legally/technically reasonable: **no** — regardless of technical feasibility, this app's own
  standard (see Section 6/7) is to treat an explicit access policy as a hard stop, not an
  obstacle to route around. No further reconnaissance (product pages, API probing) was attempted
  on any of these three domains once this was found, out of respect for that policy.

**Classification: Not Recommended**, for all three — a reclassification from the prior audit's
"Experimental," driven by a verified finding, not a change of opinion.

### Walmart

Walmart's real consumer storefront has no public, unauthenticated product/pricing API suitable
for this use case (the "Walmart Open API"/marketplace APIs are for sellers, not price lookup).
The storefront itself runs mature, well-known anti-bot protection (Akamai/PerimeterX-class),
and Walmart has a documented history of enforcing against scraping. Even if data is technically
extractable today, it fails the "sustainable" and "not just because data exists somewhere" bars
explicitly named in this audit's brief.

- Pricing reliably obtainable: no (not sustainably, without a paid data-licensing relationship).
- Store locations: yes (public locator), but low value in isolation without pricing.
- Auth required: none for locations; scraping pricing would require defeating active anti-bot
  measures.
- Sustainable: no.
- Legally/technically reasonable: no.

**Classification: Not Recommended.** (A licensed commercial data-partnership would change this
calculus entirely, but that's a business decision, not an engineering one.)

### Target

Same profile as Walmart: an internal, undocumented API exists (widely reverse-engineered by
third parties as "redsky"), but it's unversioned, unofficial, and sits behind mature anti-bot
protection. Target's ToS explicitly prohibits automated data collection.

**Classification: Not Recommended.**

### H-E-B

Privately held, Texas-only regional chain (no developer program, no known public API).

**[Verified]** A plain unauthenticated `GET https://www.heb.com/` — the same request shape that
successfully bootstraps Aldi/Sprouts/Trader Joe's sessions today — does not return real page
content. It returns an **Imperva Incapsula** bot-challenge shell (`/_Incapsula_Resource?...`
script tags, an `incident_id`, a hidden challenge iframe) instead, and `robots.txt` itself is
served through the same challenge layer rather than as plain text. This is active, live-confirmed
anti-bot infrastructure at the edge — not a maybe.

**Classification: Not Recommended** — reclassified from the prior audit's "Experimental" based on
this verified finding. Even setting aside H-E-B's limited regional (Texas-only) value, the
confirmed Incapsula layer puts it in the same risk category as Walmart/Target, not the same
category as Aldi/Sprouts/Trader Joe's (whose homepages all respond with real content to the exact
same kind of plain request).

### Whole Foods

Fully integrated into Amazon's own ordering/pricing systems (Amazon Fresh/Whole Foods online).
No independent public API; scraping an Amazon-family property carries the same anti-bot and
legal-risk profile as Amazon.com itself, which is materially higher than any retailer currently
integrated.

**Classification: Not Recommended.**

### Costco

Most online pricing is behind a membership login wall — a structural blocker of the same shape
as Albertsons' Okta wall (this app already has a principled position on that: don't build
against a personal-account login). No public API.

**Classification: Not Recommended.**

### Sam's Club

Walmart-owned; same membership-wall blocker as Costco, plus Walmart's anti-bot posture.

**Classification: Not Recommended.**

### Meijer

Midwest regional chain. Has a rewards app ("mPerks") but no known public product/pricing API.

**[Verified]** The same plain unauthenticated `GET https://www.meijer.com/` request returns HTTP
403, and `robots.txt` returns a literal Akamai **"Access Denied"** page
(`errors.edgesuite.net` reference ID included) rather than a robots policy — meaning Meijer
blocks even the most basic, non-authenticated crawler-etiquette request at the Akamai edge, before
any application code runs. This is a materially more aggressive posture than Aldi/Sprouts/Trader
Joe's, all three of which serve real content to the identical request.

**Classification: Not Recommended** — reclassified from the prior audit's "Experimental" based on
this verified finding. The "structurally similar to Aldi/Sprouts" hypothesis from the prior audit
did not hold up against a live check; Meijer's edge posture is closer to Walmart/Target than to
any of ShopSmart's three currently-working undocumented-API integrations (Aldi, Sprouts, Trader
Joe's).

### Publix

No public API. Notably, Publix has a real, known history of aggressively pursuing anti-scraping
enforcement in the grocery-scraper community — a materially different risk posture than any of
ShopSmart's six currently-working "quiet" integrations, none of which have drawn that kind of
attention. High regional user demand (Southeast) does not offset this.

**Classification: Not Recommended** — this is the clearest case in this audit of "high demand,
high risk" where risk should win.

### Food Lion, Giant, Stop & Shop

See "Ahold Delhaize family" above.

### Safeway, Vons, Jewel-Osco, Tom Thumb, Randalls

See "Albertsons family" above.

### Winn-Dixie

Owned by Southeastern Grocers. No known public API, no confirmed platform. Regional
(Southeast/Florida).

**Classification: Experimental**, low-to-moderate priority.

### Wegmans

No public API. Privately held, and — like Publix — has a reputation in the scraper community for
being resistant to unauthorized data collection. Extremely high user demand in its footprint
(Northeast/Mid-Atlantic) does not change the risk calculus.

**Classification: Not Recommended**, for the same reason as Publix.

### Hy-Vee

Midwest regional chain with an "Aisles Online" storefront. No confirmed public API.

**[Verified]** The same plain unauthenticated request against `www.hy-vee.com` returns HTTP 403,
and `robots.txt` is served as a **Cloudflare "Attention Required"** interactive challenge page
rather than plain text (confirmed via response body and `cf-ray` header). `aisles-online`
(the storefront path) returns the same Cloudflare challenge. This is active, live-confirmed
bot-management at the edge.

**Classification: Not Recommended** — reclassified from the prior audit's "Experimental" based on
this verified finding, for the same reason as Meijer and H-E-B: confirmed edge-level bot defense
puts this outside the risk profile of ShopSmart's working undocumented-API integrations.

### Classification summary table

`V` = verified live this session. `R` = research/estimate, not tested this session.

| Retailer | Pricing | Locations | Classification |
|---|---|---|---|
| Kroger *(current)* | Official API `V` | Official API `V` | **Ready** (implemented) |
| Harris Teeter *(current)* | Official Kroger API `V` | Official Kroger API `V` | **Ready** (implemented this phase) |
| Aldi *(current)* | Undocumented platform API `V` | Undocumented platform API `V` | **Ready** (implemented, Moderate risk) |
| Sprouts *(current)* | Undocumented platform API `V` | Undocumented platform + first-party detail API `V` | **Ready** (implemented, Moderate risk) |
| Trader Joe's *(current)* | First-party undocumented API `V` | Public sitemap + JSON-LD `V` | **Ready** (implemented, Good) |
| Albertsons *(current)* | None (Okta wall) `V` | Public Yext sitemap `V` | **Ready** (implemented, locations only, honestly) |
| Safeway / Vons / Jewel-Osco / Tom Thumb / Randalls | Not Recommended (Okta wall) `R` | Feasible with Additional Work `R` | **Split** — see Albertsons family |
| Meijer | No sustainable path — Akamai block confirmed `V` | Not investigated further | **Not Recommended** |
| H-E-B | No sustainable path — Incapsula challenge confirmed `V` | Not investigated further | **Not Recommended** |
| Hy-Vee | No sustainable path — Cloudflare challenge confirmed `V` | Not investigated further | **Not Recommended** |
| Food Lion / Giant / Stop & Shop | No sustainable path — explicit robots.txt policy naming AI crawlers `V` | Not investigated further (policy respected) | **Not Recommended** |
| Winn-Dixie | Unconfirmed `R` | Unconfirmed `R` | **Experimental** (not investigated this phase) |
| Walmart | No sustainable path `R` | Public but low value alone `R` | **Not Recommended** |
| Target | No sustainable path `R` | Public but low value alone `R` | **Not Recommended** |
| Whole Foods (Amazon) | No sustainable path `R` | N/A | **Not Recommended** |
| Costco | Membership wall `R` | N/A | **Not Recommended** |
| Sam's Club | Membership wall `R` | N/A | **Not Recommended** |
| Publix | Active anti-scraping enforcement `R` | N/A | **Not Recommended** |
| Wegmans | Active anti-scraping posture `R` | N/A | **Not Recommended** |

---

## 4. Integration Priority

Ranked by realistic value (pricing-comparison usefulness × reliability), not by raw engineering
cost — a cheap integration that only adds locations without prices repeats Albertsons' own
"unavailable" experience and shouldn't be pursued just because it's easy.

1. ~~**Harris Teeter**~~ — **done.** Verified compatible with the existing Kroger API and
   implemented this phase: real pricing, real locations, the same Excellent reliability tier as
   Kroger itself, for East Coast markets the other five stores don't reach. Also fixed a real,
   live-confirmed mislabeling bug in the existing Kroger integration as a direct consequence (see
   Section 1 → Harris Teeter).

2. ~~**Research spike: Meijer / H-E-B / Hy-Vee platform investigation**~~ — **done, negative
   result.** Live reconnaissance found active edge-level bot defense on all three (Akamai hard
   block on Meijer, Imperva Incapsula challenge on H-E-B, Cloudflare challenge on Hy-Vee) — a
   fundamentally different posture from Aldi/Sprouts/Trader Joe's, whose homepages all serve real
   content to the same plain request. All three move to **Not Recommended**. This is the correct
   outcome of "don't force it," not a failure of the spike.

3. ~~**Research spike: Ahold Delhaize family**~~ — **done, negative result.** Food Lion, Giant,
   and Stop & Shop confirmed to share one platform (byte-for-byte identical `robots.txt` across
   all three), but that same file explicitly names AI crawlers — including this one — as
   disallowed from the product/search paths this integration would need. Moves to **Not
   Recommended** on policy grounds, not just technical ones.

4. **Kroger's other banners** (Ralphs, Fred Meyer, King Soopers, Smith's, QFC, and others) — not
   investigated this phase, but a reasonable next candidate given Harris Teeter's success: same
   API, same OAuth client, likely just another `chain` code each. Worth a follow-up audit
   specifically if/when ShopSmart's user base expands toward the Midwest/West markets those
   banners serve.

5. **Albertsons-family locations (Safeway / Vons / Jewel-Osco / Tom Thumb / Randalls)** —
   deliberately **not** prioritized despite low technical cost. Confirm the Yext pattern holds
   for one banner (e.g. Safeway) as a quick check, but don't build out all five location-only
   integrations unless/until a legitimate pricing source for the Albertsons family appears (e.g.
   the user's own developer/business API access, which `albertsonsLiveScraper.ts`'s own comment
   already names as the one thing that would change this). Five more "unavailable" stores dilute
   the app's current trust story without adding shopping value.

6. **Everything in "Not Recommended"** — do not revisit unless the underlying blocker changes
   (e.g., a retailer launches an official developer API, or ShopSmart pursues a licensed
   commercial data partnership, which is a business decision outside this audit's scope).

**Why this order:** geographic coverage and pricing-comparison value are weighted far above raw
"is there *any* data source" feasibility. Harris Teeter won because it was simultaneously the
lowest engineering effort, the highest reliability tier available, and added real new coverage —
and it's now shipped. The Phase 2 research spikes (Meijer/H-E-B/Hy-Vee/Ahold Delhaize) were
exactly as cheap to run and just as valuable to prioritize *first*, even though they came back
negative — knowing definitively not to build something is real engineering progress, not a
wasted afternoon.

---

## 5. Architecture Recommendations

### Strengths

- **A consistent de facto adapter shape.** Every store module exports `search*(query, zip,
  preciseCoords?) → ApiProduct[]`, a `normalize*Product()`, a `warm*()`, and a locator
  implementing the shared `StoreLocator` interface (`locators/types.ts`). This convention makes
  the five current integrations easy to compare and reason about side by side, even without a
  formal shared type (see Weaknesses).
- **Real shared plumbing, not reinvented per store:** `TtlCache`, `dedupeInFlight`,
  `withTimeout`, and `geocode.ts` are used identically by all five adapters, so caching, request
  deduplication, and timeout behavior are consistent rather than five slightly different
  implementations.
- **Provenance tracking.** `StoreLocation.source` (`'kroger-api'`, `'aldi-instacart'`,
  `'sprouts-locator'`, `'traderjoes-sitemap'`, `'albertsons-sitemap'`) and `metadata` make every
  resolved store address traceable to exactly which real, retailer-native source produced it —
  a genuinely good pattern for debugging and for the "never fabricate data" principle this
  codebase holds itself to elsewhere.
- **Honest-failure design.** Albertsons is the working template for "we don't have this
  capability yet": an empty result, a distinct `'unavailable'` status (not `'error'`), and a
  clear UI message — rather than faking data or silently degrading. Any future
  partial-capability retailer should follow this exact pattern.
- **Centralized warm-up.** `warmupService.ts` moves every store's one-time session/token cost out
  of the request path uniformly, with per-store timing and independent failure isolation.

### Weaknesses

- **No formal `StoreAdapter` interface.** The adapter "contract" (search/normalize/locate/warm
  signatures) exists only as a convention, documented in a comment inside
  `albertsonsLiveScraper.ts` — not as a TypeScript interface anything is checked against. Nothing
  stops a new adapter's function signature from silently drifting.
- **The store list is hand-duplicated across many files.** Adding a retailer today means editing,
  by hand: `searchService.ts`'s `ALL_STORES` array, its `UNAVAILABLE_STORES` set, its
  `Promise.allSettled` fan-out array, its `collectStoreResult` call list; `warmupService.ts`'s
  `buildTasks`; `types/index.ts`'s `ApiProduct.store` union; and the frontend's
  `src/models/types.ts` `STORE_NAMES`/`UNAVAILABLE_STORES`. That's six-plus independent
  touch-points for one new store, with no compiler-enforced link between them.
- **Duplicated locator logic between Trader Joe's and Albertsons.** `traderJoesLocator.ts` and
  `albertsonsLocator.ts` are structurally near-identical: sitemap crawl → filter by state →
  exact-city match → bounded geocode-ranked fallback → fetch + parse an embedded JSON blob from
  the detail page. Functions like `pickNearestByAddress`, `pickNearestByCity`, and
  `citySlugToName` are duplicated close to verbatim between the two files.
- **Duplicated platform logic between Aldi and Sprouts.** Both run the same Instacart-backed
  platform, same persisted-query hash, same session-cookie mechanism, same self-heal-on-stale-
  session retry — implemented as two separate ~300–400 line files rather than one parameterized
  factory.
- **No shared "capabilities" signal.** Whether a store supports promotions, categories,
  inventory, or UPC is currently implicit (whichever fields happen to be populated) rather than
  explicit — the frontend has no principled way to know "Aldi has categories, nobody else does"
  without inspecting actual responses.
- **No per-store rate-limiting/backoff policy.** Each adapter handles resilience ad hoc (Aldi/
  Sprouts retry once on session invalidation; Kroger and Trader Joe's have none beyond a blanket
  timeout). A store having a bad day currently just eats its full timeout budget on every search
  rather than backing off.
- **Synthetic ratings are indistinguishable from real ones.** `rating`/`reviewCount` are a
  deterministic hash of the product ID on all five live-pricing stores (Kroger, Harris Teeter,
  Aldi, Sprouts, Trader Joe's) — presented in the exact same field shape a genuinely
  retailer-sourced rating would be, with nothing marking it as non-authoritative. For Kroger and
  Harris Teeter specifically this is no longer even a "no real data exists" gap — the live API
  response already carries genuine review data the current mapper ignores (Section 1 → Kroger
  "Bonus finding").

### Opportunities for standardization

1. **Introduce an explicit `StoreAdapter` interface** — `{ search, normalizeProduct, locator,
   warm, capabilities: { pricing, promotions, images, inventory, categories, locations } }` —
   and have `searchService.ts` iterate a `STORE_ADAPTERS` registry instead of hand-wiring each
   store by name. This turns "add a retailer" from "touch ~6 files" into "write one adapter
   module + one registry entry," and makes the capability gaps in Section 1's tables
   machine-readable instead of only documented in prose.
2. **Extract a shared `createSitemapDirectoryLocator(config)` factory** for the Trader
   Joe's/Albertsons shape (sitemap → state filter → city match → geocode fallback → detail-page
   parse), parameterized by sitemap URL, URL pattern, and a detail-page parser callback. This is
   the single lowest-risk, highest-confidence refactor available — the two implementations are
   already close enough to identical that unifying them is close to mechanical.
3. **Extract a shared `createInstacartPlatformAdapter(config)` factory** for the Aldi/Sprouts
   shape (anonymous session bootstrap, persisted-query GraphQL search, self-heal-on-stale-session
   retry), parameterized by base URL and store name. Cuts real duplication today. (Phase 2's
   research spike found Meijer/H-E-B/Hy-Vee are *not* Instacart-platform retailers — see Section
   2 — so this factory's near-term payoff is smaller than hoped; it's still worth doing purely to
   de-duplicate Aldi/Sprouts themselves, just without an obvious third beneficiary today.)
4. **The new `KrogerBanner` pattern is the template for the whole "banner family" problem** —
   already implemented, not just proposed. `krogerLiveScraper.ts` now defines one small
   `{ storeName, chain, idSlug }` config per banner, with a single shared `searchKrogerBanner()`
   implementation and per-banner `createKrogerLocator(getToken, chain, displayName)` locator
   instances. This is the same shape Section 2's Kroger-family note recommends for any future
   banner (Ralphs, Fred Meyer, King Soopers, ...) — a config object, not a new file — and is worth
   treating as the reference example the first time someone builds the more general
   `StoreAdapter` interface in recommendation #1.
5. **Single source of truth for the store list.** Generate or share the store-name union across
   backend and frontend rather than maintaining parallel hand-written lists — even a simple
   shared JSON/constants file both sides import eliminates the current touch-point problem (now
   seven files for a new banner-less retailer: `types/index.ts`, `models/types.ts`,
   `theme/colors.ts`, `searchService.ts` ×2, `warmupService.ts`, plus whichever new scraper file).
6. **Surface `capabilities` as data**, not implied by field presence, so the frontend can render
   "Aldi shows category, most stores don't" honestly instead of just leaving a field blank with
   no explanation.

None of this needs to happen before Harris Teeter (a same-adapter extension gains nothing from a
new interface). It matters starting with the *next* genuinely new adapter — the second or third
Instacart-platform retailer, or the second sitemap-directory retailer, is where duplicated code
actually starts costing real maintenance time.

---

## 6. Risks

| Risk | Applies to | Mitigation |
|---|---|---|
| **Undocumented endpoint/schema changes** (persisted-query hash rotation, GraphQL shape changes) | Aldi, Sprouts, Trader Joe's | Expand the existing unit-fixture tests (`aldiLiveScraper.test.ts`, etc.) with a small scheduled *live* smoke test hitting each real endpoint with a known query, alerting on failure — not just failing silently until a shopper reports empty results. |
| **Session/auth mechanism changes** (Instacart platform session cookie shape, Kroger OAuth scope, Okta wall for any Albertsons-family banner) | Aldi, Sprouts, Kroger, Harris Teeter, Albertsons-family | Keep the self-healing retry-on-invalid-session pattern (already implemented for Aldi/Sprouts) as the required template for any new session-based adapter. Document Kroger credential renewal in an ops runbook — note it now gates two banners, not one. |
| **Rate limiting** | All six, especially Kroger and Harris Teeter, which now share one quota (documented daily limit, currently untracked in-app) | Track request volume per store against known/estimated limits; respect `Retry-After` headers; keep the existing 5–15 min TTL caching aggressive so repeat searches don't re-hit live endpoints. Harris Teeter sharing Kroger's OAuth client means its request volume now counts against the same quota — worth watching once both are live in production. |
| **CAPTCHAs / anti-bot protections** | Not yet hit by the 5 working stores; **live-confirmed this phase** as the reason Meijer, H-E-B, and Hy-Vee join Walmart/Target/Publix/Wegmans in Not Recommended (Akamai/Incapsula/Cloudflare challenges respectively, all observed directly) | Keep request volume low and cached; don't add browser automation to a path that doesn't strictly need it (Trader Joe's already optimized this away for the hot path); treat any CAPTCHA/challenge sighting on a currently-working store as a "stop and reassess," never a "solve it and continue." |
| **Legal/ToS concerns** | Any prospective retailer, most acutely Publix/Wegmans (active enforcement history) and, **newly confirmed this phase**, the Ahold Delhaize family (Food Lion/Giant/Stop & Shop), whose shared `robots.txt` explicitly names AI crawlers as disallowed from the relevant paths | Treat legal/ToS review as a gate before a retailer can move out of "Experimental," not an afterthought done after code is written. "Data exists somewhere" is explicitly not sufficient justification — that's the whole point of the "Not Recommended" tier. An explicit, machine-readable policy naming this exact class of agent is treated as a hard stop, not a technical obstacle. |
| **Data inconsistency between stores** (only some carry promotions/categories/inventory; ratings are fully synthetic everywhere) | All six | Adopt the `capabilities` metadata proposed in Section 5 so absence is explicit, not silently implied by an empty field; stop presenting synthetic ratings in the same shape as genuine retailer data — especially now that real Kroger rating/review data was found unused in the API response (Section 1 → Kroger "Bonus finding"), so this is no longer purely a "no data exists" problem for at least one store. |
| **Deployment/statelessness risk from disk-persisted sessions** (`.traderjoes-session.json`, `.sprouts-session.json` living in the backend's working directory) | Trader Joe's, Sprouts' image-fallback path | Fine for a single long-lived process; breaks silently (falls back to a slow cold-start, not a hard failure) under horizontal scaling or ephemeral containers. If/when this backend moves to multi-instance or serverless deployment, replace with a shared session store (e.g. Redis) or budget for the cold-start cost explicitly per instance. |

---

## 7. Final Recommendation

**Which retailers should be implemented next?**
Harris Teeter is done — verified compatible and shipped this phase (see Section 1). The
next-best candidate is investigating Kroger Co.'s *other* banners (Ralphs, Fred Meyer, King
Soopers, Smith's, QFC, ...) the same way: the `KrogerBanner` pattern this phase introduced makes
each one a small config addition, not new engineering, *if* ShopSmart's user base expands toward
the regions those banners serve. Everything else researched this phase (Meijer, H-E-B, Hy-Vee,
Food Lion/Giant/Stop & Shop) came back negative — see below.

**Which retailers should be avoided?**
Walmart, Target, Costco, Sam's Club, Whole Foods (Amazon-integrated), Publix, Wegmans, and — as of
this phase's live findings — **Meijer, H-E-B, Hy-Vee, Food Lion, Giant, and Stop & Shop**. Each
fails at least one of: no sustainable technical path (mature, **live-confirmed** anti-bot
protection — Akamai on Meijer, Imperva Incapsula on H-E-B, Cloudflare on Hy-Vee), a structural
membership/login wall (same category of blocker that already rules out Albertsons product data),
a known active anti-scraping enforcement posture (Publix/Wegmans), or an explicit,
**live-confirmed** machine-readable policy against AI-agent access (the Ahold Delhaize family's
shared `robots.txt`). High user demand for Publix, Wegmans, and Hy-Vee specifically does not
change this — it's the clearest instance in this audit of the brief's core instruction: don't
assume feasibility just because data exists somewhere online, and now, concretely, don't assume
it just because a similarly-undocumented API worked for a different retailer (Aldi/Sprouts)
either — verify each one.

**Which current integrations need improvement?**
Sprouts' Playwright-based image-fallback path is the single most fragile piece of the working
integrations and is a reasonable candidate to simplify or remove. Both Trader Joe's and Sprouts
persist session state to local disk files, which should move to shared storage before any
multi-instance deployment. Aldi and Sprouts would both benefit from scheduled live-endpoint
smoke tests given their total dependence on an undocumented, unversioned persisted-query
contract. Across all five live-pricing stores (Kroger, Harris Teeter, Aldi, Trader Joe's,
Sprouts), the synthetic `rating`/`reviewCount` fields should either be clearly marked
non-authoritative in the API response or dropped — and for Kroger/Harris Teeter specifically,
this is now a confirmed, low-effort *real* fix rather than a "no data exists" gap: the live
Products API response already carries genuine `ratingsAndReviews` data that the current mapper
ignores in favor of a fabricated value (Section 1 → Kroger "Bonus finding").

**Which integrations are production-ready today?**
Kroger and Harris Teeter, unambiguously (same official API, Excellent rating, both verified live
this phase). Aldi, Trader Joe's, and Sprouts are all genuinely working and shipped (Good/Moderate
reliability) with known, documented, monitored risk — appropriate for production as long as the
smoke-testing and session-storage improvements above are tracked, not ignored. Albertsons is
production-ready *for exactly what it claims to do* — real store locations, and an honest
"unavailable" for products — which is a correct, shippable design, not a gap that needs a rushed,
worse fix (a login-scraping hack) to look "complete."

---

## Phase 1 Summary

*(Historical record — written before Harris Teeter was verified/implemented. See "Phase 2
Summary" below for the current state.)*

**1. Stores evaluated:** the 5 currently integrated (Kroger, Aldi, Sprouts, Trader Joe's,
Albertsons) plus 19 researched candidates (Walmart, Target, H-E-B, Whole Foods, Costco, Sam's
Club, Meijer, Publix, Food Lion, Safeway, Vons, Jewel-Osco, Tom Thumb, Randalls, Harris Teeter,
Winn-Dixie, Giant, Stop & Shop, Wegmans, Hy-Vee) — 24 retailers total.

**2. Classifications assigned:** Kroger/Aldi/Sprouts/Trader Joe's/Albertsons — already
implemented, at Excellent/Moderate/Moderate/Good/Good-for-locations-only reliability
respectively. Harris Teeter — **Ready to Integrate**. Safeway/Vons/Jewel-Osco/Tom
Thumb/Randalls — **Feasible with Additional Work** for locations, **Not Recommended** for
pricing. Food Lion/Giant/Stop & Shop, Meijer, H-E-B, Winn-Dixie, Hy-Vee — **Experimental**.
Walmart, Target, Whole Foods, Costco, Sam's Club, Publix, Wegmans — **Not Recommended**.

**3. Architectural improvements recommended:** a formal `StoreAdapter` interface with explicit
per-store `capabilities`; a shared `createSitemapDirectoryLocator` factory (Trader Joe's ≈
Albertsons duplication); a shared `createInstacartPlatformAdapter` factory (Aldi ≈ Sprouts
duplication); a single source of truth for the store-name list instead of six hand-maintained
copies; and moving disk-persisted browser sessions (Trader Joe's, Sprouts) to shared storage
before any multi-instance deployment.

**4. Immediate implementation opportunities discovered:** Harris Teeter, via the Kroger API
ShopSmart already has fully working credentials and code for — the highest-value,
lowest-effort opportunity found in this audit, pending a single live verification check.

---

## Phase 2 Summary

**1. Stores evaluated this phase:** Harris Teeter (moved from candidate to **verified and
implemented**), plus live reconnaissance on Meijer, H-E-B, Hy-Vee, and the Ahold Delhaize family
(Food Lion, Giant, Stop & Shop) — 6 retailers directly investigated with real HTTP requests this
phase, out of the 19 Phase 1 candidates.

**2. Classifications changed:** Harris Teeter: candidate → **Ready** (implemented). Meijer, H-E-B,
Hy-Vee: **Experimental** → **Not Recommended** (live-confirmed Akamai/Incapsula/Cloudflare
edge-level bot defense on each, respectively — a fundamentally different, more hostile posture
than any of ShopSmart's three working undocumented-API integrations — Aldi, Sprouts, Trader
Joe's). Food Lion, Giant, Stop &
Shop: **Experimental** → **Not Recommended** (confirmed shared platform via identical
`robots.txt`, but that same file explicitly disallows AI crawlers — including this one — from the
relevant paths; a policy finding, not just a technical one).

**3. Architectural improvements delivered, not just recommended:** the `KrogerBanner` pattern
(`{ storeName, chain, idSlug }` config + one shared `searchKrogerBanner()` implementation + a
`chain`-parameterized `createKrogerLocator`) is now real code, not a proposal — see Section 5,
recommendation 4. It also closed a live-confirmed bug: an unfiltered Kroger locator was silently
mislabeling Harris Teeter stores as "Kroger" in Harris Teeter markets before this change.

**4. Immediate implementation opportunities discovered:** none remaining from this phase's
research — Meijer/H-E-B/Hy-Vee/Ahold Delhaize all resolved to Not Recommended. The next
candidate worth a live check is Kroger Co.'s other banners (Ralphs, Fred Meyer, King Soopers,
...) using the same verification method this phase proved out, gated on ShopSmart's geographic
expansion plans rather than pursued speculatively.

---

## Phase 2 Implementation Roadmap

Ranked by expected engineering effort, long-term maintainability, and user impact — the three
axes the brief asked this roadmap to weigh explicitly.

| Rank | Retailer | Engineering effort | Long-term maintainability | User impact | Verdict |
|---|---|---|---|---|---|
| 1 | **Harris Teeter** | Done — ~1 day, entirely config + reuse | Excellent (identical to Kroger's own) | Real new East Coast coverage with genuine live pricing | **Shipped this phase** |
| 2 | Kroger's other banners (Ralphs, Fred Meyer, King Soopers, Smith's, QFC, ...) | Low *per banner* — same `KrogerBanner` config pattern, pending live confirmation of each `chain` code | Excellent (same official API) | High *if* ShopSmart expands toward Midwest/West markets; zero impact otherwise | **Worth a follow-up audit when geography warrants it** |
| 3 | Safeway/Vons/Jewel-Osco/Tom Thumb/Randalls — locations only | Low (direct reuse of `albertsonsLocator.ts`'s pattern) | Good (same Yext-sitemap shape already proven for Albertsons/Trader Joe's) | **Low** — a locations-only store repeats Albertsons' "unavailable" experience without adding shopping value | **Deliberately deprioritized despite low cost** |
| 4 | Meijer | N/A — blocked | N/A | N/A | **Not Recommended** (Akamai hard block, verified live) |
| 5 | H-E-B | N/A — blocked | N/A | N/A | **Not Recommended** (Imperva Incapsula challenge, verified live; also regionally narrow) |
| 6 | Hy-Vee | N/A — blocked | N/A | N/A | **Not Recommended** (Cloudflare challenge, verified live) |
| 7 | Food Lion / Giant / Stop & Shop | N/A — blocked | N/A | N/A | **Not Recommended** (explicit AI-crawler-disallowing policy, verified live) |
| 8 | Walmart / Target / Costco / Sam's Club / Whole Foods / Publix / Wegmans | N/A — blocked (Phase 1 findings, unchanged) | N/A | N/A | **Not Recommended** |

**How to read this table:** effort and maintainability are only meaningful where a path exists at
all — ranks 4 through 8 aren't "high effort," they're "no viable path found," which the brief
asked to be distinguished clearly from "possible but expensive." Rank 3 is the table's one
deliberate inversion: it's *cheap*, but ranked below a currently-unstarted, higher-effort item
(rank 2) because cost was never the bottleneck for it — value was.
