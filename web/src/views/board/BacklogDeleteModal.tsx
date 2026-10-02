import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { BacklogItem } from '../../../../src/types'
import { TrashIcon } from '../../components/icons'
import { backlogDeleteCopy } from './backlogDeleteCopy'

// The one confirm modal the batch bar's Delete (N) and every row's own waive
// share — parameterized by how many items it will remove, not forked per
// caller. Portalled to <body> (its scrim is position: fixed and covers the
// viewport, not the panel it was opened from).

export interface BacklogDeleteModalProps {
  items: BacklogItem[]
  onCancel: () => void
  onConfirm: () => void
}

export function BacklogDeleteModal({ items, onCancel, onConfirm }: BacklogDeleteModalProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  // Read during the first render, before the effect below moves focus in.
  const openerRef = useRef<Element | null>(document.activeElement)
  const headlineId = useId()
  const { headline, body } = backlogDeleteCopy(items)

  // Cancel is the safe default focus; closing hands focus back to whatever
  // opened the dialog (when it is still on the page).
  useEffect(() => {
    cancelRef.current?.focus()
    return () => {
      const opener = openerRef.current
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])

  // Two buttons, so a trap is just wrapping at each end.
  const trapTab = (event: ReactKeyboardEvent) => {
    if (event.key !== 'Tab') return
    const wrapFrom = event.shiftKey ? cancelRef.current : confirmRef.current
    if (document.activeElement !== wrapFrom) return
    event.preventDefault()
    ;(event.shiftKey ? confirmRef.current : cancelRef.current)?.focus()
  }

  // A separate listener from the task-detail overlay's own Escape handling —
  // each guards a different piece of state.
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel() }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [onCancel])

  return createPortal(
    // Cancels only when the click lands on the scrim itself, not one that
    // bubbles up from the card sitting inside it.
    <div className="confirm-modal-scrim" data-testid="backlog-delete-scrim" onClick={(event) => { if (event.target === event.currentTarget) onCancel() }}>
      <div className="confirm-modal-card" role="dialog" aria-modal="true" aria-labelledby={headlineId} data-testid="backlog-delete-modal" data-count={items.length} onKeyDown={trapTab}>
        <div className="confirm-modal-headline" id={headlineId} data-testid="backlog-delete-headline">{headline}</div>
        <div className="confirm-modal-body" data-testid="backlog-delete-body">{body}</div>
        <div className="confirm-modal-actions">
          <button ref={cancelRef} className="confirm-modal-cancel-btn" type="button" data-testid="backlog-delete-cancel-btn" onClick={onCancel}>Cancel</button>
          <button ref={confirmRef} className="confirm-modal-confirm-btn" type="button" data-testid="backlog-delete-confirm-btn" onClick={onConfirm}>
            <TrashIcon /><span>Delete</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
