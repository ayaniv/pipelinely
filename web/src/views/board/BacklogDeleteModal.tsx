import { useId, useRef } from 'react'
import type { BacklogItem } from '../../../../src/types'
import { TrashIcon } from '../../components/icons'
import { ModalFrame } from '../../components/ModalFrame'
import { backlogDeleteCopy } from './backlogDeleteCopy'

// The one confirm modal the batch bar's Delete (N) and every row's own waive
// share — parameterized by how many items it will remove, not forked per
// caller. The dialog shell itself is ModalFrame.

export interface BacklogDeleteModalProps {
  items: BacklogItem[]
  onCancel: () => void
  onConfirm: () => void
}

export function BacklogDeleteModal({ items, onCancel, onConfirm }: BacklogDeleteModalProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const headlineId = useId()
  const { headline, body } = backlogDeleteCopy(items)

  // Cancel is the safe default focus.
  return (
    <ModalFrame
      scrimTestId="backlog-delete-scrim"
      cardTestId="backlog-delete-modal"
      labelledBy={headlineId}
      onCancel={onCancel}
      initialFocusRef={cancelRef}
      dataAttributes={{ 'data-count': items.length }}
    >
      <div className="confirm-modal-headline" id={headlineId} data-testid="backlog-delete-headline">{headline}</div>
      <div className="confirm-modal-body" data-testid="backlog-delete-body">{body}</div>
      <div className="confirm-modal-actions">
        <button ref={cancelRef} className="confirm-modal-cancel-btn" type="button" data-testid="backlog-delete-cancel-btn" onClick={onCancel}>Cancel</button>
        <button className="confirm-modal-confirm-btn" type="button" data-testid="backlog-delete-confirm-btn" onClick={onConfirm}>
          <TrashIcon /><span>Delete</span>
        </button>
      </div>
    </ModalFrame>
  )
}
