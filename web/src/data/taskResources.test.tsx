import { describe, expect, test, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { fetchDocsGuide, fetchQaSpec, fetchResultDoc, fetchStageScopes, fetchTechDesign, useDocsGuide, useQaSpec, useResultDoc, useStageScopes, useTechDesign, type TechDesign } from './taskResources'
import type { ResultDoc } from '../../../src/types'
import { SNAPSHOT_QUERY_KEY } from './snapshot'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const DESIGN: TechDesign = { html: '<h1>Plan</h1>', summaryHtml: null, testGroups: [] }

describe('fetchTechDesign', () => {
  test('resolves the parsed document and passes the abort signal through', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, DESIGN))
    const signal = new AbortController().signal

    await expect(fetchTechDesign('my-task', { fetchImpl, log: vi.fn(), signal })).resolves.toEqual(DESIGN)
    expect(fetchImpl).toHaveBeenCalledWith('/tech-design/my-task', { signal })
  })

  test('a 404 is an expected "no tech-design.md" — null, not logged', async () => {
    const log = vi.fn()
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }))

    await expect(fetchTechDesign('my-task', { fetchImpl, log })).resolves.toBeNull()
    expect(log).not.toHaveBeenCalled()
  })

  test('a server error rejects and logs a [tech-design] error', async () => {
    const log = vi.fn()
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))

    await expect(fetchTechDesign('my-task', { fetchImpl, log })).rejects.toThrow()
    expect(log).toHaveBeenCalledWith('[tech-design] load for my-task failed', expect.any(Error))
  })

  test('a network failure rejects and logs a [tech-design] error', async () => {
    const log = vi.fn()
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'))

    await expect(fetchTechDesign('my-task', { fetchImpl, log })).rejects.toThrow('network down')
    expect(log).toHaveBeenCalledWith('[tech-design] load for my-task failed', expect.any(Error))
  })

  test('an aborted request rejects without logging — cancellation is not a failure', async () => {
    const log = vi.fn()
    const abort = new DOMException('aborted', 'AbortError')
    const fetchImpl = vi.fn().mockRejectedValue(abort)

    await expect(fetchTechDesign('my-task', { fetchImpl, log })).rejects.toBe(abort)
    expect(log).not.toHaveBeenCalled()
  })
})

describe('fetchQaSpec', () => {
  test('resolves the planned case titles', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { titles: ['a', 'b'] }))
    await expect(fetchQaSpec('my-task', { fetchImpl, log: vi.fn() })).resolves.toEqual(['a', 'b'])
    expect(fetchImpl).toHaveBeenCalledWith('/qa-spec/my-task', { signal: undefined })
  })

  test('a 404 (no spec file to read) is null and not logged', async () => {
    const log = vi.fn()
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }))
    await expect(fetchQaSpec('my-task', { fetchImpl, log })).resolves.toBeNull()
    expect(log).not.toHaveBeenCalled()
  })

  test('a server error rejects and logs a [qa-spec] error', async () => {
    const log = vi.fn()
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
    await expect(fetchQaSpec('my-task', { fetchImpl, log })).rejects.toThrow()
    expect(log).toHaveBeenCalledWith('[qa-spec] load for my-task failed', expect.any(Error))
  })
})

describe('fetchStageScopes', () => {
  test('resolves the per-stage scope map', async () => {
    const stages = { dev: { steps: ['one'], constraints: [] } }
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { stages }))
    await expect(fetchStageScopes({ fetchImpl, log: vi.fn() })).resolves.toEqual(stages)
  })

  test('any failure rejects and logs a [stage-scope] error', async () => {
    const log = vi.fn()
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
    await expect(fetchStageScopes({ fetchImpl, log })).rejects.toThrow()
    expect(log).toHaveBeenCalledWith('[stage-scope] load failed', expect.any(Error))
  })
})

function makeWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

