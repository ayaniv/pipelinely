import { useCallback } from 'react'
import { useClipboardCopy } from '../../components/useClipboardCopy'
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
  const { flash, isPending, copy: copyText } = useClipboardCopy(log)

  const copy = useCallback(() => {
    if (text === null) return
    void copyText(text, { description: 'standup text', copiedLabel: 'copied', copiedMs: COPIED_FLASH_MS, failedLabel: 'copy failed' })
  }, [copyText, text])

  return (
    <button className="standup-btn" type="button" data-testid="standup-btn" disabled={isPending} onClick={copy}>
      {flash.label ?? 'copy standup'}
    </button>
  )
}
