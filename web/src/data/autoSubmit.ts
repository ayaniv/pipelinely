import { useSyncExternalStore } from 'react'
import { createExternalStore } from './externalStore'
import type { Logger } from '../log'

// Remote/mobile access context (probe + the auto-submit choice). Is the person looking at this page doing it from
// their phone over the tailnet? The server answers per-request from the
// connection's own peer address (GET /api/access) — never from anything this
// page could get wrong or a bookmark could forge. Remote-only: the
// auto-submit toggle, which lets a stage CTA send its command instead of
// leaving it staged for a manual Return.
//
// isRemoteAccess starts false and STAYS false unless the server says
// otherwise. Off is the safe direction: it is today's desktop behaviour, so
// a probe that fails, is slow, or answers nonsense degrades to exactly the
// dashboard that shipped before this feature existed.

export const AUTO_SUBMIT_STORAGE_KEY = 'cockpit-auto-submit'

export interface AutoSubmitState {
  isRemoteAccess: boolean
  // Signed in with the remote-access token (not merely remote); only decides
  // whether the Settings page offers Sign out.
  hasRemoteSession: boolean
  isChoiceOn: boolean
}

export interface AutoSubmitDeps {
  fetchImpl: typeof fetch
  storage: Pick<Storage, 'getItem' | 'setItem'>
  log: Logger
}

export function createAutoSubmitStore({ fetchImpl, storage, log }: AutoSubmitDeps) {
  function readStoredChoice(): boolean {
    // Private mode and blocked site data both throw on access rather than
    // returning null.
    try {
      return storage.getItem(AUTO_SUBMIT_STORAGE_KEY) === 'on'
    } catch (err) {
      log('[auto-submit] could not read the stored choice', err)
      return false
    }
  }

  const store = createExternalStore<AutoSubmitState>({ isRemoteAccess: false, hasRemoteSession: false, isChoiceOn: readStoredChoice() })

  // Both halves of the gate in one named place, so no call site can ever
  // check only one of them. An AND, never a fallback: a stored "on" from an
  // earlier phone session must not survive into a context that can no longer
  // confirm it is remote.
  function isEnabled(): boolean {
    const { isRemoteAccess, isChoiceOn } = store.get()
    return isRemoteAccess && isChoiceOn
  }

  // Nothing waits on this: until it resolves the page behaves exactly as it
  // does on the desktop. An enhancement, not a load-bearing fetch.
  async function probeAccessContext(signal?: AbortSignal): Promise<void> {
    try {
      const res = await fetchImpl('/api/access', signal ? { signal } : undefined)
      if (!res.ok) throw new Error(`GET /api/access responded ${res.status}`)
      const body = (await res.json()) as { isRemoteAccess?: unknown; hasRemoteSession?: unknown }
      store.set({
        ...store.get(),
        isRemoteAccess: body.isRemoteAccess === true,
        hasRemoteSession: body.hasRemoteSession === true,
      })
    } catch (err) {
      if (signal?.aborted) return
      log('[auto-submit] could not determine dashboard access context', err)
    }
  }

  function toggleChoice(): void {
    const next = !store.get().isChoiceOn
    store.set({ ...store.get(), isChoiceOn: next })
    try {
      storage.setItem(AUTO_SUBMIT_STORAGE_KEY, next ? 'on' : 'off')
    } catch (err) {
      // Not fatal — the choice still applies to this page view, it just
      // won't survive a reload.
      log('[auto-submit] could not persist the choice', err)
    }
  }

  return { get: store.get, subscribe: store.subscribe, isEnabled, probeAccessContext, toggleChoice }
}

export type AutoSubmitStore = ReturnType<typeof createAutoSubmitStore>

// The one instance the app runs on. Created lazily-safe: `localStorage`
// itself can throw on access (blocked site data), which readStoredChoice
// already handles, but merely referencing the global must not.
export const autoSubmitStore: AutoSubmitStore = createAutoSubmitStore({
  fetchImpl: (...args) => fetch(...args),
  storage: {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
  },
  log: console.error,
})

export function useAutoSubmit(): AutoSubmitState {
  return useSyncExternalStore(autoSubmitStore.subscribe, autoSubmitStore.get)
}
