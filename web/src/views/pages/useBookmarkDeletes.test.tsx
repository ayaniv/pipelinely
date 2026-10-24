import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { BOOKMARKS_QUERY_KEY, type BookmarksResponse } from '../../data/taskResources'
import { UNDO_WINDOW_MS, useBookmarkDeletes } from './useBookmarkDeletes'
import type { BookmarkRecord } from './bookmarksModel'

const ID = '20261004T000000Z-dddddd'
const OTHER_ID = '20261003T000000Z-cccccc'

function record(id: string, title: string): BookmarkRecord {
  return { id, kind: 'text', title, text: 'Invented.', note: '', tags: [], source: { taskSlug: null, sessionId: null }, createdAt: '2026-10-04T00:00:00.000Z', taskOnBoard: false }
}

let queryClient: QueryClient
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>

beforeEach(() => {
  vi.useFakeTimers()
  queryClient = new QueryClient()
  const seeded: BookmarksResponse = { bookmarks: [record(ID, 'First'), record(OTHER_ID, 'Second')], unreadable: [] }
  queryClient.setQueryData(BOOKMARKS_QUERY_KEY, seeded)
})
afterEach(() => { vi.useRealTimers() })

function setup(fetchImpl: typeof fetch) {
  const log = vi.fn()
  const hook = renderHook(() => useBookmarkDeletes({ fetchImpl, log }), { wrapper })
  return { ...hook, log }
}

describe('useBookmarkDeletes', () => {
  test('scheduling hides the bookmark at once and sends nothing yet', () => {
    const fetchImpl = vi.fn()
    const { result } = setup(fetchImpl)

    act(() => result.current.scheduleDelete(record(ID, 'First')))

    expect(result.current.pending.map((entry) => entry.id)).toEqual([ID])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('undo within the window cancels the delete for good', () => {
    const fetchImpl = vi.fn()
    const { result } = setup(fetchImpl)
    act(() => result.current.scheduleDelete(record(ID, 'First')))

    act(() => result.current.undoDelete(ID))
    act(() => { vi.advanceTimersByTime(UNDO_WINDOW_MS * 2) })

    expect(result.current.pending).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('when the window closes the file is deleted and the bookmark leaves the cache', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    const { result } = setup(fetchImpl)
    act(() => result.current.scheduleDelete(record(ID, 'First')))

    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS) })

    expect(fetchImpl).toHaveBeenCalledWith(`/api/bookmarks/${ID}`, { method: 'DELETE', keepalive: true })
    expect(result.current.pending).toEqual([])
    expect(queryClient.getQueryData<BookmarksResponse>(BOOKMARKS_QUERY_KEY)?.bookmarks.map((b) => b.id)).toEqual([OTHER_ID])
    expect(result.current.failedTitle).toBeNull()
  })

  test('a delete the server refuses brings the bookmark back and names it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
    const { result } = setup(fetchImpl)
    act(() => result.current.scheduleDelete(record(ID, 'First')))

    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS) })

    expect(result.current.pending).toEqual([])
    expect(result.current.failedTitle).toBe('First')
    expect(queryClient.getQueryData<BookmarksResponse>(BOOKMARKS_QUERY_KEY)?.bookmarks).toHaveLength(2)
  })

  test('two deletes keep their own windows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    const { result } = setup(fetchImpl)
    act(() => result.current.scheduleDelete(record(ID, 'First')))
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS / 2) })
    act(() => result.current.scheduleDelete(record(OTHER_ID, 'Second')))

    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS / 2) })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result.current.pending.map((entry) => entry.id)).toEqual([OTHER_ID])
  })

  test('leaving the page closes the window: what was deleted is not left half-deleted', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    const { result, unmount } = setup(fetchImpl)
    act(() => result.current.scheduleDelete(record(ID, 'First')))

    unmount()

    expect(fetchImpl).toHaveBeenCalledWith(`/api/bookmarks/${ID}`, { method: 'DELETE', keepalive: true })
  })

  test('closing the tab inside the window sends the delete too', () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    const { result } = setup(fetchImpl)
    act(() => result.current.scheduleDelete(record(ID, 'First')))

    window.dispatchEvent(new Event('pagehide'))

    expect(fetchImpl).toHaveBeenCalledWith(`/api/bookmarks/${ID}`, { method: 'DELETE', keepalive: true })
  })
})