describe('useTechDesign', () => {
  test('goes from loading to ready with the document', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, DESIGN))
    const { result } = renderHook(() => useTechDesign('my-task', { fetchImpl, log: vi.fn() }), { wrapper: makeWrapper(new QueryClient()) })

    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.data).toEqual(DESIGN)
  })

  test('an absent document is ready with null data, not a failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }))
    const { result } = renderHook(() => useTechDesign('my-task', { fetchImpl, log: vi.fn() }), { wrapper: makeWrapper(new QueryClient()) })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.data).toBeNull()
  })

  test('a failed load is reported as failed, and is not retried', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
    const { result } = renderHook(() => useTechDesign('my-task', { fetchImpl, log: vi.fn() }), { wrapper: makeWrapper(new QueryClient()) })

    await waitFor(() => expect(result.current.status).toBe('failed'))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('a slow response for one slug can never surface under the next slug', async () => {
    const slow = deferred<Response>()
    const fetchImpl = vi.fn((url: string) => (url.endsWith('/task-a') ? slow.promise : Promise.resolve(jsonResponse(200, { ...DESIGN, html: '<p>B</p>' }))))
    const { result, rerender } = renderHook(({ slug }) => useTechDesign(slug, { fetchImpl: fetchImpl as unknown as typeof fetch, log: vi.fn() }), {
      wrapper: makeWrapper(new QueryClient()),
      initialProps: { slug: 'task-a' },
    })

    rerender({ slug: 'task-b' })
    await waitFor(() => expect(result.current.data?.html).toBe('<p>B</p>'))
    await act(async () => { slow.resolve(jsonResponse(200, { ...DESIGN, html: '<p>A</p>' })) })

    expect(result.current.data?.html).toBe('<p>B</p>')
  })

  test('a later snapshot refreshes the document in place — kept on screen, never back to loading', async () => {
    const queryClient = new QueryClient()
    let html = '<p>v1</p>'
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(200, { ...DESIGN, html })))
    const { result } = renderHook(() => useTechDesign('my-task', { fetchImpl: fetchImpl as unknown as typeof fetch, log: vi.fn() }), { wrapper: makeWrapper(queryClient) })
    await waitFor(() => expect(result.current.data?.html).toBe('<p>v1</p>'))
    const statuses: string[] = []

    html = '<p>v2</p>'
    await act(async () => { queryClient.setQueryData(SNAPSHOT_QUERY_KEY, { tasks: [] }) })
    statuses.push(result.current.status)
    await waitFor(() => expect(result.current.data?.html).toBe('<p>v2</p>'))
    statuses.push(result.current.status)

    expect(statuses).toEqual(['ready', 'ready'])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  test('a later snapshot does not re-request a failed load', async () => {
    const queryClient = new QueryClient()
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
    const log = vi.fn()
    const { result } = renderHook(() => useTechDesign('my-task', { fetchImpl, log }), { wrapper: makeWrapper(queryClient) })
    await waitFor(() => expect(result.current.status).toBe('failed'))

    await act(async () => { queryClient.setQueryData(SNAPSHOT_QUERY_KEY, { tasks: [1] }) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

    expect(result.current.status).toBe('failed')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledTimes(1)
  })

  test('a burst of snapshots while a refresh is in flight costs one request', async () => {
    const queryClient = new QueryClient()
    const refresh = deferred<Response>()
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, DESIGN))
      .mockReturnValueOnce(refresh.promise)
    const { result } = renderHook(() => useTechDesign('my-task', { fetchImpl, log: vi.fn() }), { wrapper: makeWrapper(queryClient) })
    await waitFor(() => expect(result.current.status).toBe('ready'))

    // React Query notifies observers on a timer, so let each push actually
    // reach the hook before the next one — and wait for the first refresh to
    // be on the wire, so the rest of the burst lands while it is in flight.
    await act(async () => { queryClient.setQueryData(SNAPSHOT_QUERY_KEY, { tasks: [1] }) })
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))
    await act(async () => { queryClient.setQueryData(SNAPSHOT_QUERY_KEY, { tasks: [2] }) })
    await act(async () => { queryClient.setQueryData(SNAPSHOT_QUERY_KEY, { tasks: [3] }) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    await act(async () => { refresh.resolve(jsonResponse(200, DESIGN)) })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('useQaSpec', () => {
  test('does not fetch while disabled', () => {
    const fetchImpl = vi.fn()
    renderHook(() => useQaSpec('my-task', false, { fetchImpl, log: vi.fn() }), { wrapper: makeWrapper(new QueryClient()) })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('resolves the planned titles once enabled', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { titles: ['one', 'two'] }))
    const { result } = renderHook(() => useQaSpec('my-task', true, { fetchImpl, log: vi.fn() }), { wrapper: makeWrapper(new QueryClient()) })
    await waitFor(() => expect(result.current).toEqual(['one', 'two']))
  })

  test('a failed load yields no titles', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
    const { result } = renderHook(() => useQaSpec('my-task', true, { fetchImpl, log: vi.fn() }), { wrapper: makeWrapper(new QueryClient()) })
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled())
    expect(result.current).toBeNull()
  })
})

