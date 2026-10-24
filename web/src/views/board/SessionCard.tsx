import type { MouseEvent } from 'react'
import type { CreaturePlacement, Task } from '../../../../src/types'
import { postHandover } from '../../api/actions'
import { CardMenu } from '../../components/CardMenu'
import { Creature } from '../../components/Creature'
import { CopySlugButton } from '../../components/CopySlugButton'
import { CtxMeter } from '../../components/CtxMeter'
import { HandoverPill } from '../../components/HandoverPill'
import { DesignBranchIcon } from '../../components/icons'
import { MiniStageRail } from '../../components/MiniStageRail'
import { ParentLinkChip } from '../../components/ParentLinkChip'
import { PrLink } from '../../components/PrLink'
import { StageSummaryCallout } from '../../components/StageSummaryCallout'
import { TerminalIconButton } from '../../components/TerminalIconButton'
import { CTX_WARN_THRESHOLD, ctxIsHot, relTime } from '../../format'
import type { OpenTask } from '../../shell/appNavigation'
import { taskUrl } from '../../shell/routes'
import { MINI_RAIL_STAGES, STAGE_TONE_VARS, cardStageView } from '../../stageView'
import { findPrNumber, hasLiveTerminal, isTaskWorking, isWorkingLeaf } from '../../taskScope'
import { ApprovalCallout } from './ApprovalCallout'
import { CardFooter } from './CardFooter'
import { CardStatusPill } from './CardStatusPill'
import { openOnPlainClick, shouldIgnoreOpenClick } from './rowOpenGuard'

// The board's session card. Built from the shared primitives (ctx meter, handover pill, card menu, terminal button,
// mini stage rail, parent chip); nothing here re-implements what they cover.

// Extra bottom padding a working leaf's ctx row absorbs from its missing footer.
const WORKING_LEAF_CTX_PADDING_PX = 18
const CARD_CREATURE_SIZE_PX = 24

export interface SessionCardProps {
  task: Task
  now: number
  isOffFocus: boolean
  onToggleOffFocus: (slug: string) => void
  onOpenDetail: OpenTask
  creaturePlacement: CreaturePlacement
}

