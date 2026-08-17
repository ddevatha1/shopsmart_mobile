/**
 * The key cart/purchase-history/planner-preference data is scoped under —
 * see cartStore.ts, purchaseHistoryService.ts, and
 * plannerPreferenceService.ts, all of which already take an arbitrary
 * `ownerEmail: string` and already no-op on an empty one (a leftover from
 * when a signed-out shopper's data silently never persisted at all).
 *
 * A single fixed constant, not a per-install random ID: this app has no
 * concept of accounts or multiple simultaneous identities on one device
 * (there is exactly one shopper, the device itself), so there is nothing
 * a random ID would distinguish that this fixed key doesn't already —
 * and it avoids adding an async "generate once, persist, hydrate before
 * first read" dependency to every screen that touches this data (unlike
 * src/services/analytics/deviceId.ts, which genuinely needs randomness to
 * distinguish installs from each other across a shared analytics
 * backend). Deliberately a separate constant from that file for the same
 * reason: this is data-ownership plumbing, not analytics.
 */
export const GUEST_OWNER_KEY = 'shopai-guest';
