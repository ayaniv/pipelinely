// The minimal subscribe/getSnapshot pair React's useSyncExternalStore wants,
// shared by the small client-only stores below (connection status,
// auto-submit) so each one only declares its own state and transitions.
export interface ExternalStore<State> {
  get: () => State
  subscribe: (listener: () => void) => () => void
}

export function createExternalStore<State>(initial: State): ExternalStore<State> & { set: (next: State) => void } {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set: (next) => {
      if (Object.is(next, state)) return
      state = next
      listeners.forEach((listener) => listener())
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