export function SessionCard({ task, now, isOffFocus, onToggleOffFocus, onOpenDetail, creaturePlacement }: SessionCardProps) {
  const ctx = task.contextPct ?? null
  const isCtxWarning = ctx !== null && ctx >= CTX_WARN_THRESHOLD
  // A working leaf gets no footer, so its ctx row absorbs the freed space.
  const isFooterless = isWorkingLeaf(task)
  // Offered while a session is parked, never mid-turn: a handover is staged
  // INTO that session's own tab, so it wants the session idle enough to
  // receive it.
  const shouldShowHandover = ctxIsHot(ctx) && task.status !== 'working'
  // Same visual treatment either way, just a different source field.
  const shouldShowCtxWarning = !task.orphaned && isCtxWarning
  const reasonText = task.waitingReason || task.pausedReason
  const view = cardStageView(task)
  const isNeedsYou = view.attention === 'needs-you'
  const prNumber = findPrNumber(task)
  const creature = creaturePlacement === 'header' ? task.creature : null

  const handleTitleClick = (event: MouseEvent<HTMLAnchorElement>) => openOnPlainClick(event, () => onOpenDetail(task.slug))

  // Clicking anywhere else on the card (but not one of its own buttons,
  // links or open menu) opens the detail view.
  const handleCardClick = (event: MouseEvent<HTMLDivElement>) => {
    if (shouldIgnoreOpenClick(event)) return
    onOpenDetail(task.slug)
  }

  return (
    <div
      className={`card session-card card-${task.orphaned ? 'waiting' : task.status}${task.attentionStatus === 'needs-you' ? ' is-needs-you' : ''}`}
      data-slug={task.slug}
      data-testid="task-card"
      data-status={task.attentionStatus}
      data-lifecycle-status={task.status}
      data-stage={task.stage || ''}
      data-repo={task.repo}
      onClick={handleCardClick}
    >
      <div className="card-header-row" data-testid="card-header">
        {creature && (
          <span className="card-creature">
            <Creature creature={creature} size={CARD_CREATURE_SIZE_PX} isWorking={isTaskWorking(task)} />
            <span className="creature-name" data-testid="creature-name">{creature.name}</span>
          </span>
        )}
        <CardStatusPill task={task} />
        <div className="card-header-right">
          <span
            className="card-time"
            data-testid="card-time"
            data-updated-at={String(task.updatedAt)}
            title={task.completedAtSource === 'status-mtime' ? 'Estimated from STATUS update time — no merge commit found' : undefined}
          >
            {relTime(task.updatedAt, now)}
          </span>
          {hasLiveTerminal(task) && <TerminalIconButton slug={task.slug} dataAction="focus" />}
          <CardMenu task={task} isOffFocus={isOffFocus} onToggleOffFocus={() => onToggleOffFocus(task.slug)} />
        </div>
      </div>

      <div className="card-title-block" data-testid="card-title-block">
        <div className="card-title-line">
          <a
            href={taskUrl(task.slug)}
            className="card-title"
            data-testid="card-title"
            data-action="open-detail"
            data-slug={task.slug}
            onClick={handleTitleClick}
          >
            {task.title}
          </a>
          {isOffFocus && <span className="drift-pill" data-testid="card-off-focus-chip">off focus</span>}
          {task.autoMode && (
            <span className="card-auto-badge" data-testid="card-auto-badge" title="Advances automatically — auto mode is on for this task">⚡</span>
          )}
        </div>
        <div className="card-slug-row" data-testid="card-slug-row">
          <DesignBranchIcon />
          {task.repo && (
            <>
              <span className="card-slug-project">{task.repo}</span>
              <span className="card-slug-sep">/</span>
            </>
          )}
          <span className="card-slug-value">{task.slug}</span>
          <CopySlugButton slug={task.slug} />
          <PrLink slug={task.slug} prNumber={prNumber} />
        </div>
        <ParentLinkChip projectTitle={task.projectTitle} projectBase={task.projectBase} testId="ms-parent-link" onNavigate={onOpenDetail} />
      </div>

      <div className={`card-rail-row${isNeedsYou ? ' has-labels' : ''}`}>
        <MiniStageRail task={{ status: task.status, stage: view.stage, stageHistory: task.stageHistory }} stageIds={MINI_RAIL_STAGES} tone={view.tone} showLabels={isNeedsYou} />
      </div>

      {isNeedsYou && view.summary && <StageSummaryCallout summary={view.summary} tone={view.tone} icon={view.summaryIcon} />}
      {task.approvalPrompt && <ApprovalCallout slug={task.slug} prompt={task.approvalPrompt} />}
      {task.orphaned && <div className="ctx-warning" data-testid="card-orphan-warning">⚠ Tab closed but STATUS still "working" — verify and mark done</div>}
      {shouldShowCtxWarning && <div className="ctx-warning" data-testid="card-ctx-warning">⚠ Context at {ctx}% — consider /pipelinely-handover</div>}
      {!isNeedsYou && reasonText && <div className="card-note" data-testid="card-note">{reasonText}</div>}

      <div className="card-ctx-row" style={{ marginTop: 'auto', paddingBottom: isFooterless ? WORKING_LEAF_CTX_PADDING_PX : undefined }}>
        <CtxMeter ctx={ctx} fillColor={STAGE_TONE_VARS[view.tone].c} testIds={{ track: 'ctx-meter', fill: 'ctx-meter-fill', pct: 'ctx-value' }} />
        {shouldShowHandover && <HandoverPill testId="card-handover" send={(options) => postHandover(task.slug, options)} dataAttrs={{ action: 'handover', slug: task.slug }} />}
      </div>

      {!isFooterless && <CardFooter task={task} onOpenDetail={onOpenDetail} />}
    </div>
  )
}
