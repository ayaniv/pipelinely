import type { MilestoneStatus, Task } from '../../../../src/types'
import { postHandover } from '../../api/actions'
import { CardMenu } from '../../components/CardMenu'
import { CopySlugButton } from '../../components/CopySlugButton'
import { CtxMeter } from '../../components/CtxMeter'
import { DetailMetaRow } from '../../components/DetailMetaRow'
import { FocusButton } from '../../components/FocusButton'
import { HandoverPill } from '../../components/HandoverPill'
import { BackArrowIcon, DesignBranchIcon } from '../../components/icons'
import { clientState as sharedClientState, useClientState, type ClientState } from '../../data/clientState'
import { ctxIsHot } from '../../format'
import { milestoneStatusMeta } from '../../milestoneModel'
import { detailMetaPairs } from '../../taskScope'
import { MilestoneStatusPill } from './MilestoneStatusPill'

// A drilled-into milestone's header: a link back to the PARENT task, then the
// same header card a task's own detail has — a status pill beside the mono
// milestone id, an h1, a slug line, the shared actions row, the shared ctx row
// and the four mono meta pairs — reused from the same primitives rather than
// re-derived, so the two headers can never drift.

export interface MilestoneDetailHeadProps {
  parent: Task
  milestone: MilestoneStatus
  onBackToMilestones: () => void
  clientState?: ClientState
}

export function MilestoneDetailHead({ parent, milestone, onBackToMilestones, clientState = sharedClientState }: MilestoneDetailHeadProps) {
  useClientState(clientState)
  const child = milestone.task
  const ctx = child ? (child.contextPct ?? null) : null
  const parentName = parent.title || parent.slug

  return (
    <>
      <button type="button" className="milestone-parent-link" data-testid="milestone-parent-link" aria-label={`Back to ${parentName}`} onClick={onBackToMilestones}>
        <BackArrowIcon /><span>{parentName}</span>
      </button>
      <div className="detail-head" data-testid="milestone-detail-head">
        <div className="detail-head-text">
          <div className="detail-title-row">
            <MilestoneStatusPill meta={milestoneStatusMeta(milestone)} isLive={false} testId="milestone-status-pill" isLarge />
            <span className="l2-slug" data-testid="milestone-detail-id">{milestone.id}</span>
          </div>
          <h2 className="milestone-title" data-testid="milestone-title">{milestone.name}</h2>
          <div className="detail-slug-row">
            <DesignBranchIcon />
            <span className="detail-slug-value">{child ? child.slug : 'not dispatched'}</span>
            {child && <CopySlugButton slug={child.slug} />}
          </div>
          <div className="detail-ctx-row" data-testid="milestone-ctx-row">
            <CtxMeter ctx={ctx} testIds={{ track: 'milestone-ctx-meter', fill: 'milestone-ctx-meter-fill', pct: 'milestone-ctx-value' }} />
            {child && ctxIsHot(ctx) && child.status !== 'done' && <HandoverPill testId="milestone-handover" send={(options) => postHandover(child.slug, options)} />}
          </div>
          <div className="detail-meta" data-testid="milestone-meta">{child && <DetailMetaRow pairs={detailMetaPairs(child)} />}</div>
        </div>
        <div className="detail-actions">
          {child && <FocusButton slug={child.slug} status={child.status} attentionStatus={child.attentionStatus} />}
          {child && <CardMenu task={child} extraClass="ms-head-menu" isOffFocus={clientState.isOffFocus(child.slug)} onToggleOffFocus={() => clientState.toggleOffFocus(child.slug)} />}
        </div>
      </div>
    </>
  )
}
