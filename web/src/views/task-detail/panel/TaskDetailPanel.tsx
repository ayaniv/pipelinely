import type { ReactNode } from 'react'
import type { Task } from '../../../../../src/types'
import { useSnapshot } from '../../../data/snapshot'
import { ViewBoundary } from '../../../shell/ViewBoundary'
import { isFanoutParent } from '../../../taskScope'
import type { TaskDetailNav } from '../detailNav'
import { ProjectSummary } from '../ProjectSummary'
import { PanelNote } from './PanelLayout'
import { ParentStageList } from './ParentStageList'
import { PlanTab } from './PlanTab'
import { StagePanel } from './StagePanel'
import { WavePanel } from './WavePanel'
import { resolvePanelTarget, type PanelTarget } from './panelTarget'

// The task-detail PANEL slot: the plan/plan-review tab, a fan-out parent's
// Dev body and per-stage milestone lists, and every L2 stage panel body. The
// graph slot (the pipeline chart) is handed in and rendered directly ahead of
// the panel.

function renderTarget(target: PanelTarget, openTaskSlug: string): ReactNode {
  switch (target.kind) {
    case 'none':
      return null
    case 'loading-milestone':
      return <PanelNote testId="milestone-loading-note">Loading this milestone&apos;s details…</PanelNote>
    case 'plan':
      return <PlanTab task={target.task} stage={target.stage} />
    case 'milestone-graph':
      return (
        <>
          <div data-testid="project-summary-slot"><ProjectSummary task={target.task} /></div>
          <WavePanel task={target.task} />
        </>
      )
    case 'parent-stage':
      return <ParentStageList stage={target.stage} milestones={target.milestones} />
    case 'stage':
      return <StagePanel tab={target.tab} child={target.child} extra={target.extra} openTaskSlug={openTaskSlug} />
  }
}

// Wraps a target in the bordered stage-panel card. A fan-out parent's own
// bodies (its plan, milestone list and per-stage lists) are the exception:
// they sit directly under the chart with no card of its own.
function wrapInCard(isFanout: boolean, target: PanelTarget, content: ReactNode): ReactNode {
  switch (target.kind) {
    case 'none':
      return null
    case 'milestone-graph':
    case 'parent-stage':
      return content
    case 'plan':
      return isFanout ? content : <div className="l2-panel" data-testid="l2-panel">{content}</div>
    default:
      return <div className="l2-panel" data-testid="l2-panel">{content}</div>
  }
}

export interface TaskDetailPanelProps {
  task: Task
  nav: TaskDetailNav
  graph: ReactNode
}

export function TaskDetailPanel({ task, nav, graph }: TaskDetailPanelProps) {
  const { data } = useSnapshot()
  const target = resolvePanelTarget(task, nav, data?.tasks ?? [])

  // Keyed by task so one task's crash never blanks the next one opened.
  return (
    <>
      {graph}
      <div data-testid="detail-panel-slot">
        <ViewBoundary key={task.slug} view="task-detail-panel">
          {wrapInCard(isFanoutParent(task), target, renderTarget(target, task.slug))}
        </ViewBoundary>
      </div>
    </>
  )
}
