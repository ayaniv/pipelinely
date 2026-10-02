import { useCallback, useEffect, useRef, useState } from 'react'

// A value that clears itself after `durationMs` — the state behind "flash an
// outcome on a control, then revert", for callers whose flash target isn't
// the component that owns the action (useActionFlash covers the one-button
// case). Setting a new value restarts the clock, so an older timer can never
// wipe a newer value. A call may override the duration (a failure stays up
// longer than a success). useActionFlash is built on this.
export function useTransientValue<Value>(defaultDurationMs: number) {
  const [value, setValue] = useState<Value | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
  }, [])

  const show = useCallback((next: Value, durationMs: number = defaultDurationMs) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    setValue(next)
    timeoutRef.current = setTimeout(() => setValue(null), durationMs)
  }, [defaultDurationMs])

  return [value, show] as const
}
