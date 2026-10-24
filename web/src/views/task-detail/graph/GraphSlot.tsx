import { lazy } from 'react'
import type { Task } from '../../../../../src/types'
import type { Logger } from '../../../log'
import { MilestoneDetailHead } from '../MilestoneDetailHead'
import { useTaskDetailNav } from '../detailNav'
import { resolveGraphSlot, type GraphSlotTarget } from './graphSlotTarget'

// The task-detail graph slot: the pipeline chart for a flat task, milestone
// child or fan-out parent, or a drilled-into milestone's header and own chart.
// The plan tab, the parent's wave graph and every stage panel are the
// panel's (panel/TaskDetailPanel.tsx), which renders this slot where the
// design puts it.

// React Flow is ~150 kB and only task detail draws graphs, so the charts and
// the wave graph load as one lazy chunk instead of weighing down every dashboard page load. This
// suspends while the chunk is in flight: the nearest Suspense boundary
// (TaskDetail's, around the whole pipeline view) holds back the graph AND the
// panel together, so nothing above the panel's buttons appears later and
// pushes them out from under a click.
const loadStageChainGraph = () => import('./StageChainGraph').then((module) => ({ default: module.StageChainGraph }))
const loadParentChartGraph = () => import('./StageChainGraph').then((module) => ({ default: module.ParentChartGraph }))
const loadWaveGraph = () => import('./WaveGraph').then((module) => ({ default: module.WaveGraph }))
const StageChainGraph = lazy(loadStageChainGraph)
const ParentChartGraph = lazy(loadParentChartGraph)
// A fan-out parent's Dev panel renders the wave graph through the same lazy
// import, so React Flow is still one chunk.
export const LazyWaveGraph = lazy(loadWaveGraph)

// Starts the chunk loading before a task is on screen (the route mounting is
// the earliest signal), so by the time the snapshot has arrived and the graph
// is wanted it is usually already here. A failed preload is logged, and the
// real load on first use surfaces the same failure to the view's boundary.
export function preloadGraphs(log: Logger = console.error): void {
  for (const load of [loadStageChainGraph, loadWaveGraph]) {
    load().catch((err: unknown) => log('[task-detail] could not preload the graph chunk', err))
  }
}

export function GraphSlot({ task }: { task: Task }) {
  const { nav, leaveMilestone } = useTaskDetailNav()
  return <GraphSlotContent task={task} target={resolveGraphSlot(task, nav)} onBackToMilestones={leaveMilestone} />
}

function GraphSlotContent({ task, target, onBackToMilestones }: { task: Task; target: GraphSlotTarget; onBackToMilestones: () => void }) {
  switch (target.kind) {
    case 'stage-chain':
      return <StageChainGraph child={task} stages={target.stages} />
    case 'parent-chart':
      return <ParentChartGraph task={task} />
    case 'milestone-detail':
      return (
        <>
          <div data-testid="milestone-detail-head-slot"><MilestoneDetailHead parent={task} milestone={target.milestone} onBackToMilestones={onBackToMilestones} /></div>
          <StageChainGraph child={target.milestone.task ?? null} stages="milestone" />
        </>
      )
  }
}
