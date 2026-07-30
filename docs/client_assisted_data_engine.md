# Client-Assisted Data Engine — Design Document

## 0. How this builds on what already exists

This is not a greenfield design. CartIQ's backend already has three of the
four layers the brief asks for, in different states of maturity:

| Layer in the brief | Already exists as |
| --- | --- |
| Official API Adapters | `krogerLiveScraper.ts` + `locators/krogerLocator.ts` (Kroger, Harris Teeter) |
| Server Scraper Adapters | `services/browser/` — Playwright-based, JSON-network-capture extraction, `StoreDiscoveryRunner`/`StoreCompatibilityTester` |
| Client-Assisted Data Adapters | **does not exist yet** — this doc's main new contribution |
| User-Contributed Data (OCR) | **does not exist yet** |

`docs/store_api_audit.md` (already in this repo) independently arrived at
the same conclusion this doc reaches: introduce a `StoreAdapter` interface
and stop hand-wiring six store names through `searchService.ts`. Everything
below treats that as a design decision already made, not a new proposal —
it just finishes the job by making the interface open enough to also cover
client-assisted and OCR sources, not only server-side API/scraper sources.

Where the existing code already solves a piece of the brief, this doc cites
the exact file and extends it. Where nothing exists yet (client-side WebView
interception, receipt OCR, cross-source trust scoring, canonical product
matching, targeted refresh), it's designed fresh but grounded in this
codebase's existing conventions (deterministic-hash IDs, `TtlCache`,
`WarmupTask`, the closed `ApiProduct.store` union that has to be opened up).

---

## 1. Store-Agnostic Client-Assisted Data Collection

### 1.1 The extraction priority ladder

The existing `services/browser/ProductExtractor.ts` already made the right
call: **no DOM selectors as the primary strategy.** Every store-facing
extractor — server-side Playwright or client-side WebView — should use the
same priority order, falling through only when a higher tier is unavailable:

1. **Network/API interception** — intercept `fetch`/`XHR` responses that are
   already JSON (this is what `NetworkCapture.ts` does server-side; §3
   below designs the client-side equivalent). Most storefronts, even
   server-rendered ones, load prices via an internal JSON API for
   client-side interactivity (quantity steppers, "add to cart" without a
   page reload, store-switcher). This is the highest-signal, lowest-effort
   tier and where `findProductCandidates`'s alias-table approach already
   works store-agnostically.
2. **Structured JSON already embedded in the page** — `__NEXT_DATA__`
   (Next.js), `window.__INITIAL_STATE__` / `__APOLLO_STATE__` (Redux/Apollo
   SSR hydration), `<script type="application/json">` blocks. Same
   extraction pipeline as tier 1 (`findProductCandidates` doesn't care
   whether the JSON came from a network response or a `<script>` tag —
   it just needs the JSON value and a `sourceUrl` for provenance).
3. **schema.org / JSON-LD** — `<script type="application/ld+json">` with
   `@type: "Product"` or `"Offer"`. This is a *worse* signal than tiers 1-2
   in practice: JSON-LD is written for SEO/rich-snippets, so it's often
   stale relative to the live price (updated on deploy, not on price
   change) and frequently omits store-specific fields like aisle/pickup
   availability. Treat it as a fallback enrichment source (fill in `brand`,
   `upc`, canonical `name` when a network capture found `price` but not
   those), not a primary price source.
4. **DOM selectors** — last resort, used today only as the *optional*
   override fields in `StoreOnboardingConfig` (`searchInputSelector`,
   `locationSelector`) to get a search query submitted, never to read a
   price. This should stay true for any new adapter type: DOM selectors
   are allowed for *interacting* with a page (typing into a search box,
   clicking a location-picker), never for *reading* a price, because
   selectors rot on every front-end deploy and give no provenance/audit
   trail the way a captured JSON blob does.

### 1.2 Common patterns across ecommerce sites

This is why tiers 1-3 generalize across "any store," per the audit already
done in `docs/store_api_audit.md`:

- **Persisted-query GraphQL** (Aldi, Sprouts — both on Instacart's
  platform) — same request shape, different `sha256Hash`/`operationName`
  per client version. A `BrowserStoreConfig` for these needs zero extra
  code once the generic network-capture layer is running; the persisted
  query hash is captured automatically as part of tier-1 interception, no
  reverse-engineering required up front.
