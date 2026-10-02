import type { Task } from '../../../../src/types'
import { rowLabel, scopeCost, taskScope } from '../../taskScope'

// The per-session breakdown, inline in the detail view. Rows are labelled by
// the stage each session ran ("planning", "dev"…); a session with no recorded
// stage keeps its #N label. A fan-out parent's header, like its card, speaks
// for the parent's own sessions only — never a roll-up.

export function SessionsSection({ task, isFanout }: { task: Task; isFanout: boolean }) {
  const { rows } = taskScope(task)
  if (!rows.length) return <div className="detail-row-note">No metrics recorded yet — this task has no METRICS files.</div>

  return (
    <>
      <div className="sess-head">
        <h3>Context &amp; sessions</h3>
        <span className="sess-note">{isFanout ? 'parent + every milestone' : 'per Claude session'}</span>
      </div>
      {rows.map((row) => {
        const cost = scopeCost([row])
        const { contextPct } = row.s
        return (
          <div key={row.s.n} className={`session-row${row.s.current ? ' is-current' : ''}`} data-testid="session-row">
            <span data-testid="session-label">{`${rowLabel(row)}${row.s.current ? ' · live' : ''}`}</span>
            <span className="session-bar"><span style={{ width: `${Math.min(100, contextPct || 0)}%` }} /></span>
            <span>{contextPct === null || contextPct === undefined ? '—' : `${contextPct}% ctx`}</span>
            <span>{cost === null ? '—' : `$${cost.toFixed(2)}`}</span>
          </div>
        )
      })}
    </>
  )
}
