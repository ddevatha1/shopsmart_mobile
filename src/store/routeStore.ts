import { create } from 'zustand';
import { routeChecklistRepository } from '../repositories/routeChecklistRepository';
import type { TripChecklist } from '../services/navigationController';

export type NavigationMode = 'overview' | 'navigation';

/**
 * The "RouteStateManager" — owns everything about the *currently active*
 * trip that isn't the routing plan itself (which comes straight from the
 * backend via `services/tripService.ts` and is owned by the Route screen's
 * own load effect): which items have been checked off at each stop,
 * whether the map is following the shopper's live position, and which of
 * the two map modes (Trip Overview / Navigation) is active. RouteScreen
 * and RouteMap only ever read this state and call its actions — no
 * checklist/follow-mode/mode-transition logic lives in either component.
 */
interface RouteState {
  tripSignature: string | null;
  checklist: TripChecklist;
  hydrated: boolean;
  followMode: boolean;
  navigationMode: NavigationMode;

  /** Loads (or resets) checklist state for the given trip signature — call
   * once when a trip's stops are known. A signature already active is a
   * no-op, so re-renders don't re-trigger a storage read. A genuinely new
   * trip always starts back in Overview, never mid-navigation. */
  hydrateForTrip: (tripSignature: string) => Promise<void>;
  toggleItem: (stopKey: string, productId: string) => void;
  setFollowMode: (following: boolean) => void;
  /** Trip Overview → Navigation Mode — pressing "Start Route". Turns
   * follow-mode on so the camera immediately starts tracking. */
  startNavigation: () => void;
  /** Navigation Mode → Trip Overview — back to the full-trip planning view. */
  exitNavigation: () => void;
  /** Clears checklist state entirely — called when the shopper leaves the
   * Route screen with the trip complete, or backs out of it, so a later
   * unrelated trip never inherits stale checked items. */
  clearTrip: () => Promise<void>;
}

export const useRouteStore = create<RouteState>((set, get) => ({
  tripSignature: null,
  checklist: {},
  hydrated: false,
  followMode: true,
  navigationMode: 'overview',

  hydrateForTrip: async (tripSignature) => {
    if (get().tripSignature === tripSignature && get().hydrated) return;
    const checklist = await routeChecklistRepository.load(tripSignature);
    set({ tripSignature, checklist, hydrated: true, followMode: true, navigationMode: 'overview' });
  },

  toggleItem: (stopKey, productId) => {
    const { tripSignature, checklist } = get();
    if (!tripSignature) return;
    const stopChecklist = { ...checklist[stopKey], [productId]: !checklist[stopKey]?.[productId] };
    const nextChecklist = { ...checklist, [stopKey]: stopChecklist };
    set({ checklist: nextChecklist });
    routeChecklistRepository.save(tripSignature, nextChecklist);
  },

  setFollowMode: (following) => set({ followMode: following }),

  startNavigation: () => set({ navigationMode: 'navigation', followMode: true }),
  exitNavigation: () => set({ navigationMode: 'overview' }),

  clearTrip: async () => {
    set({ tripSignature: null, checklist: {}, hydrated: false, followMode: true, navigationMode: 'overview' });
    await routeChecklistRepository.clear();
  },
}));
