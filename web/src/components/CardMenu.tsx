import { useEffect, useRef, useState } from 'react'
import type { Task } from '../../../src/types'
import { postAction, postShelve, type ActionOutcome, type PostActionOptions } from '../api/actions'
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

export interface CardMenuProps extends Partial<PostActionOptions> {
  task: Task
  isOffFocus: boolean
  onToggleOffFocus: () => void
  extraClass?: string
}

export function CardMenu({ task, isOffFocus, onToggleOffFocus, extraClass, fetchImpl = fetch, log = console.error }: CardMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const deps = { fetchImpl, log }

  useEffect(() => {
    if (!isOpen) return
    const onDocMouseDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setIsOpen(false)
    }
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onDocKeyDown)
    return () => {
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
    items.push({ glyph: '↗', label: 'Open terminal', testId: 'card-menu-focus', onActivate: () => postAction('focus', task.slug, deps) })
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
      <button type="button" className="card-icon-btn" data-testid="card-menu-btn" title="More" onClick={() => setIsOpen((v) => !v)}>
        <DotsIcon />
      </button>
      {isOpen && (
        <div className="card-menu" data-testid="card-menu">
          {items.map((item) => (
            <CardMenuItem key={item.testId} {...item} />
          ))}
        </div>
      )}
    </div>
  )
}