describe('useStageScopes', () => {
  test('a failed load is not retried by a later mount in the same session', async () => {
    const queryClient = new QueryClient()
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
    const first = renderHook(() => useStageScopes({ fetchImpl, log: vi.fn() }), { wrapper: makeWrapper(queryClient) })
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(first.result.current).toBeNull())
    first.unmount()

    renderHook(() => useStageScopes({ fetchImpl, log: vi.fn() }), { wrapper: makeWrapper(queryClient) })
    await act(async () => { await Promise.resolve() })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('resolves the scope map once loaded', async () => {
    const stages = { dev: { steps: ['one'], constraints: ['c'] } }
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { stages }))
    const { result } = renderHook(() => useStageScopes({ fetchImpl, log: vi.fn() }), { wrapper: makeWrapper(new QueryClient()) })
    await waitFor(() => expect(result.current).toEqual(stages))
  })
})

const RESULT_DOC: ResultDoc = { file: 'AUDIT.md', markdown: '# Audit', isTruncated: false, totalBytes: 7, mtimeMs: 1000 }

describe('fetchResultDoc', () => {
  test('resolves the document and passes the abort signal through', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, RESULT_DOC))
    const signal = new AbortController().signal

    await expect(fetchResultDoc('my-task', { fetchImpl, log: vi.fn(), signal })).resolves.toEqual(RESULT_DOC)
    expect(fetchImpl).toHaveBeenCalledWith('/result-doc/my-task', { signal })
  })

  test('a 404 is an expected "no document" — null, not logged', async () => {
    const log = vi.fn()
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }))

    await expect(fetchResultDoc('my-task', { fetchImpl, log })).resolves.toBeNull()
    expect(log).not.toHaveBeenCalled()
  })

  test('a server error rejects and logs a [result-doc] error', async () => {
    const log = vi.fn()
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))

    await expect(fetchResultDoc('my-task', { fetchImpl, log })).rejects.toThrow()
    expect(log).toHaveBeenCalledWith('[result-doc] load for my-task failed', expect.any(Error))
  })

  test('encodes the slug into the URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }))
    await fetchResultDoc('a/b', { fetchImpl, log: vi.fn() })
    expect(fetchImpl).toHaveBeenCalledWith('/result-doc/a%2Fb', expect.anything())
  })
})

