import type { StatusMeta } from '../../taskScope'

// The status pill a milestone card and a milestone's detail head share: a dot
// and a label in the tone milestoneStatusMeta picked. Distinct from the board
// card's CardStatusPill, which reads a whole Task — a queued milestone has no
// Task to read.

export interface MilestoneStatusPillProps {
  meta: StatusMeta
  // Whether the dot pulses: a dispatched milestone that is neither queued nor merged.
  isLive: boolean
  testId?: string
  // The detail head draws the pill slightly bolder than a card does.
  isLarge?: boolean
}

export function MilestoneStatusPill({ meta, isLive, testId, isLarge = false }: MilestoneStatusPillProps) {
  return (
    <span className="card-status-pill" data-testid={testId} style={{ background: meta.bg, ...(isLarge ? { fontSize: '11.5px', fontWeight: 700 } : {}) }}>
      <span className="card-status-dot-wrap"><span className={`card-status-dot${isLive ? ' is-live' : ''}`} style={{ background: meta.dot }} /></span>
      <span className="card-status-label" style={{ color: meta.fg }}>{meta.label}</span>
    </span>
  )
}
