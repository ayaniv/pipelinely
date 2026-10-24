import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { BookmarkCard } from './BookmarkCard'
import type { BookmarkRecord } from './bookmarksModel'

const SESSION_ID = '0b5e2c1a-7d3f-4e8a-9c21-5f6a7b8c9d0e'
const NOW = new Date(2026, 9, 20, 12, 0)

function record(overrides: Partial<BookmarkRecord> = {}): BookmarkRecord {
  return {
    id: '20261004T000000Z-dddddd',
    kind: 'text',
    origin: 'answer',
    title: 'Shared parser',
    text: 'Prefer one shared parser.\n  - indented',
    note: '',
    tags: ['style'],
    project: 'invented-repo',
    taskTitle: 'Invented task title',
    source: { taskSlug: 'invented-task', sessionId: SESSION_ID },
    createdAt: new Date(2026, 9, 20, 10, 42).toISOString(),
    taskOnBoard: true,
    ...overrides,
  }
}

function renderCard(bookmark: BookmarkRecord, onDelete = vi.fn(), log = vi.fn()) {
  const router = createMemoryRouter([{ path: '*', element: <BookmarkCard bookmark={bookmark} now={NOW} onDelete={onDelete} log={log} /> }])
  render(<RouterProvider router={router} />)
  return { onDelete, log, router }
}

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('BookmarkCard', () => {
  test('says what it is, where it came from and when', () => {
    renderCard(record())

    expect(screen.getByTestId('bookmark-item')).toHaveAttribute('data-kind', 'answer')
    expect(screen.getByTestId('bookmark-item-kind')).toHaveTextContent('Answer')
    expect(screen.getByTestId('bookmark-item-source')).toHaveTextContent('Invented task title')
    expect(screen.getByTestId('bookmark-item-project')).toHaveTextContent('invented-repo')
    expect(screen.getByTestId('bookmark-item-date')).toHaveTextContent('today 10:42')
  })

  test('an M0-era text bookmark is a Quote that names its task by slug', () => {
    renderCard(record({ origin: undefined, project: undefined, taskTitle: undefined }))

    expect(screen.getByTestId('bookmark-item-kind')).toHaveTextContent('Quote')
    expect(screen.getByTestId('bookmark-item-source')).toHaveTextContent('invented-task')
    expect(screen.queryByTestId('bookmark-item-project')).toBeNull()
  })

  test('shows the text exactly as saved', () => {
    renderCard(record())
    expect(screen.getByTestId('bookmark-item-text').textContent).toBe('Prefer one shared parser.\n  - indented')
  })

  test('a long text is clamped until Show all, and Show less puts it back', () => {
    renderCard(record({ text: 'x'.repeat(400) }))
    const text = screen.getByTestId('bookmark-item-text')

    expect(text).toHaveAttribute('data-expanded', 'false')
    fireEvent.click(screen.getByTestId('bookmark-item-toggle'))
    expect(text).toHaveAttribute('data-expanded', 'true')
    expect(screen.getByTestId('bookmark-item-toggle')).toHaveTextContent('Show less')
    fireEvent.click(screen.getByTestId('bookmark-item-toggle'))
    expect(text).toHaveAttribute('data-expanded', 'false')
  })

  test('copy puts the exact text on the clipboard, says Copied, then reverts', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    renderCard(record())

    await act(async () => { fireEvent.click(screen.getByTestId('bookmark-item-copy')) })

    expect(writeText).toHaveBeenCalledWith('Prefer one shared parser.\n  - indented')
    expect(screen.getByTestId('bookmark-item-copy')).toHaveAttribute('data-state', 'copied')
    expect(screen.getByTestId('bookmark-item-copy')).toHaveTextContent('Copied')
    act(() => { vi.advanceTimersByTime(1400) })
    expect(screen.getByTestId('bookmark-item-copy')).toHaveAttribute('data-state', 'idle')
    expect(screen.getByTestId('bookmark-item-copy')).toHaveTextContent('Copy')
  })

  test('a clipboard that refuses is logged and shown on the button', async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error('denied')))
    const { log } = renderCard(record())

    await act(async () => { fireEvent.click(screen.getByTestId('bookmark-item-copy')) })

    expect(log).toHaveBeenCalledWith('[action] could not copy bookmark text', expect.any(Error))
    expect(screen.getByTestId('bookmark-item-copy')).toHaveAttribute('data-state', 'failed')
  })

  test('delete asks the page to delete this bookmark', () => {
    const bookmark = record()
    const { onDelete } = renderCard(bookmark)
    fireEvent.click(screen.getByTestId('bookmark-item-delete'))
    expect(onDelete).toHaveBeenCalledWith(bookmark)
  })

  test('a session whose task is on the board offers Open task and no Copy', () => {
    renderCard(record({ kind: 'session', origin: undefined, text: null, title: 'Where the gate went green' }))

    expect(screen.getByTestId('bookmark-item')).toHaveAttribute('data-kind', 'session')
    expect(screen.getByTestId('bookmark-item-open-task')).toHaveAttribute('href', '/task/invented-task')
    expect(screen.queryByTestId('bookmark-item-copy')).toBeNull()
    expect(screen.queryByTestId('bookmark-item-task-gone')).toBeNull()
    expect(screen.getByTestId('bookmark-item-title')).toHaveTextContent('Where the gate went green')
  })

  test('a session whose task is gone never offers Open or resume, and shows the session id', () => {
    renderCard(record({ kind: 'session', origin: undefined, text: null, taskOnBoard: false }))

    expect(screen.queryByTestId('bookmark-item-open-task')).toBeNull()
    expect(screen.getByTestId('bookmark-item-task-gone')).toBeInTheDocument()
    expect(screen.getByTestId('bookmark-item-session-id')).toHaveAttribute('data-session-id', SESSION_ID)
  })

  test('a title the text does not already start with is shown; a derived one is not repeated', () => {
    renderCard(record({ title: 'My own title' }))
    expect(screen.getByTestId('bookmark-item-title')).toHaveTextContent('My own title')
  })

  test('a title that is just the start of the text is not shown twice', () => {
    renderCard(record({ title: 'Prefer one shared parser.' }))
    expect(screen.queryByTestId('bookmark-item-title')).toBeNull()
  })

  test('shows the note and the tags', () => {
    renderCard(record({ note: 'for the style guide', tags: ['style', 'shell'] }))
    expect(screen.getByTestId('bookmark-item-note')).toHaveTextContent('for the style guide')
    expect(screen.getByTestId('bookmark-item-tags')).toHaveTextContent('#style')
    expect(screen.getByTestId('bookmark-item-tags')).toHaveTextContent('#shell')
  })
})
