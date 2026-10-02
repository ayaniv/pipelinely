import { useEffect, useState } from 'react'

// A wall-clock timestamp that advances on an interval, so a relative label
// ("5m ago") stays live with no network call and no DOM patching — the
// board's clock tick.
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
