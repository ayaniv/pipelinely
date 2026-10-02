import { useSyncExternalStore } from 'react'
import { createExternalStore } from './externalStore'
import type { Logger } from '../log'

// The header's live-status pill. Written by the one SSE bridge's onStatus
// callback (main.tsx) and read by the pill through the hook, so the
// connection state has a single owner instead of anything poking DOM
// nodes. 'connecting' until the stream first opens.
export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting'

const store = createExternalStore<ConnectionStatus>('connecting')

export function setConnectionStatus(status: string, log: Logger = console.error): void {
  // The SSE bridge reports 'live' | 'reconnecting'; anything else is a
  // programming error, never silently rendered as a status.
  if (status === 'live' || status === 'reconnecting') store.set(status)
  else log(`[connection] ignored unknown status "${status}"`)
}

export function useConnectionStatus(): ConnectionStatus {
  return useSyncExternalStore(store.subscribe, store.get)
}
