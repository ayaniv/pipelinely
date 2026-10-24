import { useCallback } from 'react'
import type { Logger } from '../log'
import { ERROR_FLASH_MS, useActionFlash } from './useActionFlash'

// "Copy this text, then say so on the button": the clipboard write, its
// success flash and its failure flash (logged, with the browser's reason), in
// one place for every copy button (the Done tab's standup, a bookmark's text).

export interface ClipboardCopyLabels {
  // What is being copied, for the log line: "could not copy <description>".
  description: string
  copiedLabel: string
  copiedMs: number
  failedLabel: string
}

export function useClipboardCopy(log: Logger = console.error) {
  const { flash, show, isPending, run } = useActionFlash(log)

  const copy = useCallback((text: string, { description, copiedLabel, copiedMs, failedLabel }: ClipboardCopyLabels) => run(async () => {
    try {
      await navigator.clipboard.writeText(text)
      show('btn-ok', copiedLabel, copiedMs)
    } catch (err) {
      log(`[action] could not copy ${description}`, err)
      show('btn-err', failedLabel, ERROR_FLASH_MS)
    }
  }), [run, show, log])

  return { flash, isPending, copy }
}