- **First-party storefront GraphQL** (Trader Joe's — Magento) — same
  pattern, different schema; still tier 1.
- **Documented REST platform APIs** (Kroger/Harris Teeter) — skip the
  browser entirely; this is what makes an "Official API Adapter" strictly
  better than a browser adapter when one exists (no browser process, no
  session cookies to keep warm, real SLAs).
- **Server-rendered pages with a JSON hydration blob** — common on
  Next.js/Nuxt storefronts; tier 2.
- **Mobile web (`m.retailer.com`) vs. desktop** — often *lighter* on
  anti-bot defenses and JS complexity than the desktop site, because it's
  optimized for weak connections. Worth trying as a fallback target when a
  desktop-site `BrowserStoreConfig` is blocked, before giving up on a
  store. Not yet implemented; flagged as a cheap win for §8 Phase 2.
- **Retailer WebViews already embedded in *other* apps** — out of scope.
  This design only ever runs inside a WebView CartIQ itself renders
  (its own in-app browser), never inside a third-party host app's WebView.

### 1.3 Isolating store-specific logic

`StoreOnboardingConfig` already isolates the *only* things that are
genuinely store-specific — homepage URL, and selector overrides for the two
interactions (search, set-location) that can't be inferred generically.
Everything downstream (`findProductCandidates`, `normalizeCandidate`,
`rankProducts`) is one shared pipeline, store-agnostic by construction. The
Client-Assisted Adapter (§3) reuses this exact split: a per-store config
supplies only `homepage`/selectors/`buildSearchUrl`; the injected
interception script and the normalization pipeline are shared code shipped
once in the app bundle, not duplicated per store.

---

## 2. Universal Store Adapter Model

### 2.1 `StoreAdapter` — one contract, four implementations

Extending the interface `docs/store_api_audit.md` §5 already proposed, with
`sourceType`/`capabilities` made explicit so the backend can reason about
*which* adapter to call for a given need without inspecting *how* it works:

```ts
export type SourceType = 'official_api' | 'server_scraper' | 'client_assisted' | 'user_contributed';

export interface StoreCapabilities {
  pricing: boolean;
  promotions: boolean;
  images: boolean;
  inventory: boolean;      // real-time stock, not just "available"
  categories: boolean;
  locations: boolean;
}

export interface StoreAdapter {
  storeId: string;                 // stable, e.g. 'kroger', 'harris-teeter', 'walmart'
  displayName: string;
  sourceType: SourceType;
  capabilities: StoreCapabilities;

  identifyStore(input: { hostname?: string; homepage?: string }): boolean;
  resolveLocation(zipcode: string, preciseCoords?: Coordinates): Promise<StoreLocation | undefined>;
  searchProducts(query: string, location: StoreLocation, opts?: { timeoutMs?: number }): Promise<RawProductObservation[]>;

  // Cheap presence check used by the learning system (§4) and the trust
  // model (§6) — not a full search, just "is this adapter usable right now."
  healthCheck?(): Promise<{ ok: boolean; latencyMs?: number; reason?: string }>;
  warm?(zipcode?: string): Promise<void>;   // reuses the existing WarmupTask shape
}
```

`searchService.ts` becomes a loop over `STORE_ADAPTERS: StoreAdapter[]`
instead of six hand-written `Promise.allSettled` branches — this is
literally the refactor `docs/store_api_audit.md` already recommended;
`RawProductObservation` (below) is the piece that lets it also loop over
client-assisted and OCR sources without special-casing them.

### 2.2 `RawProductObservation` — unifying three existing near-misses

The codebase already has **three overlapping vocabularies** for "a product
seen somewhere": `ApiProduct` (production, closed `store` union),
`BrowserProduct` (experimental browser framework, open `store: string`),
and `ProductCandidate` (the pre-normalization evidence trail, already
carrying `confidence` and `sourceUrl`). `RawProductObservation` replaces all
three as the one shape every adapter — regardless of `sourceType` — must
produce:

```ts
export interface RawProductObservation {
  observationId: string;           // uuid, generated at capture time
  storeId: string;                 // open reference, not a closed union — see §2.3
  storeLocationId?: string;        // FK into store_locations; absent for online-only price
  externalProductId?: string;      // the store's own SKU/id when one was found
  productName: string;
  brand?: string;
  size?: string;                   // raw string as seen, e.g. "1 Gallon", "128 fl oz"
  price: number;
  salePrice?: number;
  currency: string;                // default 'USD', not hardcoded — some regions differ
  availability?: 'in_stock' | 'out_of_stock' | 'limited' | 'unknown';
  promotions?: string[];
  imageUrl?: string;
  categoryHint?: string;
  upc?: string;
  timestamp: string;               // ISO 8601, capture time not server-receipt time
  sourceType: SourceType;
  sourceUrl?: string;               // provenance: which network response/page produced this
  rawPayload?: Record<string, unknown>; // the original JSON, kept for re-normalization later
  confidence: number;              // 0-1, set by the adapter's own extraction confidence (§6 adds a second, source-level score on top)
}
```

This is a strict superset of `ProductCandidate`+`BrowserProduct` — nothing
in the browser framework needs to change shape, only its output type name.
`normalizeCandidate` becomes `normalizeCandidate(...): RawProductObservation`.

### 2.3 The closed `store` union has to be opened

`ApiProduct.store: "Trader Joe's" | 'Sprouts' | 'Kroger' | 'Aldi' |
'Albertsons' | 'Harris Teeter'` cannot survive contact with "any store." This
is a real, unavoidable migration, not a cosmetic one — it's referenced by
name in `theme/colors.ts` (`storeAccents`), `models/types.ts` (`STORE_NAMES`,
`UNAVAILABLE_STORES`), and the mobile `StoreLogo` component's lookup map.
The fix: a `stores` table (§9) becomes the source of truth; `ApiProduct`
(and the mobile app's `StoreName` type) becomes `storeId: string` with a
denormalized `storeName`/`storeAccentColor`/`storeLogoUrl` resolved via join
or a client-side cache of the `stores` table, not a hardcoded literal union.
This is called out explicitly in §8 Phase 1 as the one piece of required
groundwork before anything else in this doc can ship, because every other
section assumes an open store identifier.

---

## 3. Client-Assisted Collection Architecture

### 3.1 In-app WebView interception — the realistic core of this design

CartIQ already ships `react-native-webview` (`package.json`) and already
has a working WebView + JS bridge in production: `src/components/RouteMap.tsx`
renders MapLibre GL JS inside a `WebView`, injects JS via
`injectJavaScript`, and receives structured messages back via
`window.ReactNativeWebView.postMessage(JSON.stringify(...))` →
`onMessage`/`WebViewMessageEvent`. The client-assisted adapter is the same
bridge pattern, pointed at a retailer's site instead of a map renderer:

```
Mobile app requests a client-assisted refresh for store X, query Q, zip Z
        |
        v
Render a WebView (visible or off-screen — see 3.1.3) → config.buildSearchUrl(Q, Z)
        |
        v
injectedJavaScript runs on page load:
  - monkey-patch window.fetch and XMLHttpRollScript.prototype.send
  - for every response with a JSON content-type, stash {url, method, json}
  - flush the buffer to window.ReactNativeWebView.postMessage(...) on an interval
        |
        v
onMessage in React Native → same findProductCandidates/normalizeCandidate/
rankProducts pipeline already used server-side → RawProductObservation[]
with sourceType: 'client_assisted'
        |
        v
POST /api/observations to the backend (batch, not per-item)
```

**3.1.1 Why this is the realistic core, not a nice-to-have.** Server-side
Playwright adapters are blocked by anti-bot systems precisely because they
run from a small set of datacenter IPs with no real user behavior around
them (`docs/store_api_audit.md`'s Walmart/Target/Meijer/H-E-B/Hy-Vee
blockers are all in this category). A request made from inside a real
user's phone, on their real residential/cellular IP, from the retailer's
own website rendered in a real WebView with a real touch-driven navigation
history, is indistinguishable from that user just... using the retailer's
website. This is the entire value proposition of "client-assisted" over
"more server scraping" — it's not a cheaper version of the same thing, it's
a different trust posture entirely.

**3.1.2 The injected script — concrete shape.**

```js
// Injected once per WebView load. Deliberately does NOT touch the DOM —
// it only wraps fetch/XHR, matching the "no DOM selectors for reading
// data" principle from §1.
(function () {
  const buffer = [];
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('json')) {
        const clone = res.clone();
        clone.json().then((json) => {
          buffer.push({ url: args[0], method: 'fetch', json });
        }).catch(() => {});
      }
    } catch (e) {}
    return res;
  };

  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    const origOpen = xhr.open;
    xhr.open = function (method, url) {
      this._url = url; this._method = method;
      return origOpen.apply(this, arguments);
    };
    xhr.addEventListener('load', function () {
      const ct = xhr.getResponseHeader('content-type') || '';
      if (ct.includes('json')) {
        try { buffer.push({ url: xhr._url, method: xhr._method, json: JSON.parse(xhr.responseText) }); }
        catch (e) {}
      }
    });
    return xhr;
  }
  window.XMLHttpRequest = PatchedXHR;

  setInterval(() => {
    if (buffer.length && window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(buffer.splice(0, buffer.length)));
    }
  }, 1500);
  true; // required trailing statement for injectedJavaScript
})();
```

This is the exact `NetworkCapture.ts` filter logic (JSON content-type,
buffered, size-bounded) reimplemented in the page's own JS context instead
of Playwright's Node-side event listener — same contract, different host.

**3.1.3 Visible vs. background WebView.** iOS and Android both suspend or
heavily throttle JS execution in a WebView that isn't currently on screen
(and RN's WebView unmounts/reloads unpredictably when backgrounded). Two
honest options, no third way:

- **Foreground, user-visible, user-initiated**: the shopper taps "Refresh
  prices at [store]," a WebView opens (can be a thin, branded wrapper —
  "Checking Kroger for the latest price…" — rather than a bare unstyled
  browser), interception runs while it's genuinely on screen, then it
  closes automatically once the search response is captured or a ~10s
  timeout elapses. This is the only mode that's reliable *and* honest with
  the user about what's happening.
- **Foreground, invisible (0×0 or off-screen WebView)**: technically
  possible and the WebView still runs at full speed since it's still
  "foreground" from the OS's perspective (attached to a mounted, active
  view hierarchy) — but this collects data from a site the user never
  chose to visit, without them seeing it happen. Flagged as a **hard no**
  in §14 (App Store/Play Store policy risk + basic user-trust reasons), not
  a build choice — do not implement this mode.

**3.1.4 Interaction, not just page-load.** Some stores need a search query
typed and submitted before the product JSON responses fire — the same
`performSearch` heuristic (generic selector list, real per-character
keystrokes, not `.fill()`) that already exists in `BrowserAdapter.ts` gets
reimplemented as injected JS using `document.querySelector` +
dispatched `input`/`keydown` events. This is the one place DOM interaction
is legitimate per §1's ladder — driving navigation, never reading a price
off an element.

### 3.2 Native mobile requests (plain `fetch` from the app, no WebView)

**Feasibility**: works for stores with a genuinely public, CORS-open JSON
API reachable without a browser-set session/cookie (rare — most retailer
site-APIs require a session cookie set during page load, which a bare
`fetch` from the app can't obtain without first rendering the page). Where
it *is* feasible, it's strictly better than a WebView (no JS engine
overhead, no visible UI) — but it's really just "the Official API Adapter
pattern, discovered instead of documented." Treat any store where this
works as a candidate for promotion straight to `sourceType: 'official_api'`
(even if unofficial/undocumented, à la Aldi/Sprouts today), not as its own
category.

**Limitations**: (1) TLS/HTTP fingerprinting — some anti-bot layers key off
the exact TLS handshake and header ordering a real browser produces, which
a bare `fetch`/`XMLHttpRequest` from RN's networking stack won't reproduce,
so a store that blocks server-side scraping for this reason will often
also block this even from a real device. (2) No session bootstrap — cookies
and CSRF tokens the site's own JS would normally set are absent. (3) Same
background-execution restrictions as §3.3 if attempted opportunistically
outside an active user session.

### 3.3 Background execution — why this cannot be a background scraping app

iOS `BGTaskScheduler`/`BGAppRefreshTask` and Android `WorkManager` both give
the OS wide latitude to skip, delay, or throttle background work based on
battery, network, and how often the user actually opens the app — there is
no reliable "run this network request every N minutes in the background"
primitive on either platform, and both platforms actively fight patterns
that look like continuous background data collection (battery health
scoring on iOS, Doze/App Standby buckets on Android). Design consequence:
**every client-assisted collection event must be tied to the user actively
having the app open**, triggered either explicitly (§3.1.3's "Refresh
prices" tap) or implicitly (the user is already searching, so a
client-assisted refresh for their query/zip piggybacks on that session).
Anything that tries to run unattended in the background will be
unreliable at best and get the app flagged at worst (§14).

### 3.4 Alternatives evaluated

| Approach | Realistic for production? | Why |
| --- | --- | --- |
| **In-app WebView interception** (§3.1) | **Yes — primary mechanism** | Real device, real IP, real user session; only viable path to stores that block server scraping |
| **Server-assisted browser sessions** | **Yes — already built** (`services/browser/`) | Correct default for stores that *don't* actively block it; cheaper to operate (no client battery/data cost), centrally maintainable |
| **Receipt OCR / user-contributed** | **Yes — secondary, high-trust, low-volume** | See §3.4.1 |
| **User-triggered refresh** | **Yes — this is the trigger model for §3.1, not a separate mechanism** | Already folded into 3.1.3 |
| **Native mobile requests** | **Conditional** — case by case | See §3.2; not a general solution |
| **Edge workers** (Cloudflare Workers etc. as an egress point) | **No, for price-scraping itself** | Solves geographic IP diversity, doesn't solve "this traffic pattern looks like a bot" — the anti-bot systems in `docs/store_api_audit.md` key on behavior/session realism, not IP reputation alone. Legitimate use elsewhere in this system: as the ingestion endpoint that receives client-assisted batches close to the user (§9's `POST /api/observations`), not as a scraper itself. |
| **Background execution (unattended)** | **No** | §3.3 |

