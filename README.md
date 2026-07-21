# ShopSmart Mobile (React Native / Expo)

A React Native counterpart to `shopsmart_web` — same business logic, same
branding, native mobile UX, but with its own independent backend (`backend/`)
rather than depending on `shopsmart_web` being up. (This replaces an earlier
Flutter build of the same app in this same directory.)

## Running it

### 1. Start this app's own backend first

This app has no search logic of its own beyond the UI — every search hits
`backend/`'s `/api/search` route (an Express server that lives in this repo,
ported from `shopsmart_web`'s route of the same name), so nothing will work
until that's running.

```bash
cd backend
npm install

# One-time: fill in store credentials so the live stores actually return
# data.
cp .env.example .env
# Edit .env — it has the keys the route reads (KROGER_CLIENT_ID/SECRET,
# ALDI_DEFAULT_SHOP_ID/ZONE_ID/POSTAL_CODE); any left blank will just make
# that one store report an error in the app, the rest still work.

npm run dev
```

This starts the API server at `http://localhost:3001`. Leave it running in
its own terminal.

### 2. Start the mobile app

```bash
cd ../  # back to shopsmart_mobile root, if you're still in backend/
npm install

# iOS Simulator / Expo web: localhost works directly.
npx expo start --ios

# Android emulator (10.0.2.2 is the emulator's alias for host loopback):
EXPO_PUBLIC_API_BASE_URL=http://10.0.2.2:3001 npx expo start --android

# Physical device on the same Wi-Fi network — use your machine's LAN IP:
EXPO_PUBLIC_API_BASE_URL=http://192.168.1.23:3001 npx expo start
```

If you omit `EXPO_PUBLIC_API_BASE_URL`, it defaults to `http://localhost:3001`,
which only works for the iOS Simulator or Expo web, not an Android emulator or
a physical device. This is the one unavoidable adaptation — a mobile app has
no "same origin" for a relative `/api/search` call to resolve against.

```bash
npm run typecheck   # tsc --noEmit, 0 errors
npm run lint         # eslint, 0 issues
```

`shopsmart_web` is not involved in any of the above — this app's `backend/`
is a standalone Express + TypeScript server with its own `package.json`,
runnable independently of the Next.js web app.

## Architecture

```
backend/          Standalone Express + TypeScript API server (own package.json)
  src/
    index.ts        App entrypoint — CORS, JSON body parsing, listens on PORT (3001)
    routes/          POST /api/search — relevance scoring, food filtering, store fan-out
    services/        Live store integrations: Trader Joe's, Sprouts, Kroger, Aldi
    utils/           textFormat, ttlCache, withTimeout, groceryFallbackImage
    types/           ApiProduct, SearchResponse, StoreStatus, etc.

src/
  models/         TypeScript types mirroring backend/src/types/index.ts
  services/       apiClient — the only thing that talks to the network
  repositories/   Thin wrappers: searchRepository, authRepository, cartRepository, userRepository
  store/          Zustand stores: searchStore, cartStore, userStore
  navigation/     React Navigation: bottom tabs + native stack
  screens/        One file per screen/route
  components/     Reusable UI pieces (ProductCard, ScannerTray, etc.)
  theme/          Colors and per-store accent map
```

State management is **Zustand**, chosen over Redux Toolkit for this app's
size — the state shape is simple enough (search state, cart, user) that
Redux's action/reducer/slice ceremony wouldn't buy anything, while Zustand
still gives clean separation between state and the functions that mutate it
(the same shape as the Riverpod `StateNotifier`s in the earlier Flutter
build).

