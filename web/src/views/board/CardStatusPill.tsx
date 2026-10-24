import type { Task } from '../../../../src/types'
import { stagePillView } from '../../stageView'

export interface StatusPillTestIds {
  pill: string
  dot: string
}

const CARD_PILL_TEST_IDS: StatusPillTestIds = { pill: 'card-status-pill', dot: 'card-status-dot' }

// The pill names the STAGE the card is at, and attention is carried by its
// color: the stage tone on a Needs-you card, the status palette otherwise.
// The inner view's header renders the same pill under its own testids.
export function CardStatusPill({ task, testIds = CARD_PILL_TEST_IDS }: { task: Task; testIds?: StatusPillTestIds }) {
  const pill = stagePillView(task)
  return (
    <div className="card-status-pill" data-testid={testIds.pill} data-tone={pill.tone} data-variant={pill.variant} style={{ background: pill.bg }}>
      <span className="card-status-dot-wrap">
        <span className={`card-status-dot${pill.isLive ? ' is-live' : ''}`} data-testid={testIds.dot} style={{ background: pill.dot }} />
        {pill.isLive && <span className="card-status-dot-halo is-live" style={{ background: pill.halo }} />}
      </span>
      <span className="card-status-label" style={{ color: pill.ink }}>{pill.label}</span>
    </div>
  )
}
