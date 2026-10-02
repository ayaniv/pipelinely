import type { QueryClient } from '@tanstack/react-query'
import { SNAPSHOT_QUERY_KEY } from './snapshot'
import { isValidSnapshot } from './snapshotValidation'
import type { Logger } from '../log'

export type ConnectionStatus = 'live' | 'reconnecting'

export interface ConnectSnapshotStreamOptions {
  queryClient: QueryClient
  createEventSource: (url: string) => EventSource
  onStatus: (status: ConnectionStatus) => void
  log: Logger
}

export interface SnapshotStreamConnection {
  source: EventSource
  close: () => void
}

// The one EventSource('/events') for the whole app. The handler is
// assigned via `source.onmessage` (not addEventListener) and the source is
// exposed as `window.es` so end-to-end specs can drive it —
// focus-button-rerender-race.spec.ts pauses every render
// by overwriting `es.onmessage`, which only works against a plain property.
export function connectSnapshotStream({
  queryClient,
  createEventSource,
  onStatus,
  log,
}: ConnectSnapshotStreamOptions): SnapshotStreamConnection {
  const source = createEventSource('/events')

  source.onopen = () => onStatus('live')
  source.onerror = () => onStatus('reconnecting')
  source.onmessage = (event: MessageEvent<string>) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(event.data)
    } catch (err) {
      log('[snapshot] malformed SSE payload — ignored', err)
      return
    }
    if (!isValidSnapshot(parsed)) {
      log('[snapshot] SSE payload failed shape validation — ignored', parsed)
      return
    }
    queryClient.setQueryData(SNAPSHOT_QUERY_KEY, parsed)
  }

  return {
    source,
    close: () => source.close(),
  }
}
