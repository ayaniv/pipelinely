import type { FlashState } from '../../components/useActionFlash'
import { PlayIcon, TrashIcon } from '../../components/icons'
import { READ_ONLY_INSTANCE_TITLE } from '../../components/readOnly'

// The bar that opens above the list while any row is ticked: how many, Clear,
// Delete (N) and Run batch (N). Both counts are the same number — the ticked
// rows the current filter shows — so it is one prop, not two that could
// disagree.

const RUN_BATCH_HINT = 'Stages one command for the selected backlog items — unsent, for you to review'

export interface BacklogBatchBarProps {
  count: number
  isCanonical: boolean
  isRunPending: boolean
  isDeleting: boolean
  // What each button is currently flashing (a failure's reason as its
  // tooltip, kept off the label so the "(N)" count never detaches).
  runFlash: FlashState
  deleteFailureLabel: string | null
  onClear: () => void
  onDelete: () => void
  onRun: () => void
}

export function BacklogBatchBar({ count, isCanonical, isRunPending, isDeleting, runFlash, deleteFailureLabel, onClear, onDelete, onRun }: BacklogBatchBarProps) {
  const hasRunError = runFlash.className === 'btn-err'
  const runTitle = hasRunError ? (runFlash.label ?? undefined) : isCanonical ? RUN_BATCH_HINT : READ_ONLY_INSTANCE_TITLE
  return (
    <div className={`backlog-batch-bar${count > 0 ? ' is-open' : ''}`} data-testid="backlog-batch-bar">
      <span data-testid="backlog-selected-count"><span data-testid="backlog-selected-count-num">{count}</span> selected</span>
      <button className="backlog-batch-clear" type="button" data-testid="backlog-clear-selected-btn" onClick={onClear}>clear</button>
      <button
        className={`backlog-delete-btn${deleteFailureLabel ? ' btn-err' : ''}`} type="button" data-testid="backlog-delete-selected-btn"
        disabled={isDeleting} title={deleteFailureLabel ?? undefined} onClick={onDelete}
      >
        <TrashIcon /><span>Delete (<span data-testid="backlog-delete-selected-count">{count}</span>)</span>
      </button>
      <button
        className={`backlog-batch-run${hasRunError ? ' btn-err' : ''}`} type="button" data-testid="backlog-run-selected-btn"
        disabled={!isCanonical || isRunPending} title={runTitle} onClick={onRun}
      >
        <PlayIcon /><span>Run batch (<span>{count}</span>)</span>
      </button>
    </div>
  )
}
