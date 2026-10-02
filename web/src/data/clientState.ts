import { useSyncExternalStore } from 'react'
import type { MergeBanner } from '../api/actions'
import { createExternalStore } from './externalStore'

// Client-only state more than one view reads or writes outside any snapshot
// update — so an action taken in one place (a merge started from the Merge
// tab, an off-focus toggle in a card menu, a wave dispatched from the graph)
// reaches every other place that renders it. A single immutable value behind
// one store: any change re-renders every subscriber, which is cheap next to
// the snapshot-driven re-render that already happens every second or two.

export interface MergeState {
  // The persistent failure/warning banner (Design §7) — state a re-render
  // READS, not DOM a re-render wipes, which is why it replaces a button flash.
  banner: MergeBanner | null
  // Whether a merge POST is in flight for this slug. Kept here rather than on
  // the button so a re-render can't erase it and open a double-submit.
  isInFlight: boolean
}

export interface DispatchStatus {
  ok: boolean
  label: string
  // The server's full message, for the tooltip — the label is deliberately short.
  detail: string | undefined
}

interface ClientStateValue {
  // "Mark off focus" has no backend concept yet: client-only, reset on reload.
  offFocusSlugs: ReadonlySet<string>
  mergeBySlug: ReadonlyMap<string, MergeState>
  runningWaveKeys: ReadonlySet<string>
  dispatchStatusBySlug: ReadonlyMap<string, DispatchStatus>
}

const IDLE_MERGE: MergeState = { banner: null, isInFlight: false }

const waveKey = (parentSlug: string, wave: number) => `${parentSlug}:${wave}`

function withSetMember<Member>(set: ReadonlySet<Member>, member: Member, isMember: boolean): ReadonlySet<Member> {
  const next = new Set(set)
  if (isMember) next.add(member)
  else next.delete(member)
  return next
}

export function createClientState() {
  const store = createExternalStore<ClientStateValue>({
    offFocusSlugs: new Set(),
    mergeBySlug: new Map(),
    runningWaveKeys: new Set(),
    dispatchStatusBySlug: new Map(),
  })
  const update = (patch: Partial<ClientStateValue>) => store.set({ ...store.get(), ...patch })

  const setMerge = (slug: string, merge: MergeState) => update({ mergeBySlug: new Map(store.get().mergeBySlug).set(slug, merge) })

  return {
    get: store.get,
    subscribe: store.subscribe,

    isOffFocus: (slug: string) => store.get().offFocusSlugs.has(slug),
    toggleOffFocus: (slug: string) => {
      const { offFocusSlugs } = store.get()
      update({ offFocusSlugs: withSetMember(offFocusSlugs, slug, !offFocusSlugs.has(slug)) })
    },

    getMergeState: (slug: string): MergeState => store.get().mergeBySlug.get(slug) ?? IDLE_MERGE,
    // Marked in flight and the banner cleared together: a stale reason must
    // never sit next to a new attempt.
    beginMerge: (slug: string) => setMerge(slug, { banner: null, isInFlight: true }),
    settleMerge: (slug: string, banner: MergeBanner | null) => setMerge(slug, { banner, isInFlight: false }),

    isWaveRunning: (parentSlug: string, wave: number) => store.get().runningWaveKeys.has(waveKey(parentSlug, wave)),
    setWaveRunning: (parentSlug: string, wave: number, isRunning: boolean) =>
      update({ runningWaveKeys: withSetMember(store.get().runningWaveKeys, waveKey(parentSlug, wave), isRunning) }),

    getDispatchStatus: (childSlug: string): DispatchStatus | null => store.get().dispatchStatusBySlug.get(childSlug) ?? null,
    setDispatchStatuses: (childSlugs: string[], status: DispatchStatus) => {
      const next = new Map(store.get().dispatchStatusBySlug)
      for (const slug of childSlugs) next.set(slug, status)
      update({ dispatchStatusBySlug: next })
    },
    clearDispatchStatuses: (childSlugs: string[]) => {
      const next = new Map(store.get().dispatchStatusBySlug)
      for (const slug of childSlugs) next.delete(slug)
      update({ dispatchStatusBySlug: next })
    },
  }
}

export type ClientState = ReturnType<typeof createClientState>

export const clientState: ClientState = createClientState()

// Re-renders the calling component whenever any of the state above changes.
// Returns the value so a component that needs to re-derive from it can.
export function useClientState(state: ClientState = clientState): ClientStateValue {
  return useSyncExternalStore(state.subscribe, state.get)
}
