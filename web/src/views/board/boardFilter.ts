import { useSyncExternalStore } from 'react'

// The board's ONE project filter (multi-select; an empty selection means
// every project — there is no "All" chip). It narrows the Active, Backlog and
// Done panels and drives the sidebar counts, all of them React views, so it
// lives in a module-level store rather than in one view's component state.
// Module scope rather than localStorage on purpose: it must survive an SSE re-render without
// surviving a reload.

type Listener = () => void

export interface ProjectFilterStore {
  getSelected: () => ReadonlySet<string>
  toggle: (project: string) => void
  // Drops selections whose project no longer exists on the board rather than
  // stranding an empty board. Returns whether anything was dropped.
  prune: (validProjects: readonly string[]) => boolean
  subscribe: (listener: Listener) => () => void
}

export function createProjectFilterStore(): ProjectFilterStore {
  // Replaced, never mutated, so getSelected() is a stable snapshot for
  // useSyncExternalStore between changes.
  let selected: ReadonlySet<string> = new Set()
  const listeners = new Set<Listener>()

  const publish = (next: ReadonlySet<string>) => {
    selected = next
    listeners.forEach((listener) => listener())
  }

  return {
    getSelected: () => selected,
    toggle: (project) => {
      const next = new Set(selected)
      if (next.has(project)) next.delete(project)
      else next.add(project)
      publish(next)
    },
    prune: (validProjects) => {
      const valid = new Set(validProjects)
      const kept = [...selected].filter((project) => valid.has(project))
      if (kept.length === selected.size) return false
      publish(new Set(kept))
      return true
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export const projectFilterStore = createProjectFilterStore()

export function useProjectFilter(store: ProjectFilterStore = projectFilterStore) {
  const selected = useSyncExternalStore(store.subscribe, store.getSelected)
  return { selected, toggle: store.toggle, prune: store.prune }
}

// The selection as the board should apply it right now: a selected project
// that has left the board (its last row was completed or dropped) counts as
// already deselected, so the panels never show an empty board with no way to
// see why. The store itself is pruned separately, in an effect. Returns the
// same set when nothing was dropped.
export function selectionWithin(selected: ReadonlySet<string>, options: readonly string[]): ReadonlySet<string> {
  const kept = [...selected].filter((project) => options.includes(project))
  return kept.length === selected.size ? selected : new Set(kept)
}
