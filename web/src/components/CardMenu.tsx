import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Task } from '../../../src/types'
import { postAction, postFocus, postShelve, type ActionOutcome, type PostActionOptions } from '../api/actions'
import { findPrNumber } from '../taskScope'
import { markTaskDone } from './markTaskDone'
import { useActionFlash } from './useActionFlash'
import { DotsIcon } from './icons'

// A card's 3-dot menu. Open/closed is local state: only one menu is ever being
// interacted with.

interface MenuItemDef {
  glyph: string
  label: string
  testId: string
  amber?: boolean
  onActivate: () => Promise<ActionOutcome | void>
}

function CardMenuItem({ glyph, label, testId, amber, onActivate }: MenuItemDef) {
  const { flash, showOutcome, isPending, run } = useActionFlash()
  const handleClick = () => run(async () => {
    const result = await onActivate()
    if (result) showOutcome(result)
  })
  return (
    <button type="button" className={`card-menu-item${amber ? ' is-amber' : ''} ${flash.className}`.trim()} data-testid={testId} disabled={isPending} onClick={handleClick}>
      {flash.label === null ? (
        <>
          <span className="card-menu-glyph">{glyph}</span>
          <span>{label}</span>
        </>
      ) : (
        // A plain text replacement of the button's whole content, glyph
        // included, not just the label span.
        flash.label
      )}
    </button>
  )
}

const TRIGGER_MOVE_TOLERANCE_PX = 0.5
const MENU_GAP_PX = 6
const VIEWPORT_MARGIN_PX = 8

export interface MenuAnchor { top: number; bottom: number; left: number; right: number }
export interface MenuSize { width: number; height: number }

// Below the trigger and right-aligned to it, flipped above when it would run
// off the bottom and clamped to stay inside the viewport.
export function placeMenu(anchor: MenuAnchor, size: MenuSize, viewport: { width: number; height: number }): { top: number; left: number } {
  const fitsBelow = anchor.bottom + MENU_GAP_PX + size.height <= viewport.height - VIEWPORT_MARGIN_PX
  const top = fitsBelow ? anchor.bottom + MENU_GAP_PX : Math.max(VIEWPORT_MARGIN_PX, anchor.top - MENU_GAP_PX - size.height)
  const maxLeft = viewport.width - size.width - VIEWPORT_MARGIN_PX
  const left = Math.max(VIEWPORT_MARGIN_PX, Math.min(anchor.right - size.width, maxLeft))
  return { top, left }
}

export interface CardMenuProps extends Partial<PostActionOptions> {
  task: Task
  isOffFocus: boolean
  onToggleOffFocus: () => void
  extraClass?: string
}

export function CardMenu({ task, isOffFocus, onToggleOffFocus, extraClass, fetchImpl = fetch, log = console.error }: CardMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const deps = { fetchImpl, log }

  // Placed before paint so the menu never shows at the wrong spot.
  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current || !menuRef.current) {
      setPosition(null)
      return
    }
    const { offsetWidth, offsetHeight } = menuRef.current
    setPosition(placeMenu(triggerRef.current.getBoundingClientRect(), { width: offsetWidth, height: offsetHeight }, { width: window.innerWidth, height: window.innerHeight }))
  }, [isOpen])

  // The menu is portalled to the end of the body, so Tab from the trigger would
  // skip it: move focus in when it opens, and back to the trigger on Escape.
  useEffect(() => {
    if (isOpen) menuRef.current?.querySelector<HTMLElement>('button')?.focus()
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    // The menu is portalled, so it is no longer inside wrapRef.
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (!wrapRef.current?.contains(target) && !menuRef.current?.contains(target)) setIsOpen(false)
    }
    const close = () => setIsOpen(false)
    // An inner scroller's scroll event doesn't bubble, hence capture. Only a
    // scroll that actually moved the trigger closes the menu: another table
    // correcting its own offset must not, and a scroll event is delivered a
    // frame late, so the one from the scroll that brought the trigger into
    // view can land just after the menu opened.
    const openedAt = triggerRef.current?.getBoundingClientRect()
    const onScroll = (e: Event) => {
      const scrolled = e.target
      const isTriggerScroller = scrolled === document || (scrolled instanceof Node && scrolled.contains(triggerRef.current))
      const now = triggerRef.current?.getBoundingClientRect()
      const hasTriggerMoved = !openedAt || !now || Math.abs(now.top - openedAt.top) > TRIGGER_MOVE_TOLERANCE_PX || Math.abs(now.left - openedAt.left) > TRIGGER_MOVE_TOLERANCE_PX
      if (isTriggerScroller && hasTriggerMoved) close()
    }
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setIsOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onDocKeyDown)
    document.addEventListener('scroll', onScroll, { capture: true })
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true })
      window.removeEventListener('resize', close)
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onDocKeyDown)
    }
  }, [isOpen])

  const isShelved = task.status === 'shelved'
  const prNumber = findPrNumber(task)

  const items: MenuItemDef[] = [
    {
      glyph: '◇',
      label: isOffFocus ? 'Mark in focus' : 'Mark off focus',
      testId: 'card-menu-toggle-off-focus',
      onActivate: async () => { onToggleOffFocus() },
    },
  ]
  if (!isShelved) {
    items.push({ glyph: '↗', label: 'Open terminal', testId: 'card-menu-focus', onActivate: () => postFocus(task.slug, deps) })
  }
  if (task.devUrl) {
    items.push({ glyph: '▶', label: 'Browse app', testId: 'card-menu-browse', onActivate: () => postAction('browse', task.slug, deps) })
  }
  if (task.worktree) {
    items.push({ glyph: '◆', label: 'Open in VS Code', testId: 'card-menu-vscode', onActivate: () => postAction('vscode', task.slug, deps) })
  }
  if (prNumber) {
    items.push({ glyph: '⇧', label: 'Open PR', testId: 'open-pr-btn', onActivate: () => postAction('open-pr', task.slug, deps) })
  }
  if (task.status !== 'done') {
    items.push({
      glyph: '✓',
      label: 'Mark as done',
      testId: 'mark-done-btn',
      onActivate: () => markTaskDone(task, deps),
    })
  }
  if (!isShelved) {
    items.push({
      glyph: '←',
      label: 'Move to backlog (shelve)',
      testId: 'shelve-btn',
      onActivate: async () => {
        const proceed = window.confirm(
          `Shelve "${task.title || task.slug}" back to the backlog? Any uncommitted work is committed and its worktree is removed — everything else (branch, plan) stays, and you can resume it later.`,
        )
        if (!proceed) return
        return postShelve(task.slug, deps)
      },
    })
    items.push({
      glyph: '×',
      label: 'Stop session',
      testId: 'card-menu-stop-session',
      amber: true,
      onActivate: async () => {
        console.info(`cockpit-ai: "stop-session" has no backend endpoint yet (slug: ${task.slug})`)
        setIsOpen(false)
      },
    })
  }

  return (
    <div className={`card-menu-wrap ${extraClass || ''}`.trim()} ref={wrapRef}>
      <button type="button" ref={triggerRef} className="card-icon-btn" data-testid="card-menu-btn" title="More" onClick={() => setIsOpen((v) => !v)}>
        <DotsIcon />
      </button>
      {isOpen && createPortal(
        <div
          className={`card-menu ${extraClass || ''}`.trim()}
          data-testid="card-menu"
          ref={menuRef}
          style={position ? { top: position.top, left: position.left } : { visibility: 'hidden' }}
        >
          {items.map((item) => (
            <CardMenuItem key={item.testId} {...item} />
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}
