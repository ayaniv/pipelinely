import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

// The one modal shell every dialog shares — the backlog Delete confirm and
// the New task form differ only in their body, so the portal, scrim, Escape,
// focus trap and focus return live here once. Portalled to <body>: the scrim
// is position: fixed and covers the viewport, not the panel it was opened from.

const FOCUSABLE_SELECTOR = 'button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'

export interface ModalFrameProps {
  scrimTestId: string
  cardTestId: string
  // The id of the element inside the card that titles the dialog.
  labelledBy: string
  onCancel: () => void
  // Where focus lands when the modal opens — the safe default for that dialog.
  initialFocusRef: RefObject<HTMLElement | null>
  // Extra class on the card, for a dialog that needs a different width.
  cardClassName?: string
  dataAttributes?: Record<`data-${string}`, string | number>
  children: ReactNode
}

export function ModalFrame({ scrimTestId, cardTestId, labelledBy, onCancel, initialFocusRef, cardClassName, dataAttributes, children }: ModalFrameProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  // Read during the first render, before the effect below moves focus in.
  const openerRef = useRef<Element | null>(document.activeElement)

  // Closing hands focus back to whatever opened the dialog (when it is still
  // on the page).
  useEffect(() => {
    initialFocusRef.current?.focus()
    return () => {
      const opener = openerRef.current
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [initialFocusRef])

  // Wraps at each end of the card's enabled controls; between them the
  // browser's own Tab order is already inside the card.
  const trapTab = (event: ReactKeyboardEvent) => {
    if (event.key !== 'Tab') return
    const focusable = Array.from(cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const wrapFrom = event.shiftKey ? first : last
    if (document.activeElement !== wrapFrom) return
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
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
    <div className="confirm-modal-scrim" data-testid={scrimTestId} onClick={(event) => { if (event.target === event.currentTarget) onCancel() }}>
      <div
        ref={cardRef}
        className={`confirm-modal-card${cardClassName ? ` ${cardClassName}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        data-testid={cardTestId}
        onKeyDown={trapTab}
        {...dataAttributes}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}
