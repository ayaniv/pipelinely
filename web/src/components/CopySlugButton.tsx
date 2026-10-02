import { useEffect, useRef, useState } from 'react'
import type { Logger } from '../log'
import { CopyIcon } from './icons'

// Copies a task's slug and flashes "copied" beside the button for a moment —
// shared by the task-detail head and the board's session card (extracted
// from TaskDetail.tsx's own inline copy so there is exactly one).

const COPIED_FLASH_MS = 1400

export interface CopySlugButtonProps {
  slug: string
  log?: Logger
}

export function CopySlugButton({ slug, log = console.error }: CopySlugButtonProps) {
  const [isCopied, setIsCopied] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
  }, [])

  const handleClick = () => {
    // navigator.clipboard is undefined outside a secure context, so reading
    // writeText off it can throw synchronously as well as reject.
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(slug))
      .then(() => {
        setIsCopied(true)
        if (timeoutRef.current) clearTimeout(timeoutRef.current)
        timeoutRef.current = setTimeout(() => setIsCopied(false), COPIED_FLASH_MS)
      })
      .catch((err) => log('[action] could not copy slug', err))
  }

  return (
    <>
      <button type="button" className="card-icon-btn card-copy-btn" data-testid="card-copy-btn" title="Copy slug" onClick={handleClick}>
        <CopyIcon />
      </button>
      <span className="card-copied" data-testid="card-copied" hidden={!isCopied}>copied</span>
    </>
  )
}
