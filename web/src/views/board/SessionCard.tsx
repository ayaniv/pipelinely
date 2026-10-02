import type { MouseEvent } from 'react'
import type { Task } from '../../../../src/types'
import { postHandover } from '../../api/actions'
import { CardMenu } from '../../components/CardMenu'
import { CopySlugButton } from '../../components/CopySlugButton'
import { CtxMeter } from '../../components/CtxMeter'
import { HandoverPill } from '../../components/HandoverPill'
import { DesignBranchIcon } from '../../components/icons'
import { MiniStageRail } from '../../components/MiniStageRail'
import { ParentLinkChip } from '../../components/ParentLinkChip'
import { TerminalIconButton } from '../../components/TerminalIconButton'
import { CTX_WARN_THRESHOLD, ctxIsHot, relTime } from '../../format'
import { isFanoutParent } from '../../taskScope'
import { ApprovalCallout } from './ApprovalCallout'
import { CardFooter } from './CardFooter'
import { CardStatusPill } from './CardStatusPill'

// The board's session card. Built from the shared primitives (ctx meter, handover pill, card menu, terminal button,
// mini stage rail, parent chip); nothing here re-implements what they cover.

const MINI_RAIL_STAGES = ['planning', 'dev', 'cr', 'qa', 'merge']
// Extra bottom padding a working leaf's ctx row absorbs from its missing footer.
const WORKING_LEAF_CTX_PADDING_PX = 18

export interface SessionCardProps {
  task: Task
  now: number
  isOffFocus: boolean
  onToggleOffFocus: (slug: string) => void
  onOpenDetail: (slug: string) => void
}

export function SessionCard({ task, now, isOffFocus, onToggleOffFocus, onOpenDetail }: SessionCardProps) {
  const ctx = task.contextPct ?? null
  const isCtxWarning = ctx !== null && ctx >= CTX_WARN_THRESHOLD
  // A working LEAF is already doing the thing, so it gets no footer and its
  // ctx row absorbs the freed space. A milestone-declaring PARENT keeps its
  // footer even while working — its own session running says nothing about
  // whether its milestones need attention.
  const isWorkingLeaf = !isFanoutParent(task) && task.status === 'working'
  // Offered while a session is parked, never mid-turn: a handover is staged
  // INTO that session's own tab, so it wants the session idle enough to
  // receive it.
  const shouldShowHandover = ctxIsHot(ctx) && task.status !== 'working'
  // Same visual treatment either way, just a different source field.
  const shouldShowCtxWarning = !task.orphaned && isCtxWarning
  const reasonText = task.waitingReason || task.pausedReason

  // Clicking anywhere else on the card (but not one of its own buttons,
  // links or open menu) opens the detail view.
  const handleCardClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button, a, .card-menu')) return
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
      <div className="card-header-row">
        <CardStatusPill task={task} />
        {isOffFocus && <span className="drift-pill">off focus</span>}
        <div className="card-header-right">
          <span
            className="card-time"
            data-testid="card-time"
            data-updated-at={String(task.updatedAt)}
            title={task.completedAtSource === 'status-mtime' ? 'Estimated from STATUS update time — no merge commit found' : undefined}
          >
            {relTime(task.updatedAt, now)}
          </span>
          <TerminalIconButton slug={task.slug} status={task.status} dataAction="focus" />
          <CardMenu task={task} isOffFocus={isOffFocus} onToggleOffFocus={() => onToggleOffFocus(task.slug)} />
        </div>
      </div>

      <div className="card-title-block">
        <a
          href="#"
          className="card-title"
          data-testid="card-title"
          data-action="open-detail"
          data-slug={task.slug}
          onClick={(event) => {
            event.preventDefault()
            onOpenDetail(task.slug)
          }}
        >
          {task.title}
        </a>
        {task.autoMode && (
          <span className="card-auto-badge" data-testid="card-auto-badge" title="Advances automatically — auto mode is on for this task">⚡</span>
        )}
        <div className="card-slug-row">
          <DesignBranchIcon />
          {task.repo && (
            <>
              <span className="card-slug-project">{task.repo}</span>
              <span className="card-slug-sep">/</span>
            </>
          )}
          <span className="card-slug-value">{task.slug}</span>
          <CopySlugButton slug={task.slug} />
        </div>
        <ParentLinkChip projectTitle={task.projectTitle} projectBase={task.projectBase} testId="ms-parent-link" onNavigate={onOpenDetail} />
      </div>

      <div className="card-rail-row">
        <MiniStageRail task={task} stageIds={MINI_RAIL_STAGES} />
      </div>

      {task.approvalPrompt && <ApprovalCallout slug={task.slug} prompt={task.approvalPrompt} />}
      {task.orphaned && <div className="ctx-warning" data-testid="card-orphan-warning">⚠ Tab closed but STATUS still "working" — verify and mark done</div>}
      {shouldShowCtxWarning && <div className="ctx-warning" data-testid="card-ctx-warning">⚠ Context at {ctx}% — consider /pipelinely-handover</div>}
      {reasonText && <div className="card-note" data-testid="card-note">{reasonText}</div>}

      <div className="card-ctx-row" style={{ marginTop: 'auto', paddingBottom: isWorkingLeaf ? WORKING_LEAF_CTX_PADDING_PX : undefined }}>
        <CtxMeter ctx={ctx} testIds={{ track: 'ctx-meter', fill: 'ctx-meter-fill', pct: 'ctx-value' }} />
        {shouldShowHandover && <HandoverPill testId="card-handover" send={(options) => postHandover(task.slug, options)} dataAttrs={{ action: 'handover', slug: task.slug }} />}
      </div>

      {!isWorkingLeaf && <CardFooter task={task} onOpenDetail={onOpenDetail} />}
    </div>
  )
}
