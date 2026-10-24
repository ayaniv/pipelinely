import { useState, type ComponentType } from 'react'
import { Link } from 'react-router'
import { AnswerKindIcon, CopyIcon, QuoteKindIcon, SessionKindIcon, TrashIcon } from '../../components/icons'
import type { FlashClass } from '../../components/useActionFlash'
import { useClipboardCopy } from '../../components/useClipboardCopy'
import type { Logger } from '../../log'
import { taskUrl } from '../../shell/routes'
import {
  bookmarkCardKind,
  bookmarkProject,
  bookmarkSourceLabel,
  formatBookmarkWhen,
  isLongBookmarkText,
  showsOwnBookmarkTitle,
  type BookmarkCardKind,
  type BookmarkRecord,
} from './bookmarksModel'

// One saved bookmark: what it is, where it came from, its text and the three
// things you can do with it. Text is shown exactly as saved (pre-wrap, nothing
// trimmed). A session never offers to resume a conversation: it links to its
// task while the task is on the board, and otherwise says the task is gone.

const COPIED_MS = 1400

const KIND_LABEL: Record<BookmarkCardKind, string> = { answer: 'Answer', quote: 'Quote', session: 'Session' }
type CopyState = 'idle' | 'copied' | 'failed'

function copyStateOf(flashClassName: FlashClass): CopyState {
  switch (flashClassName) {
    case 'btn-ok':
      return 'copied'
    case 'btn-err':
      return 'failed'
    default:
      return 'idle'
  }
}

const KIND_ICON: Record<BookmarkCardKind, ComponentType> = { answer: AnswerKindIcon, quote: QuoteKindIcon, session: SessionKindIcon }

export interface BookmarkCardProps {
  bookmark: BookmarkRecord
  onDelete: (bookmark: BookmarkRecord) => void
  now?: Date
  log?: Logger
}

function SessionStrip({ bookmark }: { bookmark: BookmarkRecord }) {
  const hasTask = bookmark.source.taskSlug !== null
  return (
    <div className="bookmark-gone" data-testid="bookmark-item-task-gone">
      <span>{hasTask ? 'This task is no longer on the board.' : 'Saved outside a task tab.'}</span>
      <span className="bookmark-gone-session" data-testid="bookmark-item-session-id" data-session-id={bookmark.source.sessionId ?? ''}>session {bookmark.source.sessionId}</span>
    </div>
  )
}

export function BookmarkCard({ bookmark, onDelete, now, log = console.error }: BookmarkCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const { flash, isPending, copy } = useClipboardCopy(log)
  const kind = bookmarkCardKind(bookmark)
  const KindIcon = KIND_ICON[kind]
  const project = bookmarkProject(bookmark)
  const { text } = bookmark
  const taskSlug = bookmark.source.taskSlug
  const isLong = text !== null && isLongBookmarkText(text)
  const canOpenTask = kind === 'session' && bookmark.taskOnBoard && taskSlug !== null
  const isTaskGone = kind === 'session' && !canOpenTask

  return (
    <article className="bookmark-card" data-testid="bookmark-item" data-id={bookmark.id} data-kind={kind}>
      <div className="bookmark-card-top">
        <span className="bookmark-kind-badge" data-testid="bookmark-item-kind"><KindIcon /><span>{KIND_LABEL[kind]}</span></span>
        <span className="bookmark-source" data-testid="bookmark-item-source" title={bookmarkSourceLabel(bookmark)}>{bookmarkSourceLabel(bookmark)}</span>
        <span className="bookmark-meta">
          {project !== null && <><span data-testid="bookmark-item-project">{project}</span> · </>}
          <time dateTime={bookmark.createdAt} data-testid="bookmark-item-date">{formatBookmarkWhen(bookmark.createdAt, now)}</time>
        </span>
        <div className="bookmark-actions">
          {text !== null && (
            <button
              type="button"
              className="bookmark-action-btn"
              data-testid="bookmark-item-copy"
              data-state={copyStateOf(flash.className)}
              disabled={isPending}
              onClick={() => void copy(text, { description: 'bookmark text', copiedLabel: 'Copied', copiedMs: COPIED_MS, failedLabel: 'Copy failed' })}
            >
              <CopyIcon />
              <span>{flash.label ?? 'Copy'}</span>
            </button>
          )}
          {canOpenTask && (
            <Link className="bookmark-open-btn" to={taskUrl(taskSlug)} data-testid="bookmark-item-open-task">Open task</Link>
          )}
          <button type="button" className="bookmark-delete-btn" data-testid="bookmark-item-delete" aria-label="Delete bookmark" title="Delete bookmark" onClick={() => onDelete(bookmark)}>
            <TrashIcon />
          </button>
        </div>
      </div>

      {showsOwnBookmarkTitle(bookmark) && <div className="bookmark-title" data-testid="bookmark-item-title">{bookmark.title}</div>}

      {text !== null && (
        <>
          <div className={`bookmark-text${kind === 'quote' ? ' is-quote' : ''}`} data-testid="bookmark-item-text" data-expanded={String(isExpanded || !isLong)}>{text}</div>
          {isLong && (
            <button type="button" className="bookmark-toggle" data-testid="bookmark-item-toggle" onClick={() => setIsExpanded((wasExpanded) => !wasExpanded)}>
              {isExpanded ? 'Show less' : 'Show all'}
            </button>
          )}
        </>
      )}

      {isTaskGone && <SessionStrip bookmark={bookmark} />}
      {bookmark.note !== '' && <div className="bookmark-note" data-testid="bookmark-item-note">{bookmark.note}</div>}
      {bookmark.tags.length > 0 && (
        <div className="bookmark-tags" data-testid="bookmark-item-tags">
          {bookmark.tags.map((tag) => <span key={tag}>#{tag}</span>)}
        </div>
      )}
    </article>
  )
}
