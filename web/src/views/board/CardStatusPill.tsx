import type { Task } from '../../../../src/types'
import { CARD_STATUS_META, cardStageLabel, pillStatusFor } from '../../taskScope'

// The pill names the STAGE, and attention is
// carried by its color alone.
export function CardStatusPill({ task }: { task: Task }) {
  const key = pillStatusFor(task)
  const meta = CARD_STATUS_META[key] ?? CARD_STATUS_META.idle
  const isWorking = key === 'working'
  return (
    <div className="card-status-pill" data-testid="card-status-pill" style={{ background: meta.bg }}>
      <span className="card-status-dot-wrap">
        <span className={`card-status-dot${isWorking ? ' is-live' : ''}`} style={{ background: meta.dot }} />
        {isWorking && <span className="card-status-dot-halo is-live" style={{ background: meta.dot }} />}
      </span>
      <span className="card-status-label" style={{ color: meta.fg }}>{cardStageLabel(task) ?? meta.label}</span>
    </div>
  )
}
