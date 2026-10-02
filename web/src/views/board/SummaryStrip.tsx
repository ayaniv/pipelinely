import type { PulseCounts } from './boardModel'

// Two pulse chips (working / waiting), matching the Pipelinely Pipeline
// design exactly — active spend lives in the header's own pill.
export function SummaryStrip({ counts }: { counts: PulseCounts }) {
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
    </>
  )
}
