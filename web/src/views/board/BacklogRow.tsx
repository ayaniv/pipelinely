import type { MouseEvent, ReactNode } from 'react'
import type { BacklogItem } from '../../../../src/types'
import { postBacklogDispatch, postBacklogResume } from '../../api/backlogActions'
import type { PostActionOptions } from '../../api/actions'
import { EditIcon, PlayIcon, TrashIcon } from '../../components/icons'
import { READ_ONLY_INSTANCE_TITLE } from '../../components/readOnly'
import { ERROR_FLASH_MS, useActionFlash } from '../../components/useActionFlash'

// How long a Resume failure stays up: the server's message is worth reading
// in full ("that task directory is gone"), so it outlasts an ordinary error.
const RESUME_ERROR_FLASH_MS = 6000

interface RowActionProps extends PostActionOptions {
  item: BacklogItem
}

// Run: pastes the item into the orchestrator session. Disabled outright on a
// non-canonical instance (a disabled button can't swallow a click mid-render,
// and the read-only reason is its tooltip).
function RunButton({ item, index, isCanonical, isStaged, fetchImpl, log }: RowActionProps & { index: number; isCanonical: boolean; isStaged: boolean }) {
  const { flash, showOutcome, isPending, run } = useActionFlash(log)
  const dispatch = () => run(async () => showOutcome(await postBacklogDispatch(item, { fetchImpl, log }), ERROR_FLASH_MS))
  // A batch dispatch marks each of its rows staged from the outside; the
  // button's own click outcome takes precedence while it is showing.
  const className = flash.className || (isStaged ? 'btn-ok' : '')
  return (
    <button
      type="button" className={`backlog-row-run ${className}`.trim()} data-testid="backlog-play-btn" data-index={index}
      disabled={!isCanonical || isPending} title={isCanonical ? undefined : READ_ONLY_INSTANCE_TITLE} onClick={dispatch}
    >
      {flash.label ?? (isStaged ? 'staged' : <><PlayIcon /><span>run</span></>)}
    </button>
  )
}

// Resume, for a shelved entry: it already has a task dir, branch and plan, so
// it goes straight back on the board instead of being pasted at the
// orchestrator to start over. Never touches the orchestrator session, so it
// is not canonical-gated the way Run is.
function ResumeButton({ item, index, onResumed, fetchImpl, log }: RowActionProps & { index: number; onResumed: () => void }) {
  const { flash, show, isPending, run } = useActionFlash(log)
  const resume = () => run(async () => {
    const outcome = await postBacklogResume(index, item, { fetchImpl, log })
    if (!outcome.ok) {
      show('btn-err', outcome.label, RESUME_ERROR_FLASH_MS)
      return
    }
    show('btn-ok', outcome.label)
    // The restored card lands on In Progress, so follow it there rather than
    // leaving the developer looking at the row that just disappeared.
    onResumed()
  })
  return (
    <button type="button" className={`backlog-row-run ${flash.className}`.trim()} data-testid="backlog-resume-btn" data-index={index} disabled={isPending} onClick={resume}>
      {flash.label ?? <><PlayIcon /><span>resume</span></>}
    </button>
  )
}

export interface BacklogRowProps extends PostActionOptions {
  item: BacklogItem
  // Position in the UNFILTERED backlog — what every server route takes.
  index: number
  isSelected: boolean
  isStaged: boolean
  isCanonical: boolean
  isDeleting: boolean
  // The reason this row's last delete failed, while it is being flashed.
  deleteFailureLabel: string | null
  // Set while this row is being edited: replaces the row's body.
  editForm: ReactNode | null
  onToggleSelected: () => void
  onStartEdit: () => void
  onRequestDelete: () => void
  onOpenTask: (slug: string) => void
  onResumed: () => void
}

