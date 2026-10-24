import { useCallback, useEffect, useState } from 'react'

// A settings switch that answers the click immediately, before the server has
// confirmed. `requested` holds that unconfirmed value: a failed write clears
// it (reverting to what the server last reported), and it also clears once a
// snapshot agrees — after which the snapshot is the source of truth again,
// including for a change made from a second open tab.
export function useOptimisticSetting<T>(serverValue: T, save: (next: T) => Promise<boolean>): [displayed: T, request: (next: T) => Promise<void>] {
  const [requested, setRequested] = useState<T | null>(null)

  useEffect(() => {
    if (requested !== null && requested === serverValue) setRequested(null)
  }, [requested, serverValue])

  const request = useCallback(async (next: T) => {
    setRequested(next)
    if (!(await save(next))) setRequested(null)
  }, [save])

  return [requested ?? serverValue, request]
}
