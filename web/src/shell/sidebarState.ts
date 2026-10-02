import { useSyncExternalStore } from 'react'
import { createExternalStore } from '../data/externalStore'

// The sidebar's two independent concerns, sharing one <aside>: a desktop
// icon-only collapse and a mobile off-canvas drawer. Neither persists across a
// reload — only the theme choice does. Collapse instead DEFAULTS differently
// per screen (a task detail starts collapsed, the board expanded), decided
// once against the page's starting route (main.tsx) and then left to the
// user's own clicks. `isCollapsed` only ever applies at desktop widths (see the
// @media override in app.css), so the two never fight over the sidebar's width.
// A store rather than component state because a tab pick (far from the
// sidebar's own markup) closes the drawer.

export interface SidebarState {
  isCollapsed: boolean
  isMobileOpen: boolean
}

export function createSidebarStore(initial: SidebarState = { isCollapsed: false, isMobileOpen: false }) {
  const store = createExternalStore<SidebarState>(initial)
  const update = (patch: Partial<SidebarState>) => {
    const current = store.get()
    const next = { ...current, ...patch }
    // Closing an already-closed drawer must not re-render every subscriber.
    if (next.isCollapsed === current.isCollapsed && next.isMobileOpen === current.isMobileOpen) return
    store.set(next)
  }
  return {
    get: store.get,
    subscribe: store.subscribe,
    setCollapsed: (isCollapsed: boolean) => update({ isCollapsed }),
    toggleCollapsed: () => update({ isCollapsed: !store.get().isCollapsed }),
    openMobile: () => update({ isMobileOpen: true }),
    closeMobile: () => update({ isMobileOpen: false }),
  }
}

export type SidebarStore = ReturnType<typeof createSidebarStore>

export const sidebarStore: SidebarStore = createSidebarStore()

export function useSidebarState(store: SidebarStore = sidebarStore): SidebarState {
  return useSyncExternalStore(store.subscribe, store.get)
}