export function BacklogRow({
  item, index, isSelected, isStaged, isCanonical, isDeleting, deleteFailureLabel, editForm,
  onToggleSelected, onStartEdit, onRequestDelete, onOpenTask, onResumed, fetchImpl, log,
}: BacklogRowProps) {
  // Clicking a shelved row's body opens the one detail view every other card
  // opens — a card is a card regardless of which tab it sits in. An ordinary,
  // never-dispatched row carries no slug and stays non-clickable: there is no
  // task dir behind it to show. Buttons and the edit form are excluded so
  // typing into a shelved row's form can't tear it open into the detail view.
  const openShelvedTask = (event: MouseEvent) => {
    if (!item.shelvedSlug) return
    if ((event.target as HTMLElement).closest('button, .backlog-edit-form')) return
    onOpenTask(item.shelvedSlug)
  }

  // What sits before the date: a shelved badge, a select box, or nothing.
  type Leading = 'shelved-badge' | 'select-box' | 'none'
  const leadingKind = (): Leading => {
    if (item.shelvedSlug) return 'shelved-badge'
    return item.done ? 'none' : 'select-box'
  }

  const renderLeading = (): ReactNode => {
    switch (leadingKind()) {
      case 'shelved-badge':
        return <span className="backlog-shelved-badge" data-testid="backlog-shelved-badge">shelved: {item.shelvedSlug}</span>
      case 'select-box':
        return (
          <input
            type="checkbox" className="backlog-select-checkbox" data-testid="backlog-select-checkbox" data-index={index}
            aria-label={`Select backlog item ${index + 1}`} checked={isSelected} onChange={onToggleSelected}
          />
        )
      default:
        return null
    }
  }

  // The row's main action: Resume for a shelved entry, Run for an ordinary
  // one, none for a done one. Run dispatches fresh — a new task dir, worktree
  // and branch for work that already exists over there — which is why a
  // shelved row offers Resume instead.
  type PrimaryAction = 'resume' | 'run' | 'none'
  const primaryActionKind = (): PrimaryAction => {
    if (item.done) return 'none'
    return item.shelvedSlug ? 'resume' : 'run'
  }

  const renderPrimaryAction = (): ReactNode => {
    switch (primaryActionKind()) {
      case 'resume':
        return <ResumeButton item={item} index={index} onResumed={onResumed} fetchImpl={fetchImpl} log={log} />
      case 'run':
        return <RunButton item={item} index={index} isCanonical={isCanonical} isStaged={isStaged} fetchImpl={fetchImpl} log={log} />
      default:
        return null
    }
  }

  return (
    <li
      className="backlog-row-item" data-testid="backlog-row" data-index={index}
      data-shelved-slug={item.shelvedSlug ?? undefined} data-project={item.project ?? undefined}
      onClick={item.shelvedSlug ? openShelvedTask : undefined}
    >
      <div className={`backlog-card${item.done ? ' is-done' : ''}`} data-testid="backlog-card" data-index={index}>
        {editForm ?? (
          <>
            {renderLeading()}
            <span className="backlog-row-date" data-testid="backlog-row-date">{item.date ?? ''}</span>
            <div className="backlog-row-main">
              <div className="backlog-row-title-line">
                {item.project ? <span className="card-slug-project backlog-row-project" data-testid="backlog-row-project">{item.project}</span> : null}
                <div className="backlog-row-title" data-testid="backlog-row-title">{item.description}</div>
              </div>
              {item.context ? <div className="backlog-row-context">{item.context}</div> : null}
            </div>
            <div className="backlog-row-actions">
              {!item.done ? (
                <button type="button" className="card-icon-btn backlog-icon-btn" data-testid="backlog-edit-btn" data-index={index} title="Edit" onClick={onStartEdit}><EditIcon /></button>
              ) : null}
              <button
                type="button" className={`card-icon-btn backlog-icon-btn${deleteFailureLabel ? ' btn-err' : ''}`} data-testid="backlog-dismiss-btn" data-index={index}
                aria-label="Waive task" title={deleteFailureLabel ?? 'Waive task'} disabled={isDeleting} onClick={onRequestDelete}
              >
                <TrashIcon />
              </button>
              {renderPrimaryAction()}
            </div>
          </>
        )}
      </div>
    </li>
  )
}
