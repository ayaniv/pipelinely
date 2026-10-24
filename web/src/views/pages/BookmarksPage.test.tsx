import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { BookmarksPage } from './BookmarksPage'
import { UNDO_WINDOW_MS } from './useBookmarkDeletes'
import type { BookmarkRecord } from './bookmarksModel'

const SESSION_ID = '0b5e2c1a-7d3f-4e8a-9c21-5f6a7b8c9d0e'

function record(id: string, overrides: Partial<BookmarkRecord> = {}): BookmarkRecord {
  return {
    id, kind: 'text', origin: 'quote', title: `Title ${id}`, text: `Text ${id}`, note: '', tags: [],
    source: { taskSlug: 'invented-task', sessionId: SESSION_ID }, createdAt: '2026-10-04T00:00:00.000Z', taskOnBoard: true, ...overrides,
  }
}

const ANSWER = record('20261004T000000Z-dddddd', { origin: 'answer', tags: ['billing', 'stripe'], title: 'Split invoices', text: 'Split before finalising.' })
const QUOTE = record('20261003T000000Z-cccccc', { tags: ['copy'], text: 'Owners can change roles.' })
const SESSION = record('20261002T000000Z-bbbbbb', { kind: 'session', origin: undefined, text: null, tags: ['billing'], title: 'Guest checkout' })

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function renderPage(fetchImpl: typeof fetch) {
  const log = vi.fn()
  const router = createMemoryRouter([{ path: '*', element: <BookmarksPage fetchImpl={fetchImpl} log={log} /> }], { initialEntries: ['/bookmarks'] })
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { log }
}

function listing(bookmarks: BookmarkRecord[], unreadable: string[] = []) {
  return vi.fn().mockResolvedValue(jsonResponse(200, { bookmarks, unreadable }))
}

const visibleIds = () => screen.queryAllByTestId('bookmark-item').map((node) => node.getAttribute('data-id'))

afterEach(() => { vi.useRealTimers() })

describe('BookmarksPage states', () => {
  test('shows a loading state before the first response', () => {
    renderPage(vi.fn(() => new Promise<Response>(() => undefined)))
    expect(screen.getByTestId('bookmarks-loading')).toBeInTheDocument()
  })

  test('nothing saved yet: the empty state names the skill', async () => {
    renderPage(listing([]))
    expect(await screen.findByTestId('bookmarks-empty')).toHaveTextContent('/pipelinely-bookmark')
    expect(screen.queryByTestId('bookmarks-no-matches')).toBeNull()
  })

  test('a failed load is an error, not an empty page, and is logged', async () => {
    const { log } = renderPage(vi.fn().mockResolvedValue(new Response(null, { status: 500 })))
    expect(await screen.findByTestId('bookmarks-load-error')).toBeInTheDocument()
    expect(screen.queryByTestId('bookmarks-empty')).toBeNull()
    expect(log).toHaveBeenCalled()
  })

  test('a refusal (a phone) says bookmarks are on this Mac only', async () => {
    renderPage(vi.fn().mockResolvedValue(new Response(null, { status: 403 })))
    expect(await screen.findByTestId('bookmarks-load-error')).toHaveTextContent('this Mac')
  })

  test('unreadable files are counted above the list, which still shows', async () => {
    renderPage(listing([ANSWER], ['20261005T000000Z-eeeeee.json']))
    expect(await screen.findByTestId('bookmarks-unreadable-notice')).toHaveAttribute('data-count', '1')
    expect(visibleIds()).toEqual([ANSWER.id])
  })

  test('says where bookmarks are kept and how to save one', async () => {
    renderPage(listing([ANSWER]))
    await screen.findByTestId('bookmark-item')
    expect(screen.getByTestId('bookmarks-path')).toHaveTextContent('~/.config/pipelinely/bookmarks/')
    expect(screen.getByTestId('bookmarks-save-hint')).toHaveTextContent('/pipelinely-bookmark')
  })
})

