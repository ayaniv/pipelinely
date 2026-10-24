import { useSyncExternalStore } from 'react'
import { createExternalStore } from '../../data/externalStore'
import { nextTableSort, type TableSort, type TableSortKey } from './tableSort'

// The one sort both tables read, at module scope like the board filter
// (QUESTIONS #12): it survives an SSE re-render and the view switch, not a reload.

const store = createExternalStore<TableSort | null>(null)

export const tableSortStore = {
  get: store.get,
  subscribe: store.subscribe,
  cycle: (key: TableSortKey): void => store.set(nextTableSort(store.get(), key)),
  reset: (): void => store.set(null),
}

export function useTableSort(): TableSort | null {
  return useSyncExternalStore(tableSortStore.subscribe, tableSortStore.get)
}
