import { describe, expect, test } from 'vitest'
import {
  allTags,
  bookmarkCardKind,
  bookmarkProject,
  bookmarkSourceLabel,
  bookmarksView,
  filterBookmarks,
  formatBookmarkWhen,
  isLongBookmarkText,
  showsOwnBookmarkTitle,
  type BookmarkRecord,
} from './bookmarksModel'

// Every bookmark is invented.
const SESSION_ID = '0b5e2c1a-7d3f-4e8a-9c21-5f6a7b8c9d0e'

function record(overrides: Partial<BookmarkRecord> = {}): BookmarkRecord {
  return {
    id: '20261004T000000Z-dddddd',
    kind: 'text',
    title: 'Shared parser',
    text: 'Prefer one shared parser.',
    note: '',
    tags: [],
    source: { taskSlug: 'invented-task', sessionId: SESSION_ID },
    createdAt: '2026-10-04T00:00:00.000Z',
    taskOnBoard: true,
    ...overrides,
  }
}

describe('bookmarkCardKind', () => {
  test('a text bookmark saved as an answer is an answer', () => {
    expect(bookmarkCardKind(record({ origin: 'answer' }))).toBe('answer')
  })

  test('a text bookmark saved as a quote is a quote', () => {
    expect(bookmarkCardKind(record({ origin: 'quote' }))).toBe('quote')
  })

  test('an M0-era text bookmark, with no origin, shows as a quote', () => {
    expect(bookmarkCardKind(record())).toBe('quote')
  })

  test('a session bookmark is a session', () => {
    expect(bookmarkCardKind(record({ kind: 'session', text: null }))).toBe('session')
  })
})

describe('what a card says it came from', () => {
  test('uses the task title and project snapshots', () => {
    const saved = record({ taskTitle: 'Invented task title', project: 'invented-repo' })
    expect(bookmarkSourceLabel(saved)).toBe('Invented task title')
    expect(bookmarkProject(saved)).toBe('invented-repo')
  })

  test('falls back to the task slug when there is no snapshot', () => {
    expect(bookmarkSourceLabel(record())).toBe('invented-task')
  })

  test('falls back to the bookmark title when it came from no task', () => {
    expect(bookmarkSourceLabel(record({ source: { taskSlug: null, sessionId: null } }))).toBe('Shared parser')
  })

  test('has no project to show without a snapshot', () => {
    expect(bookmarkProject(record())).toBeNull()
  })
})

describe('filterBookmarks', () => {
  const answer = record({ id: 'a', origin: 'answer', tags: ['billing', 'stripe'], taskTitle: 'Split invoices', project: 'web-app' })
  const quote = record({ id: 'q', origin: 'quote', tags: ['copy'], text: 'Owners can change anyone’s role.' })
  const session = record({ id: 's', kind: 'session', text: null, title: 'Guest checkout', tags: ['billing'], note: 'revisit friday' })
  const all = [answer, quote, session]
  const none = { query: '', kind: 'all' as const, tags: [] as string[] }
  const ids = (list: BookmarkRecord[]) => list.map((entry) => entry.id)

  test('with no filters keeps everything in order', () => {
    expect(ids(filterBookmarks(all, none))).toEqual(['a', 'q', 's'])
  })

  test('filters by kind, with M0-era text counting as a quote', () => {
    expect(ids(filterBookmarks(all, { ...none, kind: 'answer' }))).toEqual(['a'])
    expect(ids(filterBookmarks(all, { ...none, kind: 'quote' }))).toEqual(['q'])
    expect(ids(filterBookmarks(all, { ...none, kind: 'session' }))).toEqual(['s'])
  })

  test('a bookmark must have every selected tag', () => {
    expect(ids(filterBookmarks(all, { ...none, tags: ['billing'] }))).toEqual(['a', 's'])
    expect(ids(filterBookmarks(all, { ...none, tags: ['billing', 'stripe'] }))).toEqual(['a'])
    expect(ids(filterBookmarks(all, { ...none, tags: ['stripe', 'copy'] }))).toEqual([])
  })

  test.each([
    ['text', 'CHANGE ANYONE'],
    ['task title', 'split invoices'],
    ['project', 'WEB-APP'],
    ['session id', '5f6a7b8c9d0e'],
    ['a tag', 'stripe'],
    ['the title', 'guest checkout'],
  ])('search is case-insensitive over the %s', (_field, query) => {
    expect(filterBookmarks(all, { ...none, query }).length).toBeGreaterThan(0)
  })

  test('search does not look in the note, which the card does not show as a match reason', () => {
    expect(filterBookmarks(all, { ...none, query: 'revisit friday' })).toEqual([])
  })

  test('search, kind and tags must all pass', () => {
    expect(ids(filterBookmarks(all, { query: 'invoices', kind: 'answer', tags: ['billing'] }))).toEqual(['a'])
    expect(ids(filterBookmarks(all, { query: 'invoices', kind: 'quote', tags: ['billing'] }))).toEqual([])
  })

  test('a blank search matches everything', () => {
    expect(filterBookmarks(all, { ...none, query: '   ' })).toHaveLength(3)
  })
})