**All search/ranking/filtering business logic lives server-side**, in this
app's own `backend/`'s `/api/search` route — ported line-for-line from
`shopsmart_web`'s route of the same name, but running as an independent
Express server rather than depending on the Next.js dev server being up.
This app doesn't re-implement relevance scoring, food filtering, or store
fan-out on the client; it calls its own endpoint and renders the response.
The only client-side "business logic" here is what the web app itself does
client-side: the fake local-account auth (`authRepository`, mirroring
`AuthModal.tsx`'s AsyncStorage/localStorage-backed accounts map), the cart
math (`cartStore`), and the trip-time estimate formula (`CartScreen`, copied
from `CartDrawer.tsx` verbatim), plus the per-unit price and sale-countdown
math in `ProductDetailScreen` (copied from `ProductModal.tsx` verbatim).

## Web page → Mobile screen mapping

| Web (`shopsmart_web/src/...`) | Mobile (`shopsmart_mobile/src/screens/...`) | Adaptation |
|---|---|---|
| `app/page.tsx` (hero + results) | `SearchScreen.tsx` | Single scrolling page, same as web |
| `components/ProductCard.tsx` | `components/ProductCard.tsx` | Hover→tap; otherwise 1:1 |
| `components/ProductModal.tsx` | `ProductDetailScreen.tsx` | Modal overlay → full-screen push (explicit close button + back gesture, not a bottom sheet, given how much content is in it) |
| `components/CartDrawer.tsx` | `CartScreen.tsx` | Slide-over drawer → persistent bottom-nav tab |
| `components/ProfileTray.tsx` | `ProfileScreen.tsx` | Slide-over tray → persistent bottom-nav tab; added a "sign in" prompt state since the web only renders this when a user exists |
| `components/AuthModal.tsx` | `AuthScreen.tsx` | Center dialog → full-screen modal route (keyboard handling) |
| `StoreFilterRail` (in `page.tsx`) | `components/StoreFilterChips.tsx` | Desktop sidebar → horizontal filter-chip row |
| `ScannerTray` (in `page.tsx`) | `components/ScannerTray.tsx` | Same animated per-store status, 2-column grid instead of 5 |
| n/a | `navigation/AppNavigator.tsx` | New: bottom tab navigator (Search/Cart/Profile) + native stack for detail/auth |

## Packages used

`zustand` (state), `@react-navigation/*` + `react-native-screens` +
`react-native-safe-area-context` (navigation), `@react-native-async-storage/async-storage`
(local persistence — the mobile equivalent of `localStorage`), `expo-image`
(product image loading/caching), `@expo/vector-icons` (icons, bundled with
every Expo project).

## Features implemented

Product search, live multi-store price comparison (Trader Joe's, Sprouts,
Kroger, Aldi), store filtering, product detail with related products, cart
(add/update/remove/persist, trip-time estimate, per-store subtotal), sign
in/sign up/sign out (localStorage-equivalent fake auth, matched exactly,
including the web's quirk where search history doesn't survive a sign-out/
sign-in cycle — deliberately not "fixed" here), profile (account info, cart
summary, search history), pull-to-refresh, image caching with fallback icons,
loading/error states matching the web app's copy and logic.

## Adapted for mobile (not literal ports)

- Navigation: bottom tabs instead of always-visible header icons + slide-overs
- Product detail: full-screen page instead of a centered modal
- Store filter: horizontal chip row instead of a fixed sidebar
- Grocery fallback images: native vector icons (Ionicons) instead of embedded
  SVG data URIs — same keyword-matching logic, verified against the actual
  installed icon glyphmap rather than guessed names

## Verified

- `tsc --noEmit`: 0 errors (strict mode)
- `eslint .` (eslint-config-expo): 0 issues
- Real end-to-end run against a live dev server (`npx expo start --web`,
  driven with Playwright — at the time against `shopsmart_web`'s `/api/search`,
  before this app's own `backend/` existed; the route logic is unchanged
  since the port): search for "eggs" returned 27 real products across all 4
  stores with correct prices/images/ratings; verified the scanning animation,
  product detail screen (including the ported per-unit price calculation —
  "12 ct • $0.12 / ct"), cart empty state, and profile signed-out state all
  render correctly.
- Not run on a physical simulator/device (none was available in this
  environment) — the web-preview test above exercises the same React code
  paths as the native build, but a real on-device smoke test is worth doing
  before shipping.

## Known limitations

- **`EXPO_PUBLIC_API_BASE_URL` must be set explicitly** for Android
  emulator/physical devices — see above. Inherent to mobile not having a
  browser-style "same origin."
- When testing via `expo start --web` specifically (not the real native app),
  you may hit CORS/dev-server-origin-check errors that a real native HTTP
  client never encounters — these are artifacts of that one testing method,
  not the app.
- No push notifications, deep linking, or offline mode — none of these exist
  in the web app either, so there was nothing to port.