describe('BookmarksPage filters', () => {
  beforeEach(() => { /* real timers: filtering is synchronous */ })

  test('kind, tags (all of them) and search combine', async () => {
    renderPage(listing([ANSWER, QUOTE, SESSION]))
    await screen.findAllByTestId('bookmark-item')
    expect(visibleIds()).toEqual([ANSWER.id, QUOTE.id, SESSION.id])

    fireEvent.click(screen.getByTestId('bookmarks-kind-filter-session'))
    expect(visibleIds()).toEqual([SESSION.id])
    fireEvent.click(screen.getByTestId('bookmarks-kind-filter-all'))

    const tag = (name: string) => screen.getAllByTestId('bookmarks-tag-filter').find((chip) => chip.getAttribute('data-tag') === name)!
    fireEvent.click(tag('billing'))
    expect(visibleIds()).toEqual([ANSWER.id, SESSION.id])
    fireEvent.click(tag('stripe'))
    expect(visibleIds()).toEqual([ANSWER.id])
    expect(tag('stripe')).toHaveAttribute('aria-pressed', 'true')

    fireEvent.change(screen.getByTestId('bookmarks-search'), { target: { value: 'owners' } })
    expect(visibleIds()).toEqual([])
    expect(screen.getByTestId('bookmarks-no-matches')).toBeInTheDocument()
    expect(screen.queryByTestId('bookmarks-empty')).toBeNull()
  })

  test('a tag chip per tag in use, each listed once', async () => {
    renderPage(listing([ANSWER, QUOTE, SESSION]))
    await screen.findAllByTestId('bookmark-item')
    const tags = screen.getAllByTestId('bookmarks-tag-filter').map((chip) => chip.getAttribute('data-tag'))
    expect(tags).toEqual(['billing', 'copy', 'stripe'])
  })
})

describe('BookmarksPage delete with undo', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })

  function deletableFetch() {
    return vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve(init?.method === 'DELETE' ? new Response(null, { status: 204 }) : jsonResponse(200, { bookmarks: [ANSWER, QUOTE], unreadable: [] })))
  }

  test('hides the card with an undo toast, and deletes only when the window closes', async () => {
    const fetchImpl = deletableFetch()
    renderPage(fetchImpl as unknown as typeof fetch)
    await screen.findAllByTestId('bookmark-item')

    fireEvent.click(within(screen.getAllByTestId('bookmark-item')[1]).getByTestId('bookmark-item-delete'))

    expect(visibleIds()).toEqual([ANSWER.id])
    expect(screen.getByTestId('bookmark-undo-toast')).toBeInTheDocument()
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)

    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS) })

    expect(fetchImpl).toHaveBeenCalledWith(`/api/bookmarks/${QUOTE.id}`, { method: 'DELETE', keepalive: true })
    expect(screen.queryByTestId('bookmark-undo-toast')).toBeNull()
  })

  test('undo brings the card back and nothing is deleted', async () => {
    const fetchImpl = deletableFetch()
    renderPage(fetchImpl as unknown as typeof fetch)
    await screen.findAllByTestId('bookmark-item')

    fireEvent.click(within(screen.getAllByTestId('bookmark-item')[1]).getByTestId('bookmark-item-delete'))
    fireEvent.click(screen.getByTestId('bookmark-undo-btn'))
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS * 2) })

    expect(visibleIds()).toEqual([ANSWER.id, QUOTE.id])
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
  })

  test('a refused delete returns the card and shows the error', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve(init?.method === 'DELETE' ? new Response(null, { status: 500 }) : jsonResponse(200, { bookmarks: [ANSWER, QUOTE], unreadable: [] })))
    renderPage(fetchImpl as unknown as typeof fetch)
    await screen.findAllByTestId('bookmark-item')

    fireEvent.click(within(screen.getAllByTestId('bookmark-item')[1]).getByTestId('bookmark-item-delete'))
    await act(async () => { await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS) })

    await waitFor(() => expect(screen.getByTestId('bookmark-delete-error')).toBeInTheDocument())
    expect(visibleIds()).toEqual([ANSWER.id, QUOTE.id])
  })
})
