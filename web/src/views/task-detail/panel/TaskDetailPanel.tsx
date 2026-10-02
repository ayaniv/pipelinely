import type { ReactNode } from 'react'
import type { Task } from '../../../../../src/types'
import { useSnapshot } from '../../../data/snapshot'
import { ViewBoundary } from '../../../shell/ViewBoundary'
import { isFanoutParent } from '../../../taskScope'
import type { TaskDetailNav } from '../detailNav'
import { L1Tabs } from './L1Tabs'
import { PanelNote } from './PanelLayout'
import { PlanTab } from './PlanTab'
import { StagePanel } from './StagePanel'
import { resolvePanelTarget, type PanelTarget } from './panelTarget'

// The task-detail PANEL slot: the L1 tab bar of a fan-out parent, the
// plan/plan-review tab, and every L2 stage panel body. The graph slot (stage
// chain, wave grid, milestone cards) is handed in and rendered where the
// design puts it: for a fan-out parent, inside the .l1-panel the L1 tabs lead
// into; for everyone else, directly ahead of the panel.

function renderTarget(target: PanelTarget, openTaskSlug: string): ReactNode {
  switch (target.kind) {
    case 'none':
      return null
    case 'loading-milestone':
      return <PanelNote testId="milestone-loading-note">Loading this milestone&apos;s details…</PanelNote>
    case 'plan':
      return <PlanTab task={target.task} stage={target.stage} />
    case 'stage':
      return <StagePanel tab={target.tab} child={target.child} extra={target.extra} openTaskSlug={openTaskSlug} />
  }
}

// Wraps a target in the bordered stage-panel card. A fan-out parent's plan
// tab is the exception: it sits in its .l1-panel with no card of its own.
function wrapInCard(isFanout: boolean, target: PanelTarget, content: ReactNode): ReactNode {
  if (target.kind === 'none') return null
  if (isFanout && target.kind === 'plan') return content
  return <div className="l2-panel" data-testid="l2-panel">{content}</div>
}

export interface TaskDetailPanelProps {
  task: Task
  nav: TaskDetailNav
  graph: ReactNode
}

export function TaskDetailPanel({ task, nav, graph }: TaskDetailPanelProps) {
  const { data } = useSnapshot()
  const isFanout = isFanoutParent(task)
  const target = resolvePanelTarget(task, nav, data?.tasks ?? [])

  // Keyed by task so one task's crash never blanks the next one opened.
  const panelSlot = (
    <div data-testid="detail-panel-slot">
      <ViewBoundary key={task.slug} view="task-detail-panel">
        {wrapInCard(isFanout, target, renderTarget(target, task.slug))}
      </ViewBoundary>
    </div>
  )

  if (!isFanout) return <>{graph}{panelSlot}</>

  return (
    <>
      <L1Tabs task={task} activeTab={nav.l1Tab} />
      <div className="l1-panel" data-testid="l1-panel">{graph}{panelSlot}</div>
    </>
  )
}