**3.4.1 Receipt OCR.** Highest-trust source in the whole system — a receipt
is proof of an actual transaction, not an inferred shelf price — but lowest
volume/coverage (only covers what the user already bought, after the fact,
so it can never answer "what's milk cost right now" for a store the user
hasn't shopped at recently) and highest per-item friction (photo → OCR →
line-item parsing → matching each line to a canonical product). Design as
a **trust-boosting corroboration source**, not a primary discovery
mechanism: when a receipt-derived observation and a client-assisted/scraper
observation for the same product+store+week disagree, the receipt wins
(§6). Concretely: `expo-camera` capture → on-device or backend OCR (Google
ML Kit / AWS Textract-style receipt parser) → line items → the same
canonical-matching pipeline as §7 → `RawProductObservation[]` with
`sourceType: 'user_contributed'`.

---

## 4. Store Learning System

### 4.1 What already exists, precisely

`StoreDiscoveryRunner.discoverStore()` and `StoreCompatibilityTester.
testStoreCompatibility()` already do real, fully automatic (no human writes
a schema) work: load the homepage, detect challenge/login walls by literal
phrase-matching page text (`'just a moment'`, `'verify you are human'`,
etc. — vendor-agnostic), attempt a search, run the exact same
`findProductCandidates → normalizeCandidate → rankProducts` pipeline every
other adapter uses, and produce a `CompatibilityReport` with a 0-1
confidence score. **What they do not do**: persist anything. Running
`discoverStore()` twice for the same store does the same work twice; there
is no learned artifact left behind — the audit doc names this explicitly
as deliberate future work, not an oversight.

