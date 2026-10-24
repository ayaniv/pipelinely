import type { ReactNode } from 'react'
import type { PulseCounts } from './boardModel'

// The pulse chips (working / waiting / off focus), matching the Pipelinely
// design — active spend lives in the header's own pill. `children` is the
// toolbar's actions (Push forward, New task): they sit after the chips, and only
// the Active tab supplies them.
export interface SummaryStripProps {
  counts: PulseCounts
  offFocusCount: number
  children?: ReactNode
}

export function SummaryStrip({ counts, offFocusCount, children }: SummaryStripProps) {
  return (
    <>
      <div className="pulse-chip" data-testid="pulse-chip-working">
        <span className="pulse-dot-wrap">
          <span className="pulse-dot is-live" style={{ background: 'var(--accent)' }} />
          <span className="pulse-dot-halo is-live" style={{ background: 'var(--accent)' }} />
        </span>
        <span className="pulse-chip-text"><span className="pulse-chip-value" style={{ color: 'var(--ink)' }}>{counts.working}</span> working</span>
      </div>
      <div className="pulse-chip" data-testid="pulse-chip-waiting">
        <span className="pulse-dot-wrap"><span className="pulse-dot" style={{ background: 'var(--amber)' }} /></span>
        <span className="pulse-chip-text"><span className="pulse-chip-value" style={{ color: 'var(--amberInk)' }}>{counts.needsYou}</span> waiting</span>
      </div>
      {offFocusCount > 0 && (
        <div className="pulse-chip pulse-chip-off-focus" data-testid="pulse-chip-off-focus" data-count={offFocusCount}>
          <span className="pulse-chip-text"><span className="pulse-chip-value">{offFocusCount}</span> off focus</span>
        </div>
      )}
      {children}
    </>
  )
}
