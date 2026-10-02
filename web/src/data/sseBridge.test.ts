import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { connectSnapshotStream, type ConnectionStatus } from './sseBridge'
import { SNAPSHOT_QUERY_KEY } from './snapshot'

// A stand-in for the browser's EventSource: the bridge only ever assigns the
// three on* handler properties and calls close(), so this is the whole
// surface it touches.
class FakeEventSource {
  onmessage: ((e: MessageEvent) => void) | null = null
  onopen: ((e: Event) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  close = vi.fn()
  constructor(public url: string) {}
  emit(data: string) { this.onmessage?.(new MessageEvent('message', { data })) }
}

const SNAPSHOT = {
  tasks: [],
  activeProject: null,
  weeklyFocus: 'ship the shell',
  backlog: [],
  doneGroups: [],
  settings: { autoMode: false },
  orchestratorContextPct: 42,
  isCanonical: false,
}

describe('connectSnapshotStream', () => {
  let queryClient: QueryClient
  let source: FakeEventSource
  let statuses: ConnectionStatus[]
  // Pinned to a concrete function type — see snapshot.test.ts's own comment
  // on why `ReturnType<typeof vi.fn>` alone doesn't assign here.
  let log: Mock<(message: string, ...args: unknown[]) => void>
  let connection: ReturnType<typeof connectSnapshotStream>

  beforeEach(() => {
    queryClient = new QueryClient()
    statuses = []
    log = vi.fn()
    connection = connectSnapshotStream({
      queryClient,
      createEventSource: (url) => {
        source = new FakeEventSource(url)
        return source as unknown as EventSource
      },
      onStatus: (status) => statuses.push(status),
      log,
    })
  })

  afterEach(() => {
    connection.close()
    queryClient.clear()
  })

  it('opens exactly one stream, on /events', () => {
    expect(source.url).toBe('/events')
    expect(connection.source).toBe(source)
  })

  it('writes each pushed snapshot into the snapshot query cache', () => {
    source.emit(JSON.stringify(SNAPSHOT))
    expect(queryClient.getQueryData(SNAPSHOT_QUERY_KEY)).toEqual(SNAPSHOT)

    const next = { ...SNAPSHOT, weeklyFocus: 'migrate task detail' }
    source.emit(JSON.stringify(next))
    expect(queryClient.getQueryData(SNAPSHOT_QUERY_KEY)).toEqual(next)
  })

  it('logs a malformed payload and keeps the last good snapshot', () => {
    source.emit(JSON.stringify(SNAPSHOT))
    source.emit('{not json')

    expect(queryClient.getQueryData(SNAPSHOT_QUERY_KEY)).toEqual(SNAPSHOT)
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('reports live on open and reconnecting on error', () => {
    source.onopen?.(new Event('open'))
    source.onerror?.(new Event('error'))
    source.onopen?.(new Event('open'))
    expect(statuses).toEqual(['live', 'reconnecting', 'live'])
  })

  // focus-button-rerender-race.spec.ts pauses every render by overwriting
  // `es.onmessage` — that only works if the bridge's handler IS onmessage,
  // not an addEventListener('message') listener that an onmessage overwrite
  // would leave running.
  it('handles messages through the onmessage property, so overwriting it pauses the cache', () => {
    expect(typeof source.onmessage).toBe('function')
    source.onmessage = () => {}
    source.emit(JSON.stringify(SNAPSHOT))
    expect(queryClient.getQueryData(SNAPSHOT_QUERY_KEY)).toBeUndefined()
  })

  it('close() closes the underlying stream', () => {
    connection.close()
    expect(source.close).toHaveBeenCalled()
  })
})
