import { useCallback, useRef, useState } from 'react'
import type { Logger } from '../log'
import { useTransientValue } from './useTransientValue'

// Surface an action's outcome on the button itself for a duration, then
// revert. A hook (state, not DOM mutation) — every primitive that dispatches a typed
// action (FocusButton, HandoverPill, CardMenu's own items) shares this
// instead of re-implementing the same timeout/revert dance.

export type FlashClass = '' | 'btn-ok' | 'btn-err'

export interface FlashState {
  className: FlashClass
  label: string | null
}

const IDLE: FlashState = { className: '', label: null }
const DEFAULT_DURATION_MS = 1400
// How long a failure label stays up — longer than a success, since it is the
// one the developer needs time to read.
export const ERROR_FLASH_MS = 5000
// Focus/Terminal buttons sit in dense rows, so their failures clear sooner.
export const SHORT_ERROR_FLASH_MS = 3000

export function useActionFlash(log: Logger = console.error) {
  const [transientFlash, showFlash] = useTransientValue<FlashState>(DEFAULT_DURATION_MS)
  const flash = transientFlash ?? IDLE
  const [isPending, setIsPending] = useState(false)
  // Synchronous guard — a fast double-click/double-Enter can fire a second
  // handler call before React has re-rendered with isPending: true, so the
  // state value alone (only meant to drive the button's disabled attribute)
  // can't be what actually blocks the re-entrant call.
  const pendingRef = useRef(false)

  const show = useCallback((className: 'btn-ok' | 'btn-err', label: string, durationMs = DEFAULT_DURATION_MS) => {
    showFlash({ className, label }, durationMs)
  }, [showFlash])

  // The shared outcome→flash mapping every typed-action component used to
  // copy: ok flashes briefly, a failure stays up for `errorDurationMs`.
  const showOutcome = useCallback((outcome: { ok: boolean; label: string }, errorDurationMs = ERROR_FLASH_MS) => {
    show(outcome.ok ? 'btn-ok' : 'btn-err', outcome.label, outcome.ok ? undefined : errorDurationMs)
  }, [show])

  // Disables the control for the duration of the request — wraps an async
  // action so a second call landing while the first is still in flight is a
  // no-op, matching this repo's "disable duplicate submissions... for
  // operational mutations" constraint. The caller does its own show() call
  // inside `action` (each primitive picks its own error-flash duration), so
  // this only owns the pending guard, not the outcome.
  const run = useCallback(async (action: () => Promise<void>) => {
    if (pendingRef.current) return
    pendingRef.current = true
    setIsPending(true)
    try {
      await action()
    } catch (err) {
      // An action normally reports its own outcome via show(); a throw that
      // escapes it (a blocked dialog, an injected callback) would
      // otherwise be an unhandled rejection with no feedback at all.
      log('[action] handler threw', err)
      show('btn-err', 'failed', ERROR_FLASH_MS)
    } finally {
      pendingRef.current = false
      setIsPending(false)
    }
  }, [show, log])

  return { flash, show, showOutcome, isPending, run }
}
