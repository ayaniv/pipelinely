import { useCallback } from 'react'
import { ERROR_FLASH_MS, useActionFlash } from '../../components/useActionFlash'
import type { Logger } from '../../log'

// The Done tab's "copy standup" button — today's finished titles as bullet
// lines, on the clipboard. Rendered only while the Done tab shows.

const COPIED_FLASH_MS = 1600

export interface StandupButtonProps {
  // null when nothing finished today: there is nothing to copy, so the click
  // does nothing rather than putting an empty string on the clipboard.
  text: string | null
  log?: Logger
}

export function StandupButton({ text, log = console.error }: StandupButtonProps) {
  const { flash, show, isPending, run } = useActionFlash(log)

  const copy = useCallback(() => run(async () => {
    if (text === null) return
    try {
      await navigator.clipboard.writeText(text)
      show('btn-ok', 'copied', COPIED_FLASH_MS)
    } catch (err) {
      log('[action] could not copy standup text', err)
      show('btn-err', 'copy failed', ERROR_FLASH_MS)
    }
  }), [run, text, show, log])

  return (
    <button className="standup-btn" type="button" data-testid="standup-btn" disabled={isPending} onClick={copy}>
      {flash.label ?? 'copy standup'}
    </button>
  )
}
