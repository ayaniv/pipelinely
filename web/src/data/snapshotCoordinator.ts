import type { QueryClient } from '@tanstack/react-query'
import { SNAPSHOT_QUERY_KEY, fetchSnapshot } from './snapshot'
import { connectSnapshotStream, type ConnectionStatus } from './sseBridge'
import type { Logger } from '../log'

export interface SnapshotCoordinatorOptions {
  queryClient: QueryClient
  fetchImpl: typeof fetch
  createEventSource: (url: string) => EventSource
  onStatus: (status: ConnectionStatus) => void
  onBootstrapError?: (error: unknown) => void
  log: Logger
}

export interface SnapshotCoordinator {
  dispose: () => void
}

// The one thing that owns both the cold GET /api/tasks load and the SSE
// stream for the lifetime of a QueryClient. `setQueryData` applies writes synchronously with
// no notion of server-snapshot chronology, so without this a cold HTTP
// response that happens to resolve *after* SSE has already pushed a newer
// snapshot could stomp it with older data. The fix doesn't need a local
// "have we seen SSE yet" flag: checking whether the shared cache already
// holds a value, right before writing the cold result — with no `await` in
// between — covers both an ordinary same-coordinator race AND a React
// StrictMode remount, where a second coordinator's own bootstrap has no
// memory of the first coordinator's SSE traffic but shares its QueryClient.
export function startSnapshotCoordinator({
  queryClient,
  fetchImpl,
  createEventSource,
  onStatus,
  onBootstrapError,
  log,
}: SnapshotCoordinatorOptions): SnapshotCoordinator {
  let disposed = false
  const abortController = new AbortController()

  const stream = connectSnapshotStream({ queryClient, createEventSource, onStatus, log })

  fetchSnapshot({ fetchImpl, log, signal: abortController.signal })
    .then((snapshot) => {
      // No `await` between this check and the write: any SSE push that
      // landed while this request was in flight — from this coordinator or
      // a since-disposed predecessor sharing the same QueryClient — already
      // wrote a value, and that value must win.
      if (disposed) return
      if (queryClient.getQueryData(SNAPSHOT_QUERY_KEY) !== undefined) return
      queryClient.setQueryData(SNAPSHOT_QUERY_KEY, snapshot)
    })
    .catch((err) => {
      // An abort from dispose() below is an expected cancellation, not a
      // real bootstrap failure — SSE (or a future coordinator) still owns
      // filling the board.
      if (disposed) return
      onBootstrapError?.(err)
    })

  return {
    dispose: () => {
      disposed = true
      abortController.abort()
      stream.close()
    },
  }
}