describe('allTags', () => {
  test('lists each tag in use once, sorted', () => {
    expect(allTags([record({ tags: ['b', 'a'] }), record({ tags: ['b', 'c'] })])).toEqual(['a', 'b', 'c'])
  })
})

describe('bookmarksView', () => {
  test.each([
    [{ isLoading: true, hasFailed: false, total: 0, shown: 0 }, 'loading'],
    [{ isLoading: false, hasFailed: true, total: 0, shown: 0 }, 'failed'],
    [{ isLoading: false, hasFailed: false, total: 0, shown: 0 }, 'empty'],
    [{ isLoading: false, hasFailed: false, total: 3, shown: 0 }, 'no-matches'],
    [{ isLoading: false, hasFailed: false, total: 3, shown: 2 }, 'list'],
  ] as const)('%j is %s', (input, expected) => {
    expect(bookmarksView(input)).toBe(expected)
  })
})

describe('formatBookmarkWhen', () => {
  const now = new Date(2026, 9, 20, 12, 0)

  test('today shows the time', () => {
    expect(formatBookmarkWhen(new Date(2026, 9, 20, 10, 42).toISOString(), now)).toBe('today 10:42')
  })

  test('yesterday shows the time', () => {
    expect(formatBookmarkWhen(new Date(2026, 9, 19, 18, 3).toISOString(), now)).toBe('yesterday 18:03')
  })

  test('older shows the month and day', () => {
    expect(formatBookmarkWhen(new Date(2026, 9, 6, 9, 0).toISOString(), now)).toBe('Oct 6')
  })

  test('an unparseable date is a dash, never "Invalid Date"', () => {
    expect(formatBookmarkWhen('not a date', now)).toBe('—')
  })
})

describe('isLongBookmarkText', () => {
  test('clamps text over 260 characters', () => {
    expect(isLongBookmarkText('x'.repeat(260))).toBe(false)
    expect(isLongBookmarkText('x'.repeat(261))).toBe(true)
  })
})

describe('showsOwnBookmarkTitle', () => {
  test('a session shows its title: it is all it has', () => {
    expect(showsOwnBookmarkTitle(record({ kind: 'session', text: null, title: 'Where the gate went green' }))).toBe(true)
  })

  test('a text bookmark whose title is just the start of its text does not repeat it', () => {
    expect(showsOwnBookmarkTitle(record({ title: 'Prefer one shared parser.', text: 'Prefer one shared parser.\nMore.' }))).toBe(false)
    expect(showsOwnBookmarkTitle(record({ title: `${'x'.repeat(79)}…`, text: 'x'.repeat(200) }))).toBe(false)
  })

  test('a text bookmark saved under its own title shows it', () => {
    expect(showsOwnBookmarkTitle(record({ title: 'Parser rule', text: 'Prefer one shared parser.' }))).toBe(true)
  })
})
