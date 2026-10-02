import { useCallback, useEffect, useRef, useState } from 'react'
import { postTriage, type PostActionOptions, type TriageEndpoint } from '../../../api/actions'

// A findings / QA-failure checklist's selection. The server's own state (the
// TRIAGE.json / QA_TRIAGE.json read back through the snapshot) is the truth,
// but a click has to show at once and keep showing until the server's state
// catches up — the write reaches the file watcher, and so the next snapshot,
// a beat after the POST returns, and reverting in that gap would flicker the
// box back. The local
// `override` covers that gap and is dropped as soon as the server's
// state is authoritative again. State belongs to one checklist owner: callers
// key the component using this hook by slug, so a drill-down from one
// milestone to another remounts it instead of leaking the override.

interface TriageSelectionOptions extends Partial<PostActionOptions> {
  slug: string
  endpoint: TriageEndpoint
  serverSelected: boolean[]
}

const sameSelection = (a: boolean[], b: boolean[]) => a.length === b.length && a.every((value, i) => value === b[i])

export function useTriageSelection({ slug, endpoint, serverSelected, fetchImpl = fetch, log = console.error }: TriageSelectionOptions) {
  const [override, setOverride] = useState<boolean[] | null>(null)
  const overrideRef = useRef<boolean[] | null>(null)
  const serverRef = useRef(serverSelected)
  serverRef.current = serverSelected
  const inFlightCountRef = useRef(0)

  const updateOverride = useCallback((next: boolean[] | null) => {
    overrideRef.current = next
    setOverride(next)
  }, [])

  const serverKey = serverSelected.map(Number).join('')
  useEffect(() => {
    // The server moved while nothing of ours is outstanding: it wins.
    if (overrideRef.current && inFlightCountRef.current === 0) updateOverride(null)
  }, [serverKey, updateOverride])

  const toggle = useCallback(async (index: number) => {
    const base = overrideRef.current && overrideRef.current.length === serverRef.current.length ? overrideRef.current : serverRef.current
    const next = base.map((isSelected, i) => (i === index ? !isSelected : isSelected))
    updateOverride(next)

    inFlightCountRef.current += 1
    const selectedIndexes = next.flatMap((isSelected, i) => (isSelected ? [i] : []))
    const outcome = await postTriage(endpoint, slug, selectedIndexes, { fetchImpl, log })
    inFlightCountRef.current -= 1

    if (!outcome.ok) {
      // Revert only this toggle's row: another toggle still in flight keeps
      // its optimistic state until its own POST resolves.
      const current = overrideRef.current
      if (inFlightCountRef.current === 0 || !current || current.length !== base.length) updateOverride(null)
      else updateOverride(current.map((isSelected, i) => (i === index ? base[index] : isSelected)))
    } else if (inFlightCountRef.current === 0 && overrideRef.current && sameSelection(overrideRef.current, serverRef.current)) {
      updateOverride(null)
    }
  }, [endpoint, slug, fetchImpl, log, updateOverride])

  const selected = override && override.length === serverSelected.length ? override : serverSelected
  return { selected, selectedCount: selected.filter(Boolean).length, toggle }
}
