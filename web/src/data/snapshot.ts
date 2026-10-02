import { useQuery, type QueryKey } from '@tanstack/react-query'
import type { Snapshot } from '../../../src/types'
import { isValidSnapshot } from './snapshotValidation'
import type { Logger } from '../log'
import { redirectToRemoteLogin } from './remoteSession'

export type { Snapshot }

// The one cache entry every view reads from — written by fetchSnapshot's
// cold load and by sseBridge's pushed updates, and read (never fetched
// directly) by useSnapshot below.
export const SNAPSHOT_QUERY_KEY: QueryKey = ['snapshot']

export interface FetchSnapshotOptions {
  fetchImpl: typeof fetch
  log: Logger
  // Only the coordinator passes this (to cancel a bootstrap load on
  // disposal) — omitted, fetchImpl is called with exactly one argument, the
  // same call shape snapshot.test.ts asserts on.
  signal?: AbortSignal
  // Where a refused-for-lack-of-a-session load sends the browser; only the
  // tests pass it.
  navigate?: (path: string) => void
}

// A failed cold load is logged, not swallowed — SSE still
// fills the cache on failure, but the failure itself must be observable.
export async function fetchSnapshot({ fetchImpl, log, signal, navigate }: FetchSnapshotOptions): Promise<Snapshot> {
  let response: Response
  try {
    response = signal ? await fetchImpl('/api/tasks', { signal }) : await fetchImpl('/api/tasks')
  } catch (err) {
    log('[snapshot] initial /api/tasks load failed', err)
    throw err
  }
  if (!response.ok) {
    await redirectToRemoteLogin(response, { log, navigate })
    const err = new Error(`[snapshot] /api/tasks responded ${response.status}`)
    log('[snapshot] initial /api/tasks load failed', err)
    throw err
  }
  const payload: unknown = await response.json()
  if (!isValidSnapshot(payload)) {
    const err = new Error('[snapshot] /api/tasks response failed shape validation')
    log('[snapshot] initial /api/tasks load failed', err)
    throw err
  }
  return payload
}

// Observes the snapshot cache only — automatic fetching is disabled because
// the app-level coordinator (snapshotCoordinator.ts) is the sole writer, via
// fetchSnapshot's cold load and the SSE bridge's pushed updates. A view that
// called useQuery with its own queryFn here would create a second writer
// racing the coordinator's own bootstrap arbitration.
export function useSnapshot() {
  return useQuery<Snapshot>({
    queryKey: SNAPSHOT_QUERY_KEY,
    queryFn: () => {
      throw new Error('useSnapshot has no query function of its own — snapshotCoordinator.ts owns every write')
    },
    enabled: false,
  })
}
