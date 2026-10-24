import type { Bookmark } from '../../../../src/bookmarks'

// The Bookmarks page's pure half: what a card calls itself, which cards a
// filter keeps, which of the page's mutually exclusive states shows, and how a
// date reads. The page component only renders what these decide.

// What GET /api/bookmarks sends. `taskOnBoard` is worked out by the server on
// every list; it is never in the file.
export interface BookmarkRecord extends Bookmark {
  taskOnBoard: boolean
}

export type BookmarkCardKind = 'answer' | 'quote' | 'session'
export type BookmarkKindFilter = 'all' | BookmarkCardKind

export interface BookmarkFilters {
  query: string
  kind: BookmarkKindFilter
  // The tags a bookmark must ALL have.
  tags: string[]
}

export type BookmarksViewState = 'loading' | 'failed' | 'empty' | 'no-matches' | 'list'

// Beyond this many characters an answer or quote is clamped to a few lines.
const LONG_TEXT_LENGTH = 260
const MS_PER_DAY = 86_400_000
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function bookmarkCardKind(bookmark: BookmarkRecord): BookmarkCardKind {
  if (bookmark.kind === 'session') return 'session'
  // A text bookmark saved before origin existed can't be told from a quote.
  return bookmark.origin === 'answer' ? 'answer' : 'quote'
}

// The task title it was saved under; the slug for a file written before the
// snapshot existed; its own title when it came from no task at all.
export function bookmarkSourceLabel(bookmark: BookmarkRecord): string {
  return bookmark.taskTitle ?? bookmark.source.taskSlug ?? bookmark.title
}

export function bookmarkProject(bookmark: BookmarkRecord): string | null {
  return bookmark.project ?? null
}

// A text bookmark's default title is the start of its text, which the card
// already shows; only a title the developer chose (and a session's, which is
// all it has) earns a line of its own.
export function showsOwnBookmarkTitle(bookmark: BookmarkRecord): boolean {
  if (bookmark.text === null) return true
  const derivedStart = bookmark.title.replace(/…$/, '')
  return !bookmark.text.trimStart().startsWith(derivedStart)
}

export function isLongBookmarkText(text: string): boolean {
  return text.length > LONG_TEXT_LENGTH
}

export function allTags(bookmarks: BookmarkRecord[]): string[] {
  return [...new Set(bookmarks.flatMap((bookmark) => bookmark.tags))].sort()
}

function searchableText(bookmark: BookmarkRecord): string {
  return [bookmark.title, bookmark.text, bookmark.taskTitle, bookmark.project, bookmark.source.sessionId, ...bookmark.tags]
    .filter((part): part is string => typeof part === 'string')
    .join('\n')
    .toLowerCase()
}

// A bookmark must pass the search, the kind and every selected tag.
export function filterBookmarks(bookmarks: BookmarkRecord[], { query, kind, tags }: BookmarkFilters): BookmarkRecord[] {
  const needle = query.trim().toLowerCase()
  return bookmarks.filter((bookmark) =>
    (kind === 'all' || bookmarkCardKind(bookmark) === kind)
    && tags.every((tag) => bookmark.tags.includes(tag))
    && (needle === '' || searchableText(bookmark).includes(needle)))
}

export function bookmarksView({ isLoading, hasFailed, total, shown }: { isLoading: boolean; hasFailed: boolean; total: number; shown: number }): BookmarksViewState {
  if (isLoading) return 'loading'
  if (hasFailed) return 'failed'
  if (total === 0) return 'empty'
  return shown === 0 ? 'no-matches' : 'list'
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function clockTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

// "today 10:42", "yesterday 18:03", then "Oct 6". `now` is a parameter so a
// test needs no fake clock.
export function formatBookmarkWhen(iso: string, now: Date = new Date()): string {
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return '—'
  const daysAgo = Math.round((startOfDay(now) - startOfDay(when)) / MS_PER_DAY)
  if (daysAgo === 0) return `today ${clockTime(when)}`
  if (daysAgo === 1) return `yesterday ${clockTime(when)}`
  return `${SHORT_MONTHS[when.getMonth()]} ${when.getDate()}`
}
