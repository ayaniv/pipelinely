import { useSyncExternalStore } from 'react'
import { createExternalStore } from './externalStore'
import type { Logger } from '../log'

// Which view the Active tab shows: the card groups or the two tables. A
// per-browser preference, so it lives in localStorage rather than the
// server's settings.

export const ACTIVE_VIEW_STORAGE_KEY = 'cockpit-active-view'

export type ActiveView = 'cards' | 'table'

export interface ActiveViewDeps {
  storage: Pick<Storage, 'getItem' | 'setItem'>
  log: Logger
}

export function createActiveViewStore({ storage, log }: ActiveViewDeps) {
  function readStoredView(): ActiveView {
    // Private mode and blocked site data throw on access rather than
    // returning null.
    try {
      return storage.getItem(ACTIVE_VIEW_STORAGE_KEY) === 'table' ? 'table' : 'cards'
    } catch (err) {
      log('[active-view] could not read the stored choice', err)
      return 'cards'
    }
  }

  const store = createExternalStore<ActiveView>(readStoredView())

  function set(view: ActiveView): void {
    store.set(view)
    try {
      storage.setItem(ACTIVE_VIEW_STORAGE_KEY, view)
    } catch (err) {
      // Not fatal: the choice still applies to this page, it just won't
      // survive a reload.
      log('[active-view] could not persist the choice', err)
    }
  }

  return { get: store.get, subscribe: store.subscribe, set }
}

export type ActiveViewStore = ReturnType<typeof createActiveViewStore>

export const activeViewStore: ActiveViewStore = createActiveViewStore({
  storage: {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
  },
  log: console.error,
})

export function useActiveView(): ActiveView {
  return useSyncExternalStore(activeViewStore.subscribe, activeViewStore.get)
}