describe('useResultDoc', () => {
  const META = { file: RESULT_DOC.file, isTruncated: RESULT_DOC.isTruncated, totalBytes: RESULT_DOC.totalBytes, mtimeMs: RESULT_DOC.mtimeMs }

  test('goes from loading to ready with the document', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, RESULT_DOC))
    const { result } = renderHook(() => useResultDoc('my-task', META, { fetchImpl, log: vi.fn() }), { wrapper: makeWrapper(new QueryClient()) })

    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.data).toEqual(RESULT_DOC)
  })

  test('an absent document is ready with null data, not a failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }))
    const { result } = renderHook(() => useResultDoc('my-task', META, { fetchImpl, log: vi.fn() }), { wrapper: makeWrapper(new QueryClient()) })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.data).toBeNull()
  })

  test('a failed load is reported as failed, and is not retried', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
    const { result } = renderHook(() => useResultDoc('my-task', META, { fetchImpl, log: vi.fn() }), { wrapper: makeWrapper(new QueryClient()) })

    await waitFor(() => expect(result.current.status).toBe('failed'))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('a snapshot tick that does not change this task\'s resultDoc metadata triggers no refetch', async () => {
    const queryClient = new QueryClient()
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, RESULT_DOC))
    renderHook(() => useResultDoc('my-task', META, { fetchImpl, log: vi.fn() }), { wrapper: makeWrapper(queryClient) })
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))

    // A snapshot tick unrelated to this task (a METRICS/STATUS update elsewhere)
    // must not re-download up to 512 KB for an open tab that has not changed.
    await act(async () => { queryClient.setQueryData(SNAPSHOT_QUERY_KEY, { tasks: [] }) })
    await act(async () => { queryClient.setQueryData(SNAPSHOT_QUERY_KEY, { tasks: [] }) })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('refetches when this task\'s resultDoc metadata changes (the document was rewritten)', async () => {
    const queryClient = new QueryClient()
    let markdown = '# v1'
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(200, { ...RESULT_DOC, markdown })))
    const { result, rerender } = renderHook(({ meta }) => useResultDoc('my-task', meta, { fetchImpl: fetchImpl as unknown as typeof fetch, log: vi.fn() }), {
      wrapper: makeWrapper(queryClient),
      initialProps: { meta: META },
    })
    await waitFor(() => expect(result.current.data?.markdown).toBe('# v1'))

    markdown = '# v2'
    rerender({ meta: { ...META, totalBytes: META.totalBytes + 1 } })
    expect(result.current.status).toBe('ready')
    await waitFor(() => expect(result.current.data?.markdown).toBe('# v2'))
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  test('refetches when the same file/isTruncated/totalBytes get a new mtimeMs (a same-byte-length edit)', async () => {
    const queryClient = new QueryClient()
    let markdown = '# The cat sat'
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(200, { ...RESULT_DOC, markdown })))
    const { result, rerender } = renderHook(({ meta }) => useResultDoc('my-task', meta, { fetchImpl: fetchImpl as unknown as typeof fetch, log: vi.fn() }), {
      wrapper: makeWrapper(queryClient),
      initialProps: { meta: META },
    })
    await waitFor(() => expect(result.current.data?.markdown).toBe('# The cat sat'))

    markdown = '# The dog ran'
    // file, isTruncated and totalBytes are all unchanged — only mtimeMs moved,
    // as a same-length word swap would leave it. Without mtimeMs in the key
    // this rerender would look identical and never refetch.
    rerender({ meta: { ...META, mtimeMs: META.mtimeMs + 1 } })
    await waitFor(() => expect(result.current.data?.markdown).toBe('# The dog ran'))
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  test('a refetch already in flight is superseded, not left to win, when the metadata changes again before it resolves', async () => {
    // TanStack Query only cancels an in-flight fetch for cancelRefetch:true
    // once the query already HAS data (query-core's own guard) — so the race
    // this closes is a second metadata change arriving while the refetch FROM
    // the first is still in flight, not the very first mount fetch.
    const queryClient = new QueryClient()
    const staleRefetch = deferred<Response>()
    let callCount = 0
    const fetchImpl = vi.fn(() => {
      callCount += 1
      if (callCount === 1) return Promise.resolve(jsonResponse(200, { ...RESULT_DOC, markdown: '# initial' }))
      if (callCount === 2) return staleRefetch.promise
      return Promise.resolve(jsonResponse(200, { ...RESULT_DOC, markdown: '# fresh' }))
    })
    const { result, rerender } = renderHook(({ meta }) => useResultDoc('my-task', meta, { fetchImpl: fetchImpl as unknown as typeof fetch, log: vi.fn() }), {
      wrapper: makeWrapper(queryClient),
      initialProps: { meta: META },
    })
    await waitFor(() => expect(result.current.data?.markdown).toBe('# initial'))

    // First metadata change starts a refetch that gets stuck.
    rerender({ meta: { ...META, mtimeMs: META.mtimeMs + 1 } })
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))

    // A second metadata change arrives before that refetch resolves.
    rerender({ meta: { ...META, mtimeMs: META.mtimeMs + 2 } })
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(result.current.data?.markdown).toBe('# fresh'))

    // The superseded refetch finally settles — its stale content must not
    // overwrite the fresh one that already landed.
    await act(async () => { staleRefetch.resolve(jsonResponse(200, { ...RESULT_DOC, markdown: '# stale' })) })
    expect(result.current.data?.markdown).toBe('# fresh')
  })

  test('retries when the metadata changes even though the previous fetch failed', async () => {
    const queryClient = new QueryClient()
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(jsonResponse(200, { ...RESULT_DOC, markdown: '# recovered' }))
    const { result, rerender } = renderHook(({ meta }) => useResultDoc('my-task', meta, { fetchImpl: fetchImpl as unknown as typeof fetch, log: vi.fn() }), {
      wrapper: makeWrapper(queryClient),
      initialProps: { meta: META },
    })
    await waitFor(() => expect(result.current.status).toBe('failed'))

    rerender({ meta: { ...META, mtimeMs: META.mtimeMs + 1 } })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.data?.markdown).toBe('# recovered')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  test('refetches when the metadata goes from a document to none', async () => {
    const queryClient = new QueryClient()
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, RESULT_DOC))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
    const { result, rerender } = renderHook(({ meta }) => useResultDoc('my-task', meta, { fetchImpl: fetchImpl as unknown as typeof fetch, log: vi.fn() }), {
      wrapper: makeWrapper(queryClient),
      initialProps: { meta: META as typeof META | null },
    })
    await waitFor(() => expect(result.current.data).toEqual(RESULT_DOC))

    rerender({ meta: null })
    await waitFor(() => expect(result.current.data).toBeNull())
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('fetchDocsGuide', () => {
  test('resolves the rendered guide html', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { html: '<h1>Guide</h1>' }))
    await expect(fetchDocsGuide({ fetchImpl, log: vi.fn() })).resolves.toBe('<h1>Guide</h1>')
    expect(fetchImpl).toHaveBeenCalledWith('/api/docs', { signal: undefined })
  })

  test.each([404, 500])('a %i is a failure — logged and thrown, never an empty guide', async (status) => {
    const log = vi.fn()
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status }))
    await expect(fetchDocsGuide({ fetchImpl, log })).rejects.toThrow()
    expect(log).toHaveBeenCalledWith('[docs] load of the guide failed', expect.any(Error))
  })
})

