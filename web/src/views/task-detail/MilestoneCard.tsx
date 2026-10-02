import type { KeyboardEvent, MouseEvent } from 'react'
import type { MilestoneStatus, Task } from '../../../../src/types'
import { postHandover, postStageSkill, type PostActionOptions } from '../../api/actions'
import { CardMenu } from '../../components/CardMenu'
import { CopySlugButton } from '../../components/CopySlugButton'
import { CtxMeter } from '../../components/CtxMeter'
import { HandoverPill } from '../../components/HandoverPill'
import { DesignBranchIcon } from '../../components/icons'
import { MiniStageRail } from '../../components/MiniStageRail'
import { InlineCardMetrics } from '../../components/ScopeStats'
import { TerminalIconButton } from '../../components/TerminalIconButton'
import { useActionFlash } from '../../components/useActionFlash'
import { autoSubmitStore } from '../../data/autoSubmit'
import { useClientState, clientState as sharedClientState, type ClientState } from '../../data/clientState'
import { ctxIsHot } from '../../format'
import { isMilestoneReadyForDev } from '../../../../src/nextStageCta'
import { milestoneActual, milestoneChildSlug, milestoneStatusMeta } from '../../milestoneModel'
import { milestoneScope } from '../../taskScope'
import { CardFooter } from '../board/CardFooter'
import { MilestoneStatusPill } from './MilestoneStatusPill'

// One card per declared milestone in the Dev tab's wave graph: the same
// CTX/SESS/Model/Tokens/Cost story as any other card, scoped to this
// milestone. A dispatched milestone's card is a card like a board card — the
// same always-a-CTA footer, naming the child's own next stage (or "See
// details" when it has none). A queued one has no child task yet, so it falls
// back to the plain queued state, no stats, and its own gated Start dev.

const MILESTONE_RAIL_STAGES = ['dev', 'cr', 'qa', 'merge']

function StartDevButton({ childSlug, isReady, isAutoSubmitEnabled, fetchImpl = fetch, log = console.error }: { childSlug: string; isReady: boolean; isAutoSubmitEnabled: () => boolean } & Partial<PostActionOptions>) {
  const { flash, showOutcome, isPending, run } = useActionFlash()
  const handleClick = () => run(async () => {
    showOutcome(await postStageSkill(childSlug, 'dev', isAutoSubmitEnabled(), { fetchImpl, log }))
  })
  return (
    <button
      type="button"
      className={`btn btn-primary ${flash.className}`.trim()}
      data-testid="milestone-start-dev-btn"
      disabled={!isReady || isPending}
      onClick={handleClick}
    >
      {flash.label ?? 'Start dev'}
    </button>
  )
}

export interface MilestoneCardProps {
  milestone: MilestoneStatus
  // The fan-out parent — needed for the child's slug and this milestone's
  // Start dev readiness (the plan must have been reviewed).
  parent: Task
  onSelect: (milestoneId: string) => void
  isAutoSubmitEnabled?: () => boolean
  clientState?: ClientState
}

export function MilestoneCard({ milestone, parent, onSelect, isAutoSubmitEnabled = autoSubmitStore.isEnabled, clientState = sharedClientState }: MilestoneCardProps) {
  useClientState(clientState)
  const child = milestone.task
  const meta = milestoneStatusMeta(milestone)
  const isDone = milestone.state === 'done'
  const actual = isDone ? milestoneActual(child) : null
  const childSlug = milestoneChildSlug(parent.slug, milestone.id)
  const isReadyForDev = isMilestoneReadyForDev(milestone, new Map((parent.milestones ?? []).map((m) => [m.id, m])), parent.stageHistory)
  const ctx = child ? (child.contextPct ?? null) : null
  const dispatchStatus = clientState.getDispatchStatus(childSlug)
  const dispatchStatusClass = dispatchStatus === null ? 'ms-dispatch-status' : `ms-dispatch-status ${dispatchStatus.ok ? 'btn-ok' : 'btn-err'}`

  // The card is one big button that opens the milestone. A click on anything
  // interactive inside it (terminal, menu, copy, the footer CTA) is that
  // control's own, never "open this milestone".
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button, a, .card-menu')) return
    onSelect(milestone.id)
  }
  // Role=button means keyboard users must be able to activate it too — but
  // only from the card itself, never hijacking Enter/Space on a control inside.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onSelect(milestone.id)
  }

  return (
    <div className="card session-card ms-card" data-milestone-id={milestone.id} data-testid="milestone-card" role="button" tabIndex={0} onClick={handleClick} onKeyDown={handleKeyDown}>
      <div className="card-header-row">
        <MilestoneStatusPill meta={meta} isLive={milestone.state === 'dispatched'} />
        <div className="card-header-right">
          <span className="ms-card-id" data-testid="milestone-id">{milestone.id}</span>
          {child && <TerminalIconButton slug={child.slug} status={child.status} />}
          {child && <CardMenu task={child} isOffFocus={clientState.isOffFocus(child.slug)} onToggleOffFocus={() => clientState.toggleOffFocus(child.slug)} />}
          <span
            className={dispatchStatusClass}
            data-testid="ms-dispatch-status"
            title={dispatchStatus?.detail ?? ''}
          >
            {dispatchStatus?.label}
          </span>
        </div>
      </div>

      <div className="card-title-block">
        <div className="card-title">{milestone.name}</div>
        {child && (
          <div className="card-slug-row">
            <DesignBranchIcon />
            <span className="card-slug-value">{child.slug}</span>
            <CopySlugButton slug={child.slug} />
          </div>
        )}
        <div className="ms-card-meta">
          <span>needs: {milestone.needs.length ? milestone.needs.join(', ') : 'none'}</span>
          <span data-testid="milestone-est-actual">{milestone.estimate ? `est ${milestone.estimate}` : 'no estimate'}{actual ? ` · took ${actual}` : ''}</span>
        </div>
      </div>

      <div className="card-rail-row">
        <MiniStageRail task={{ status: isDone ? 'done' : 'working', stage: child?.stage ?? null, stageHistory: child?.stageHistory ?? [] }} stageIds={MILESTONE_RAIL_STAGES} />
      </div>

      {child && (
        <div className="card-ctx-row">
          <CtxMeter ctx={ctx} />
          <InlineCardMetrics scope={milestoneScope(milestone)} />
          {ctxIsHot(ctx) && !isDone && <HandoverPill testId="ms-card-handover" send={(options) => postHandover(child.slug, options)} />}
        </div>
      )}

      {!isDone && (child
        ? <CardFooter task={child} />
        : (
          <div className="card-footer">
            <StartDevButton childSlug={childSlug} isReady={isReadyForDev} isAutoSubmitEnabled={isAutoSubmitEnabled} />
          </div>
        ))}
    </div>
  )
}
