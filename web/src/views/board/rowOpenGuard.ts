import type { MouseEvent } from 'react'

// Whether a click inside a card or table row is NOT a request to open the task:
// it landed on one of the row's own controls (or its portalled menu), or it
// ends a text selection the user made inside the row.
export function shouldIgnoreOpenClick(event: { target: EventTarget; currentTarget: EventTarget }): boolean {
  const target = event.target as HTMLElement
  if (target.closest('button, a, .card-menu')) return true
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed) return false
  return (event.currentTarget as Node).contains(selection.anchorNode)
}

// A title link opens the task in place on a plain click; a modified one (new
// tab, new window) is left to the browser, which follows the real href.
export function openOnPlainClick(event: MouseEvent<HTMLAnchorElement>, open: () => void): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
  event.preventDefault()
  open()
}