### 4.2 Answering the question directly: manual vs. config vs. AI vs. hybrid

**Hybrid — and the system described above is already most of the way
there.** Break it into the three things that actually need deciding
separately, because they have different right answers:

1. **"Can we extract from this store's JSON at all?"** — fully automatic
   today (`findProductCandidates`'s generic alias table), stays automatic.
   No human and no AI model needs to look at this per store.
2. **"Is this store's site reachable/searchable without a human-written
   selector override?"** — automatic *most* of the time (generic search-box
   heuristics), config-driven for the exceptions (`searchInputSelector`/
   `locationSelector` in `StoreOnboardingConfig`). This should stay
   config-driven, not AI-driven — it's a small, stable, easily-verified
   input (one CSS selector), and getting it wrong fails loudly (search
   never submits) rather than silently returning wrong prices.
3. **"Given a captured JSON sample that has clear price-like data but the
   generic aliases missed a field (e.g. this store nested availability
   under a name the alias table doesn't know), what should the new alias
   be?"** — **this is the one place AI-assisted schema discovery earns its
   keep.** Feed an LLM one real captured JSON object (already anonymized —
   it's a product listing, not PII) plus the current `FIELD_ALIASES` table
   and ask it to propose additional key names per `CanonicalField`. The
   output is *only* a suggested alias list, never executed code and never
   auto-applied — it goes through the exact same `StoreCompatibilityTester`
   re-run as a human-proposed change would, and only gets merged into
   `FIELD_ALIASES` if compatibility score improves. This bounds the blast
   radius of an LLM being wrong to "this store's extraction doesn't improve
   this run," never to "the extraction pipeline breaks for every store,"
   because the alias table is global but additive-only and every change is
   gated by the same regression check (`STORE_VALIDATION_CONTROLS` — the
   Sprouts/Trader Joe's/Aldi sanity-check stores already in
   `discoveryCandidates.ts` — must not regress).

### 4.3 The missing piece: a persisted, versioned learned profile

```
Unknown Store Website
        |
        v
Detection Layer (StoreDiscoveryRunner — already built)
        |
        v
Extract candidate schema (ProductExtractor — already built, generic)
        |
        v
[NEW] Persist a StoreLearningProfile row:
  { storeId, discoveredAt, fieldMappingOverrides, compatibilityScore,
    lastValidatedAt, status: 'candidate'|'promoted'|'retired' }
        |
        v
[NEW] Scheduled re-validation (weekly StoreCompatibilityTester re-run per
  'candidate'/'promoted' store) — catches schema rot automatically instead
  of silently degrading, directly addressing the "undocumented-schema
  rotation" risk the audit doc already flags
        |
        v
Human review gate before 'candidate' → 'promoted' (adds the store to
STORE_ADAPTERS / opens it up in the storeId registry from §2.3) — kept
manual deliberately: promoting a store is a legal/ToS judgment call
(see the Food Lion/Giant/Stop & Shop "disallows AI crawlers by name" case
in the audit doc), not a purely technical one, and should never be fully
automated.
```

---

## 5. Product Normalization Layer

### 5.1 Pipeline

```
RawProductObservation (per store, per source)
        |
        v
Attribute Extraction — parse size/unit out of free-text `size`/`productName`
  ("1 Gallon" -> {value:1, unit:'gallon'}; "128 fl oz" -> {value:128, unit:'fl_oz'})
  and detect variant flags (organic, gluten-free, family-size) from name tokens
        |
        v
Canonical Product Matching — resolve to a `canonical_product_id`, or create one
        |
        v
Price Comparison — group all observations sharing a canonical_product_id,
  normalize to a common unit (price per fl oz / per oz / per count) before comparing
```

### 5.2 Canonical matching, concretely

Extend what already exists in `searchService.ts` — `tokenizeName`,
`isSameProductName`, `hasDifferentHeadNoun`, `computeRelevance` — rather
than building a second matching engine. The existing logic already
distinguishes "same head noun, different brand" (comparable) from
"different head noun" (not comparable, e.g. "milk" vs. "milk chocolate")
via `hasDifferentHeadNoun`. Canonical matching needs three more signals on
top:

1. **Brand-normalized head noun** — strip the brand token before comparing
   ("Great Value" / "Organic Valley" are brand tokens, "milk" is the head
   noun that has to match).
2. **Variant flags as a match key, not noise** — `organic`, `gluten-free`,
   `2%`/`whole`/`skim`/`lactose-free`, `family-size`/`single`. Two products
   with the same head noun but different variant-flag sets are
   **comparable but not identical** — surface both as "similar, not
   exact" in the UI, don't silently merge them.
3. **Unit-normalized price** — convert every `RawProductObservation.size`
   into a common base unit for its category (liquids → price/fl oz,
   solids → price/oz, countables → price/count) so "1 Gallon" (128 fl oz)
   and "128 fl oz" compare on equal footing even though the raw size
   strings differ.

Worked example, matching the brief's own case:

```
"Great Value Organic Whole Milk 1 Gallon"      → head noun: milk
  brand: Great Value | variants: {organic, whole} | size: 128 fl oz | $3.48
  → $0.0272/fl oz

"Organic Valley Whole Milk 128 fl oz"          → head noun: milk
  brand: Organic Valley | variants: {organic, whole} | size: 128 fl oz | $6.99
  → $0.0546/fl oz

Same head noun + same variant set + comparable unit price → ONE canonical
product ("Organic Whole Milk, 1 Gallon"), two store listings under it,
price comparison is valid and the size difference note is unnecessary
(they're literally the same size, just described differently).
```

Contrast case the matcher must *not* merge:

```
"Organic Valley Whole Milk 128 fl oz"          → variants: {organic, whole}
"Organic Valley 2% Milk 128 fl oz"             → variants: {organic, '2%'}
```

Same brand, same head noun, same size, **different variant flag** (`whole`
vs. `2%`) → related products, shown side-by-side as "you might also
consider," never collapsed into one canonical product or silently
substituted in a price comparison.

**Regional products / substitutions**: modeled as edges on the canonical
product, not merges — `canonical_product_substitutions(canonical_id,
substitute_canonical_id, confidence, reason)`. A regional product with no
national equivalent simply has no substitution edges and stands alone;
this reuses the same substitution-graph shape the mobile app's existing
`substitutionService.ts` already implies for out-of-stock items, extended
to also apply cross-store rather than only within one store's catalog.

---

## 6. Data Trust and Validation

### 6.1 Confidence scoring — two layers, not one

**Source-type prior** (fixed per `sourceType`, reflects how much a source
type can be trusted *in general*, independent of any specific observation):

| Priority | `sourceType` | Prior weight | Rationale |
| --- | --- | --- | --- |
| 1 | `official_api` | 1.0 | Contractual/documented data; ground truth |
| 2 | `server_scraper` (validated, `StoreLearningProfile.status = 'promoted'`) | 0.85 | Automated, consistent, but undocumented shape can rot silently |
| 3 | `client_assisted`, ≥2 independent observations agreeing | 0.7 | Real user session, but single-report noise averaged out |
| 4 | `client_assisted`, single observation | 0.4 | Real signal, unverified — usable for staleness detection, not as sole price-of-record |
| 4 | `user_contributed` (receipt OCR), single observation | 0.75 | High per-observation trust (proof of purchase) but low coverage, so ranked alongside single client observations for *availability* purposes, above them for *price accuracy* |

**Per-observation confidence** (the `RawProductObservation.confidence`
field from §2.2 — already exists as `ProductCandidate.confidence` today,
set by the extractor based on how many `CanonicalField`s matched and how
directly). Final trust score = `sourceTypePrior * observationConfidence *
recencyDecay(timestamp)`, where `recencyDecay` is a half-life function (§8
ties this directly to the refresh decision).

### 6.2 Anomaly detection

- **Cross-store outlier check**: if a canonical product's price at store X
  is >2.5 standard deviations from the median across all other stores
  currently carrying it, flag for review rather than displaying as-is —
  catches unit-mismatch bugs (per-unit vs. per-package price captured by
  mistake) before they become a visible "this store is 90% cheaper" claim.
- **Price-history comparison**: if a new observation for the same
  `canonical_product_id` + `storeId` is >50% different from the trailing
  7-day median for that exact pair, treat as `unverified` until a second
  observation corroborates it (real sales/promotions do cause big swings,
  so this gates *display confidence*, not acceptance into the database).
- **Duplicate removal**: `dedupSignature` already exists in
  `searchService.ts` for within-store dedup; extend it to a cross-source
  dedup key of `(storeId, storeLocationId, externalProductId ??
  normalizedName, roundedTimestampToHour)` so a client-assisted observation
  and a server-scraper observation for the same real-world price event
  don't double-count as "two independent observations" in the confidence
  math above.

### 6.3 Verification rules

- Never let a single `client_assisted` observation *lower* an existing
  `official_api`/`server_scraper` price — it can only add a "seen more
  recently at $X" freshness signal, surfaced separately, never overwrite
  the primary displayed price until corroborated.
- A canonical product with zero `official_api`/`server_scraper` coverage
  and only conflicting single-observation `client_assisted` reports is
  displayed as a price *range*, not a false-precision single number.

---

## 7. Targeted Refresh Strategy

### 7.1 Decision tree

```
User searches "milk" (query Q, location L)
        |
        v
For each candidate store S carrying Q near L:
  cachedObservation = latest RawProductObservation for (S, canonical(Q), L)
  age = now - cachedObservation.timestamp
  trustScore = sourceTypePrior(cachedObservation) * recencyDecay(age)
        |
        v
  age < freshnessThreshold(S, Q)?  ──yes──> return cached, no refresh
        |no
        v
  is Q a high-popularity query (top-N searched terms this week,
  per-store or global) OR does L have high recent user demand?
        |
        ├─ yes, and an official_api/server_scraper adapter exists for S
        │      → run server refresh now (adapter already fast/cheap/safe)
        │
        ├─ yes, and S only has client_assisted coverage
        │      → the CURRENT search request itself IS the refresh trigger:
        │        if the user is searching inside the app right now, this is
        │        exactly the moment a client-assisted refresh piggybacks on
        │        real user intent (§3.1.3's implicit trigger) — kick one off
        │        for S/Q/L in parallel with returning the cached result, so
        │        this search feels instant and the NEXT search benefits
        │
        └─ no (low-popularity query/location, or nothing else applies)
               → return cached even if stale, but label its age; don't spend
                 a refresh (server or client) on demand that doesn't justify
                 the cost — this is the actual "avoid scraping everything"
                 requirement from the brief
        |
        v
  freshnessThreshold(S, Q) itself scales with sourceTypePrior(S) — an
  official_api store can have a longer threshold (its data doesn't rot)
  than a client_assisted-only store (staler faster, fewer refresh events)
```

`freshnessThreshold` and the "is this demand-worthy" check both plug
directly into the existing `WarmupTask{store, run}` shape from
`warmupService.ts` — a scheduled job that walks today's top-N (query, zip)
pairs and calls `warm()`/`searchProducts()` for the stores that need it is
additive to warmup's existing dedup-by-zipcode `inFlight` map, not a new
scheduler.

### 7.2 Historical estimate fallback

When nothing above returns real data (new store, cold zip, all adapters
failed), fall back to the trailing regional median for that canonical
product across *other* zips/stores rather than showing nothing — labeled
explicitly as an estimate, never presented with the same visual weight as a
real observation.

---

## 8. MVP Roadmap

### Phase 1 — Universal ingestion interface + existing adapters

- Open the `store` union: add a `stores` table (§9), migrate `ApiProduct`
  → `storeId`, update the 6-7 files the audit doc already names as
  duplicating the store list (`searchService.ts` ×2, `warmupService.ts`,
  `types/index.ts`, mobile `models/types.ts`, `theme/colors.ts`,
  `theme/storeLogos.ts`).
- Introduce `StoreAdapter`/`RawProductObservation` (§2); wrap the existing
  Kroger/Harris Teeter adapter and the existing Aldi/Sprouts/Trader Joe's
  adapters in the new interface without changing their internal logic.
- `searchService.ts` becomes a loop over a `STORE_ADAPTERS` registry.
- No new data collection capability yet — this phase is entirely about
  making the existing 6 stores' data flow through the shape everything
  else in this doc assumes.

### Phase 2 — Client-assisted refresh for unknown/stale products

- Build the WebView interception bridge (§3.1) as a reusable
  `<StoreRefreshWebView>` RN component + injected script bundle.
- `POST /api/observations` ingestion endpoint accepting batches of
  `RawProductObservation[]` with `sourceType: 'client_assisted'`.
- Wire the explicit "Refresh prices" user action (§3.1.3) into the
  existing Search/Cart screens.
- Confidence scoring (§6.1) and the freshness decision tree (§7.1) ship
  together — collecting client-assisted data without a trust model to
  gate its display is the one sequencing mistake this phase must avoid.

### Phase 3 — Automated store learning system

- Promote `StoreDiscoveryRunner`/`StoreCompatibilityTester` output into a
  persisted `store_learning_profiles` table (§4.3).
- Scheduled weekly re-validation job for `candidate`/`promoted` stores.
- AI-assisted alias suggestion (§4.2 item 3), gated by the existing
  validation-control stores, human-reviewed before merge.
- Human review gate for `candidate` → `promoted`.

### Phase 4 — Crowdsourced grocery price intelligence network

- Receipt OCR pipeline (§3.4.1) as a first-class `user_contributed` source.
- Multi-user corroboration required before a `client_assisted` observation
  can independently move a displayed price (§6.1's tier-3 "≥2 independent
  observations" threshold becomes enforceable once volume exists).
- Cross-store canonical product graph (§5) matures from "good enough for
  price comparison" to a real substitution/recommendation graph.
- Regional price-intelligence aggregation (§7.2's historical-estimate
  fallback becomes genuinely predictive rather than a stopgap).

---

## 9. Database schema

```sql
CREATE TABLE stores (
  store_id            TEXT PRIMARY KEY,          -- 'kroger', 'harris-teeter', 'walmart', ...
  display_name        TEXT NOT NULL,
  source_type         TEXT NOT NULL,             -- 'official_api'|'server_scraper'|'client_assisted'|'user_contributed'
  capabilities        JSONB NOT NULL,            -- StoreCapabilities
  accent_color_bg      TEXT,
  accent_color_text    TEXT,
  logo_url             TEXT,
  status               TEXT NOT NULL DEFAULT 'active', -- 'active'|'unavailable'|'retired'
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE store_locations (
  store_location_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id            TEXT NOT NULL REFERENCES stores(store_id),
  external_location_id TEXT,
  address              TEXT NOT NULL,
  city                 TEXT NOT NULL,
  state                TEXT NOT NULL,
  zip                  TEXT NOT NULL,
  latitude             DOUBLE PRECISION,
  longitude            DOUBLE PRECISION,
  source               TEXT NOT NULL,            -- provenance, e.g. 'kroger-api'
  metadata             JSONB,
  UNIQUE (store_id, external_location_id)
);

CREATE TABLE canonical_products (
  canonical_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name       TEXT NOT NULL,             -- "Organic Whole Milk, 1 Gallon"
  head_noun            TEXT NOT NULL,
  variant_flags        TEXT[] NOT NULL DEFAULT '{}', -- ['organic','whole']
  base_unit            TEXT NOT NULL,             -- 'fl_oz'|'oz'|'count'
  base_unit_quantity   NUMERIC NOT NULL,
  category             TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE canonical_product_substitutions (
  canonical_id             UUID NOT NULL REFERENCES canonical_products(canonical_id),
  substitute_canonical_id  UUID NOT NULL REFERENCES canonical_products(canonical_id),
  confidence               NUMERIC NOT NULL,
  reason                   TEXT,
  PRIMARY KEY (canonical_id, substitute_canonical_id)
);

CREATE TABLE product_aliases (
  alias_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_id         UUID NOT NULL REFERENCES canonical_products(canonical_id),
  store_id             TEXT NOT NULL REFERENCES stores(store_id),
  external_product_id  TEXT,
  raw_name             TEXT NOT NULL,
  raw_brand            TEXT,
  raw_size             TEXT,
  UNIQUE (store_id, external_product_id)
);

-- The persisted form of RawProductObservation (§2.2)
CREATE TABLE price_observations (
  observation_id       UUID PRIMARY KEY,
  store_id             TEXT NOT NULL REFERENCES stores(store_id),
  store_location_id    UUID REFERENCES store_locations(store_location_id),
  canonical_id         UUID REFERENCES canonical_products(canonical_id), -- null until normalization runs
  external_product_id  TEXT,
  product_name         TEXT NOT NULL,
  brand                TEXT,
  size                 TEXT,
  price                NUMERIC NOT NULL,
  sale_price           NUMERIC,
  currency             TEXT NOT NULL DEFAULT 'USD',
  availability         TEXT,
  promotions           TEXT[],
  image_url            TEXT,
  upc                  TEXT,
  captured_at          TIMESTAMPTZ NOT NULL,
  received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_type          TEXT NOT NULL,
  source_url           TEXT,
  raw_payload          JSONB,
  extraction_confidence NUMERIC NOT NULL,
  trust_score           NUMERIC,                 -- computed at read/aggregation time, cached here
  dedup_signature       TEXT NOT NULL
);
CREATE INDEX ON price_observations (canonical_id, store_id, captured_at DESC);
CREATE INDEX ON price_observations (store_id, store_location_id, captured_at DESC);
CREATE INDEX ON price_observations (dedup_signature);

CREATE TABLE store_learning_profiles (
  store_id              TEXT PRIMARY KEY REFERENCES stores(store_id),
  discovered_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  field_mapping_overrides JSONB,                  -- additive FIELD_ALIASES extensions
  compatibility_score     NUMERIC,
  last_validated_at       TIMESTAMPTZ,
  status                  TEXT NOT NULL DEFAULT 'candidate' -- 'candidate'|'promoted'|'retired'
);

CREATE TABLE refresh_jobs (
  job_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id              TEXT NOT NULL REFERENCES stores(store_id),
  canonical_id          UUID REFERENCES canonical_products(canonical_id),
  zip                   TEXT,
  trigger               TEXT NOT NULL,            -- 'user_search'|'popularity'|'warmup'|'manual'
  requested_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ,
  result                TEXT                      -- 'success'|'failed'|'timeout'
);
```

## 10. TypeScript interfaces (consolidated)

```ts
export type SourceType = 'official_api' | 'server_scraper' | 'client_assisted' | 'user_contributed';

export interface Coordinates { latitude: number; longitude: number }

export interface StoreLocation {
  storeLocationId: string;
  storeId: string;
  externalLocationId?: string;
  address: string; city: string; state: string; zip: string;
  latitude?: number; longitude?: number;
  source: string;
  metadata?: Record<string, unknown>;
}

export interface StoreCapabilities {
  pricing: boolean; promotions: boolean; images: boolean;
  inventory: boolean; categories: boolean; locations: boolean;
}

export interface Store {
  storeId: string; displayName: string; sourceType: SourceType;
  capabilities: StoreCapabilities;
  accentColorBg?: string; accentColorText?: string; logoUrl?: string;
  status: 'active' | 'unavailable' | 'retired';
}

export interface StoreAdapter {
  storeId: string; displayName: string; sourceType: SourceType;
  capabilities: StoreCapabilities;
  identifyStore(input: { hostname?: string; homepage?: string }): boolean;
  resolveLocation(zipcode: string, preciseCoords?: Coordinates): Promise<StoreLocation | undefined>;
  searchProducts(query: string, location: StoreLocation, opts?: { timeoutMs?: number }): Promise<RawProductObservation[]>;
  healthCheck?(): Promise<{ ok: boolean; latencyMs?: number; reason?: string }>;
  warm?(zipcode?: string): Promise<void>;
}

export interface RawProductObservation {
  observationId: string; storeId: string; storeLocationId?: string;
  externalProductId?: string; productName: string; brand?: string; size?: string;
  price: number; salePrice?: number; currency: string;
  availability?: 'in_stock' | 'out_of_stock' | 'limited' | 'unknown';
  promotions?: string[]; imageUrl?: string; categoryHint?: string; upc?: string;
  timestamp: string; sourceType: SourceType; sourceUrl?: string;
  rawPayload?: Record<string, unknown>; confidence: number;
}

export interface CanonicalProduct {
  canonicalId: string; canonicalName: string; headNoun: string;
  variantFlags: string[]; baseUnit: 'fl_oz' | 'oz' | 'count'; baseUnitQuantity: number;
  category?: string;
}

export interface TrustedPricePoint {
  canonicalId: string; storeId: string; storeLocationId?: string;
  price: number; salePrice?: number; trustScore: number;
  observationCount: number; latestObservationAt: string;
  displayPrecision: 'exact' | 'range' | 'estimate';
}

export interface StoreLearningProfile {
  storeId: string; discoveredAt: string;
  fieldMappingOverrides?: Record<string, string[]>;
  compatibilityScore?: number; lastValidatedAt?: string;
  status: 'candidate' | 'promoted' | 'retired';
}

export interface RefreshDecision {
  action: 'return_cached' | 'trigger_client_refresh' | 'trigger_server_refresh' | 'use_historical_estimate';
  reason: string;
}
```

## 11. Backend architecture

```
backend/src/
  types/index.ts                 # RawProductObservation, StoreAdapter, Store, StoreCapabilities (§10)
  services/
    adapters/                    # NEW — one module per official_api/server_scraper adapter,
      krogerAdapter.ts           #   each just wrapping today's krogerLiveScraper.ts etc.
      harrisTeeterAdapter.ts      #   behind the StoreAdapter interface — internals unchanged
      aldiAdapter.ts
      sproutsAdapter.ts
      traderJoesAdapter.ts
      registry.ts                 # STORE_ADAPTERS: StoreAdapter[] — replaces hand-wiring in searchService.ts
    browser/                     # EXISTING, unchanged internals — now one StoreAdapter among many
      BrowserAdapter.ts / NetworkCapture.ts / ProductExtractor.ts / ProductNormalizer.ts / SearchRanker.ts
      stores/StoreRegistry.ts / StoreCompatibilityTester.ts / StoreDiscoveryRunner.ts / storeConfigs/
    ingestion/                   # NEW
      observationsService.ts     # validates + persists RawProductObservation[] batches, computes dedup_signature
      trustScoringService.ts     # §6 — sourceTypePrior * confidence * recencyDecay
      anomalyDetectionService.ts # §6.2
    normalization/               # NEW
      attributeExtractionService.ts  # size/unit/variant-flag parsing (§5.1)
      canonicalMatchingService.ts    # extends searchService.ts's tokenizeName/isSameProductName (§5.2)
    refresh/                     # NEW
      refreshDecisionService.ts  # §7.1 decision tree
      refreshJobRunner.ts        # extends warmupService.ts's WarmupTask/inFlight pattern
    learning/                    # NEW
      storeLearningProfileService.ts # §4.3 persistence + weekly re-validation scheduling
      aliasSuggestionService.ts       # §4.2 item 3, LLM-assisted, human-gated
    searchService.ts             # CHANGED — loops STORE_ADAPTERS instead of 6 hand-written branches
    warmupService.ts             # UNCHANGED shape, reused by refreshJobRunner.ts
  routes/
    observations.ts              # NEW — POST /api/observations (client-assisted + OCR ingestion)
    search.ts                    # UNCHANGED contract, now backed by the adapter registry
```

## 12. React Native components

```
src/
  components/
    refresh/
      StoreRefreshWebView.tsx    # NEW — the §3.1 WebView + injected-script bridge,
                                  #   modeled directly on RouteMap.tsx's existing WebView/
                                  #   onMessage pattern
      injectedInterceptor.js     # NEW — the fetch/XHR monkey-patch script (§3.1.2), bundled
                                  #   as a string constant, shared across every store config
    RefreshPricesButton.tsx      # NEW — the explicit user trigger (§3.1.3)
  hooks/
    useClientAssistedRefresh.ts  # NEW — owns the WebView lifecycle (mount → capture → batch →
                                  #   POST /api/observations → unmount), exposes
                                  #   { status: 'idle'|'refreshing'|'done'|'error', trigger() }
  screens/
    ReceiptScannerScreen.tsx     # NEW, Phase 4 — expo-camera capture → OCR → line-item review →
                                  #   submit as user_contributed observations
  services/
    observationsService.ts      # NEW — client-side POST /api/observations wrapper, batches +
                                  #   retries, mirrors the existing apiClient.ts conventions
```

`StoreRefreshWebView` sketch:

```tsx
export function StoreRefreshWebView({ store, query, zipcode, onObservations, onDone }: {
  store: StoreAdapterConfig; query: string; zipcode: string;
  onObservations: (raw: RawProductObservation[]) => void;
  onDone: () => void;
}) {
  const webViewRef = useRef<WebView>(null);
  const url = store.buildSearchUrl(query, zipcode);

  const handleMessage = (event: WebViewMessageEvent) => {
    const captured: CapturedResponse[] = JSON.parse(event.nativeEvent.data);
    const observations = captured
      .flatMap((c) => findProductCandidates(c.json, c.url))
      .map((candidate) => normalizeCandidate(candidate, store.storeId))
      .filter((o): o is RawProductObservation => o != null);
    if (observations.length) onObservations(observations);
  };

  return (
    <WebView
      ref={webViewRef}
      source={{ uri: url }}
      injectedJavaScript={INTERCEPTOR_SCRIPT}
      onMessage={handleMessage}
      onLoadEnd={() => setTimeout(onDone, 8000)} // hard timeout — never hang the UI on a slow/blocked site
    />
  );
}
```

Note this reuses `findProductCandidates`/`normalizeCandidate` — meaning
those two functions need to become shared, isomorphic code (no Node-only
imports) so they can run both server-side (Playwright) and client-side
(RN WebView's JS engine), not reimplemented twice.

## 13. Implementation risks

| Risk | Detail | Mitigation |
| --- | --- | --- |
| **App Store / Play Store policy** | Automated collection of data from third-party sites via an in-app WebView, especially if invisible/background, risks rejection or removal — both stores have policies against undisclosed data collection and against apps whose primary function is scraping other services. | Foreground-only, user-visible, user-triggered (§3.1.3); disclose clearly in-app and in the privacy policy that "Refresh prices" opens the retailer's own page briefly to check current pricing; never ship the invisible-WebView mode. |
| **Retailer ToS / legal exposure** | Several retailers' `robots.txt` explicitly disallow AI/scraping crawlers by name (already documented for Food Lion/Giant/Stop & Shop). Client-assisted collection from a real user session is a materially different legal posture than server-side scraping, but is not automatically ToS-safe. | Human-gated promotion step (§4.3) treats this as a legal judgment, not purely technical; maintain the same audit-doc-style per-store review before enabling client-assisted collection for a given retailer. |
| **Anti-bot false negatives over time** | A store that works today can start blocking or changing its schema without notice (session/auth changes, undocumented-schema rotation — both already named as risks in `docs/store_api_audit.md`). | Weekly `store_learning_profiles` re-validation (§4.3); trust scoring's `recencyDecay` naturally down-weights a source that's silently gone stale even before anyone notices the breakage. |
| **Data quality / bad canonical merges** | Incorrectly merging two non-equivalent products (e.g. missing a variant flag) silently produces a wrong price comparison, which is worse than no comparison. | Variant-flag-aware matching (§5.2) errs toward "related, not identical" when uncertain; anomaly detection (§6.2) catches the resulting price outliers even if the merge logic itself has a gap. |
| **Client device cost** | WebView-based interception spends the user's battery and mobile data on the app's behalf, for the app's benefit as much as theirs. | Keep sessions short (hard timeout, §12's `onLoadEnd` example), Wi-Fi-preferred by default, and always user-initiated (§3.3) — never opportunistic background collection. |
| **Privacy of injected scripts** | The interceptor script runs inside the retailer's own page context; it must not read cookies, local storage, or any field not related to product/price data, or it risks capturing the user's retailer account session data. | `NetworkCapture`-equivalent filter is response-body-only, JSON-content-type-only, size-bounded (mirrors the existing 5MB cap); never read `document.cookie` or `localStorage` from the injected script. |
| **LLM-assisted alias suggestions going wrong** | An LLM could propose a plausible-looking but wrong field mapping. | Suggestions are additive-only, never auto-applied, always re-validated against the existing `STORE_VALIDATION_CONTROLS` sanity-check stores before merge (§4.2). |
| **Single-vendor lock-in on OCR** | Receipt OCR accuracy varies a lot by receipt format/print quality. | Treat OCR output as low-confidence raw text needing the same canonical-matching gate as any other source, not a trusted structured feed; let low-confidence line items fall back to manual user confirmation before they become `RawProductObservation`s. |
