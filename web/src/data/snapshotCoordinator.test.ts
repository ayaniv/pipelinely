import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { startSnapshotCoordinator } from './snapshotCoordinator'
import { SNAPSHOT_QUERY_KEY, type Snapshot } from './snapshot'

// A stand-in for the browser's EventSource — same surface sseBridge.test.ts
// uses, since the coordinator's own SSE leg is connectSnapshotStream.
class FakeEventSource {
  onmessage: ((e: MessageEvent) => void) | null = null
  onopen: ((e: Event) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  close = vi.fn()
  constructor(public url: string) {}
  emit(data: string) { this.onmessage?.(new MessageEvent('message', { data })) }
}

const snapshotWith = (weeklyFocus: string): Snapshot => ({
  tasks: [],
  activeProject: null,
  weeklyFocus,
  backlog: [],
  doneGroups: [],
  settings: { autoMode: false },
  orchestratorContextPct: null,
  isCanonical: false,
})

// Resolves/rejects on demand from outside the Promise executor — lets a
// test interleave the cold HTTP leg and the SSE leg in a chosen order
// instead of a real race depending on however fast the event loop runs.
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// Response.json() reads its body through real async iteration, which takes
// more than a couple of microtask ticks to settle — a macrotask boundary
// reliably drains everything queued ahead of it, including fetchSnapshot's
// own chained .then()s.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('startSnapshotCoordinator', () => {
  let queryClient: QueryClient
  let source: FakeEventSource
  let log: Mock<(message: string, ...args: unknown[]) => void>
  let onStatus: Mock<(status: string) => void>
  let onBootstrapError: Mock<(error: unknown) => void>
  let fetchDeferred: ReturnType<typeof deferred<Response>>
  let fetchImpl: Mock<typeof fetch>

  beforeEach(() => {
    queryClient = new QueryClient()
    log = vi.fn()
    onStatus = vi.fn()
    onBootstrapError = vi.fn()
    fetchDeferred = deferred<Response>()
    fetchImpl = vi.fn(() => fetchDeferred.promise) as unknown as Mock<typeof fetch>
  })

  afterEach(() => {
    queryClient.clear()
  })

  function start() {
    return startSnapshotCoordinator({
      queryClient,
      fetchImpl,
      createEventSource: (url) => {
        source = new FakeEventSource(url)
        return source as unknown as EventSource
      },
      onStatus,
      onBootstrapError,
      log,
    })
  }

  it('HTTP A starting, then SSE B accepted, then HTTP A completing: the cache stays on B', async () => {
    const coordinator = start()

    source.emit(JSON.stringify(snapshotWith('B (from SSE)')))
    expect(queryClient.getQueryData(SNAPSHOT_QUERY_KEY)).toEqual(snapshotWith('B (from SSE)'))

    fetchDeferred.resolve(new Response(JSON.stringify(snapshotWith('A (from cold HTTP)')), { status: 200 }))
    await flush()

    expect(queryClient.getQueryData(SNAPSHOT_QUERY_KEY)).toEqual(snapshotWith('B (from SSE)'))
    coordinator.dispose()
  })

  it('HTTP completing first, then a later SSE push still replaces it', async () => {
    const coordinator = start()

    fetchDeferred.resolve(new Response(JSON.stringify(snapshotWith('cold')), { status: 200 }))
    await flush()
    expect(queryClient.getQueryData(SNAPSHOT_QUERY_KEY)).toEqual(snapshotWith('cold'))

    source.emit(JSON.stringify(snapshotWith('pushed')))
    expect(queryClient.getQueryData(SNAPSHOT_QUERY_KEY)).toEqual(snapshotWith('pushed'))
    coordinator.dispose()
  })

  it('a malformed SSE message does not block the still-pending HTTP bootstrap from applying', async () => {
    const coordinator = start()

    source.emit('{not json')
    expect(queryClient.getQueryData(SNAPSHOT_QUERY_KEY)).toBeUndefined()

    fetchDeferred.resolve(new Response(JSON.stringify(snapshotWith('cold')), { status: 200 }))
    await flush()

    expect(queryClient.getQueryData(SNAPSHOT_QUERY_KEY)).toEqual(snapshotWith('cold'))
    coordinator.dispose()
  })

  it('an HTTP bootstrap failure is logged, and a later valid SSE push still populates the cache', async () => {
    const coordinator = start()

    fetchDeferred.resolve(new Response('boom', { status: 500 }))
    await flush()

    expect(onBootstrapError).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryData(SNAPSHOT_QUERY_KEY)).toBeUndefined()

    source.emit(JSON.stringify(snapshotWith('pushed after failure')))
    expect(queryClient.getQueryData(SNAPSHOT_QUERY_KEY)).toEqual(snapshotWith('pushed after failure'))
    coordinator.dispose()
  })

  // React StrictMode mounts an effect, cleans it up, then mounts it again —
  // both coordinators share the same QueryClient. A value the first
  // coordinator's SSE already accepted must survive into the second
  // coordinator's own bootstrap window, even though the second coordinator
  // has no memory of the first one's SSE traffic.
  it('cleanup/remount: a value already in the cache survives the next coordinator\'s own cold bootstrap', async () => {
    const first = start()
    source.emit(JSON.stringify(snapshotWith('kept across remount')))
    first.dispose()

    const secondFetchDeferred = deferred<Response>()
    fetchImpl = vi.fn(() => secondFetchDeferred.promise) as unknown as Mock<typeof fetch>
    const second = start()

    secondFetchDeferred.resolve(new Response(JSON.stringify(snapshotWith('stale second bootstrap')), { status: 200 }))
    await flush()

    expect(queryClient.getQueryData(SNAPSHOT_QUERY_KEY)).toEqual(snapshotWith('kept across remount'))
    second.dispose()
  })

  it('a disposed coordinator never applies a bootstrap result that resolves after disposal', async () => {
    const coordinator = start()
    coordinator.dispose()

    fetchDeferred.resolve(new Response(JSON.stringify(snapshotWith('too late')), { status: 200 }))
    await flush()

    expect(queryClient.getQueryData(SNAPSHOT_QUERY_KEY)).toBeUndefined()
    expect(onBootstrapError).not.toHaveBeenCalled()
  })

  it('dispose() closes the underlying SSE stream', () => {
    const coordinator = start()
    coordinator.dispose()
    expect(source.close).toHaveBeenCalled()
  })
})
