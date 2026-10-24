import type { MouseEvent } from 'react'
import type { CreaturePlacement, Task } from '../../../../src/types'
import { postHandover } from '../../api/actions'
import { CardMenu } from '../../components/CardMenu'
import { CopySlugButton } from '../../components/CopySlugButton'
import { Creature } from '../../components/Creature'
import { CtxMeter } from '../../components/CtxMeter'
import { HandoverPill } from '../../components/HandoverPill'
import { ParentLinkChip } from '../../components/ParentLinkChip'
import { PrLink } from '../../components/PrLink'
import { TerminalIconButton } from '../../components/TerminalIconButton'
import { ctxIsHot, relTime } from '../../format'
import type { OpenTask } from '../../shell/appNavigation'
import { taskUrl } from '../../shell/routes'
import { STAGE_TONE_VARS, cardCtaPair, cardStageView } from '../../stageView'
import { findPrNumber, hasLiveTerminal, isTaskWorking } from '../../taskScope'
import { ApprovalCallout } from './ApprovalCallout'
import { CardFooter } from './CardFooter'
import { CardStatusPill } from './CardStatusPill'
import { openOnPlainClick, shouldIgnoreOpenClick } from './rowOpenGuard'
import type { TableColumn, TableGroupKey } from './tableColumns'
import { runningStateText } from './tableSort'

const ROW_CREATURE_SIZE_PX = 22

export interface TableRowProps {
  task: Task
  group: TableGroupKey
  columns: TableColumn[]
  index: number
  now: number
  isOffFocus: boolean
  onToggleOffFocus: (slug: string) => void
  onOpenDetail: OpenTask
  creaturePlacement: CreaturePlacement
}

function TaskCell({ task, now, isOffFocus, onOpenDetail, creaturePlacement }: Pick<TableRowProps, 'task' | 'now' | 'isOffFocus' | 'onOpenDetail' | 'creaturePlacement'>) {
  const creature = creaturePlacement === 'header' ? task.creature : null
  return (
    <>
      {creature && (
        <span className="row-creature">
          <Creature creature={creature} size={ROW_CREATURE_SIZE_PX} isWorking={isTaskWorking(task)} />
          <span className="row-creature-name" data-testid="row-creature-name">{creature.name}</span>
        </span>
      )}
      <span className="row-task-text">
        <span className="row-time" data-testid="row-time">{relTime(task.updatedAt, now)}</span>
        <span className="card-title-line">
          <a
            href={taskUrl(task.slug)}
            className="card-title"
            data-testid="card-title"
            data-action="open-detail"
            data-slug={task.slug}
            onClick={(event: MouseEvent<HTMLAnchorElement>) => openOnPlainClick(event, () => onOpenDetail(task.slug))}
          >
            {task.title}
          </a>
          {isOffFocus && <span className="drift-pill" data-testid="card-off-focus-chip">off focus</span>}
        </span>
        <span className="card-slug-row">
          <span className="card-slug-value">{task.slug}</span>
          <CopySlugButton slug={task.slug} />
        </span>
        <ParentLinkChip projectTitle={task.projectTitle} projectBase={task.projectBase} testId="ms-parent-link" onNavigate={onOpenDetail} />
      </span>
    </>
  )
}

function StateCell({ task, group }: Pick<TableRowProps, 'task' | 'group'>) {
  const view = cardStageView(task)
  if (group === 'working') return <span className="table-running-text">{runningStateText(task)}</span>
  return (
    <>
      {view.summary && (
        <span className="table-state-text">
          <span className="table-state-head" data-testid="table-state-head" style={{ color: STAGE_TONE_VARS[view.tone].ink }}>{view.summary.head}</span>
          {view.summary.rest && <span className="table-state-rest" data-testid="table-state-rest">{view.summary.rest}</span>}
        </span>
      )}
      {task.approvalPrompt && <ApprovalCallout slug={task.slug} prompt={task.approvalPrompt} />}
    </>
  )
}

function CtxCell({ task }: { task: Task }) {
  const ctx = task.contextPct ?? null
  const shouldShowHandover = ctxIsHot(ctx) && task.status !== 'working'
  return (
    <>
      <span className="row-ctx-meter" data-testid="row-ctx-meter">
        <CtxMeter ctx={ctx} fillColor={STAGE_TONE_VARS[cardStageView(task).tone].c} isLabelled={false} />
      </span>
      {shouldShowHandover && <HandoverPill testId="row-handover" send={(options) => postHandover(task.slug, options)} dataAttrs={{ action: 'handover', slug: task.slug }} />}
    </>
  )
}

function ActionsCell({ task, isOffFocus, onToggleOffFocus }: Pick<TableRowProps, 'task' | 'isOffFocus' | 'onToggleOffFocus'>) {
  return (
    <>
      <span className="row-actions-buttons">
        {hasLiveTerminal(task) && <TerminalIconButton slug={task.slug} dataAction="focus" />}
        <CardMenu task={task} isOffFocus={isOffFocus} onToggleOffFocus={() => onToggleOffFocus(task.slug)} />
      </span>
      <PrLink slug={task.slug} prNumber={findPrNumber(task)} />
    </>
  )
}

export function TableRow(props: TableRowProps) {
  const { task, group, columns, index, onOpenDetail } = props
  const renderCell = (key: TableColumn['key']) => {
    switch (key) {
      case 'task': return <TaskCell {...props} />
      case 'project': return <span className="row-project">{task.repo}</span>
      case 'stage': return <CardStatusPill task={task} />
      case 'state': return <StateCell task={task} group={group} />
      case 'ctx': return <CtxCell task={task} />
      case 'next': return cardCtaPair(task) ? <CardFooter task={task} variant="row" onOpenDetail={onOpenDetail} /> : null
      case 'actions': return <ActionsCell {...props} />
    }
  }

  return (
    <div
      role="row"
      className="table-row"
      data-testid="table-row"
      data-slug={task.slug}
      aria-rowindex={index + 2}
      data-is-first={index === 0 || undefined}
      onClick={(event) => { if (!shouldIgnoreOpenClick(event)) onOpenDetail(task.slug) }}
    >
      {columns.map((column) => (
        <div
          key={column.key}
          role="cell"
          className={`table-cell table-cell-${column.key}`}
          data-testid={`table-cell-${column.key}`}
          data-running-stage={column.key === 'state' && group === 'working' ? (cardStageView(task).stage ?? task.stage ?? undefined) : undefined}
        >
          {renderCell(column.key)}
        </div>
      ))}
    </div>
  )
}
