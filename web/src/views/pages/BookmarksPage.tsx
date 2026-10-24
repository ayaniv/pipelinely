import { useMemo, useState } from 'react'
import type { PostActionOptions } from '../../api/actions'
import { SearchIcon } from '../../components/icons'
import { useBookmarks } from '../../data/taskResources'
import { BookmarkCard } from './BookmarkCard'
import {
  allTags,
  bookmarksView,
  filterBookmarks,
  type BookmarkKindFilter,
  type BookmarkRecord,
} from './bookmarksModel'
import { useBookmarkDeletes } from './useBookmarkDeletes'
import { FullPage } from './FullPage'

// The Bookmarks page: everything saved with /pipelinely-bookmark, read from
// the files on this Mac through GET /api/bookmarks (loopback only). Search,
// the kind control and the tag chips combine; a bookmark must pass all three.

const BOOKMARKS_PATH = '~/.config/pipelinely/bookmarks/'
const SAVE_COMMAND = '/pipelinely-bookmark'

const KIND_FILTERS: { kind: BookmarkKindFilter; label: string }[] = [
  { kind: 'all', label: 'All' },
  { kind: 'answer', label: 'Answers' },
  { kind: 'quote', label: 'Quotes' },
  { kind: 'session', label: 'Sessions' },
]

function BookmarksHeaderNote() {
  return <span className="bookmarks-subtitle">Saved on this Mac in <span className="bookmarks-path" data-testid="bookmarks-path">{BOOKMARKS_PATH}</span>. Never committed or uploaded.</span>
}

function SaveHint() {
  return (
    <div className="bookmarks-save-hint" data-testid="bookmarks-save-hint" title="Run this in any Claude tab to save">
      <span>Save from Claude with</span>
      <span className="bookmarks-save-command">{SAVE_COMMAND}</span>
    </div>
  )
}

function UndoToasts({ pending, onUndo }: { pending: { id: string; title: string }[]; onUndo: (id: string) => void }) {
  if (pending.length === 0) return null
  return (
    <div className="bookmark-toasts" role="status" aria-live="polite">
      {pending.map(({ id, title }) => (
        <div className="bookmark-undo-toast" key={id} data-testid="bookmark-undo-toast" data-id={id}>
          <span className="bookmark-undo-message">Deleted “{title}”</span>
          <button type="button" className="bookmark-undo-btn" data-testid="bookmark-undo-btn" onClick={() => onUndo(id)}>Undo</button>
        </div>
      ))}
    </div>
  )
}

export function BookmarksPage({ fetchImpl, log }: Partial<PostActionOptions> = {}) {
  const bookmarksState = useBookmarks({ fetchImpl, log })
  const { pending, failedTitle, scheduleDelete, undoDelete } = useBookmarkDeletes({ fetchImpl, log })
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<BookmarkKindFilter>('all')
  const [selectedTags, setSelectedTags] = useState<string[]>([])

  const pendingIds = useMemo(() => new Set(pending.map((entry) => entry.id)), [pending])
  // A bookmark waiting out its undo window is already gone from the page.
  const bookmarks: BookmarkRecord[] = useMemo(
    () => (bookmarksState.data?.bookmarks ?? []).filter((bookmark) => !pendingIds.has(bookmark.id)),
    [bookmarksState.data, pendingIds],
  )
  const tags = useMemo(() => allTags(bookmarks), [bookmarks])
  const shown = useMemo(() => filterBookmarks(bookmarks, { query, kind, tags: selectedTags }), [bookmarks, query, kind, selectedTags])
  const unreadable = bookmarksState.data?.unreadable ?? []
  const view = bookmarksView({ isLoading: bookmarksState.status === 'loading', hasFailed: bookmarksState.status === 'failed', total: bookmarks.length, shown: shown.length })

  const toggleTag = (tag: string) => setSelectedTags((current) => (current.includes(tag) ? current.filter((entry) => entry !== tag) : [...current, tag]))

  const renderBody = () => {
    switch (view) {
      case 'loading':
        return <div className="bookmarks-state" data-testid="bookmarks-loading">Loading bookmarks…</div>
      case 'failed':
        return (
          <div className="bookmarks-state is-error" data-testid="bookmarks-load-error" role="alert">
            {bookmarksState.isForbidden ? 'Bookmarks are only available on this Mac.' : 'Could not load the bookmarks. Check the console, then reload.'}
          </div>
        )
      case 'empty':
        return <div className="bookmarks-state" data-testid="bookmarks-empty">Nothing saved here yet. Type <code>{SAVE_COMMAND}</code> in any Claude tab.</div>
      case 'no-matches':
        return <div className="bookmarks-state" data-testid="bookmarks-no-matches">No bookmarks match.</div>
      case 'list':
        return (
          <div className="bookmark-list">
            {shown.map((bookmark) => <BookmarkCard key={bookmark.id} bookmark={bookmark} onDelete={scheduleDelete} log={log} />)}
          </div>
        )
    }
  }

  return (
    <FullPage pageId="bookmarks-page" title="Bookmarks" subtitle={<BookmarksHeaderNote />} headerAside={<SaveHint />}>
      <div className="bookmarks-controls">
        <label className="bookmarks-search">
          <SearchIcon />
          <input
            type="search"
            data-testid="bookmarks-search"
            aria-label="Search bookmarks"
            placeholder="Search bookmarks"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="bookmarks-kind-control" role="group" aria-label="Kind">
          {KIND_FILTERS.map(({ kind: filterKind, label }) => (
            <button
              key={filterKind}
              type="button"
              className={`bookmarks-kind-btn${kind === filterKind ? ' is-active' : ''}`}
              data-testid={`bookmarks-kind-filter-${filterKind}`}
              aria-pressed={kind === filterKind}
              onClick={() => setKind(filterKind)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {tags.length > 0 && (
        <div className="bookmarks-tags">
          <span className="bookmarks-tags-label">tags</span>
          {tags.map((tag) => (
            <button
              key={tag}
              type="button"
              className={`bookmarks-tag-chip${selectedTags.includes(tag) ? ' is-active' : ''}`}
              data-testid="bookmarks-tag-filter"
              data-tag={tag}
              aria-pressed={selectedTags.includes(tag)}
              onClick={() => toggleTag(tag)}
            >
              #{tag}
            </button>
          ))}
        </div>
      )}

      {unreadable.length > 0 && (
        <div className="bookmarks-state is-warning" data-testid="bookmarks-unreadable-notice" data-count={unreadable.length}>
          {unreadable.length} bookmark file{unreadable.length === 1 ? '' : 's'} could not be read and {unreadable.length === 1 ? 'was' : 'were'} left untouched.
        </div>
      )}
      {failedTitle !== null && (
        <div className="bookmarks-state is-error" data-testid="bookmark-delete-error" role="alert">Could not delete “{failedTitle}”. It is back in the list.</div>
      )}

      {renderBody()}
      <UndoToasts pending={pending} onUndo={undoDelete} />
    </FullPage>
  )
}
