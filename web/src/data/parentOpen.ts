import { useSyncExternalStore } from 'react'
import { createExternalStore } from './externalStore'

// Which Parent tasks rows are expanded. Held in memory only, on purpose:
// "remembered for the session" means a row survives the tab switches and
// remounts that happen while the page is open, and starts collapsed again on
// a reload.

export function createParentOpenStore() {
  const store = createExternalStore<ReadonlySet<string>>(new Set())

  return {
    get: store.get,
    subscribe: store.subscribe,
    isOpen: (slug: string) => store.get().has(slug),
    toggle: (slug: string) => {
      const next = new Set(store.get())
      if (!next.delete(slug)) next.add(slug)
      store.set(next)
    },
    reset: () => store.set(new Set()),
  }
}

export type ParentOpenStore = ReturnType<typeof createParentOpenStore>

export const parentOpenStore: ParentOpenStore = createParentOpenStore()

export function useParentOpen(): ReadonlySet<string> {
  return useSyncExternalStore(parentOpenStore.subscribe, parentOpenStore.get)
}