describe('useDocsGuide', () => {
  function wrapperFor(client: QueryClient) {
    return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }

  test('loads once and serves the cached guide to a later mount without asking again', async () => {
    const client = new QueryClient()
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { html: '<h1>Guide</h1>' }))

    const first = renderHook(() => useDocsGuide({ fetchImpl, log: vi.fn() }), { wrapper: wrapperFor(client) })
    await waitFor(() => expect(first.result.current).toEqual({ status: 'ready', data: '<h1>Guide</h1>' }))
    first.unmount()

    const second = renderHook(() => useDocsGuide({ fetchImpl, log: vi.fn() }), { wrapper: wrapperFor(client) })
    expect(second.result.current).toEqual({ status: 'ready', data: '<h1>Guide</h1>' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('a failed load reads as failed, and is retried the next time the page mounts', async () => {
    const client = new QueryClient()
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(jsonResponse(200, { html: '<h1>Guide</h1>' }))

    const first = renderHook(() => useDocsGuide({ fetchImpl, log: vi.fn() }), { wrapper: wrapperFor(client) })
    await waitFor(() => expect(first.result.current.status).toBe('failed'))
    first.unmount()

    const second = renderHook(() => useDocsGuide({ fetchImpl, log: vi.fn() }), { wrapper: wrapperFor(client) })
    await waitFor(() => expect(second.result.current).toEqual({ status: 'ready', data: '<h1>Guide</h1>' }))
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
