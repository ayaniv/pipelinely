import type { MilestoneStatus, Task } from '../../../../../src/types'
import { stageChainKindFor, type StageChainKind } from '../../../pipelineStages'
import { isFanoutParent } from '../../../taskScope'
import type { TaskDetailNav } from '../detailNav'

// What the graph slot draws for one open task, as a typed value the slot
// switches over.
export type GraphSlotTarget =
  | { kind: 'stage-chain'; stages: StageChainKind }
  // A fan-out parent's own five-node chart, shown whatever stage is selected.
  | { kind: 'parent-chart' }
  | { kind: 'milestone-detail'; milestone: MilestoneStatus }

export function resolveGraphSlot(task: Task, nav: TaskDetailNav): GraphSlotTarget {
  if (!isFanoutParent(task)) {
    // A dispatched milestone child (projectTitle is set only for that shape)
    // never does its own planning — its plan lives in the parent's
    // tech-design.md — so opened on its own it shows the same six-stage chain
    // as the parent's drill-down. The chain is decided by the task alone
    // (projectTitle, then kind), whether or not the parent has loaded yet.
    return { kind: 'stage-chain', stages: stageChainKindFor(task) }
  }
  // Only a drill-down from Dev swaps the parent's chart for one milestone's
  // own; the milestone list itself is Dev's panel body, not a graph.
  const milestone = nav.l1Tab === 'dev' ? task.milestones?.find((candidate) => candidate.id === nav.milestoneId) : undefined
  return milestone ? { kind: 'milestone-detail', milestone } : { kind: 'parent-chart' }
}
