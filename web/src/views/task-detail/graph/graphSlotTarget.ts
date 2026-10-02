import type { MilestoneStatus, Task } from '../../../../../src/types'
import type { StageChainKind } from '../../../pipelineStages'
import { isFanoutParent } from '../../../taskScope'
import type { TaskDetailNav } from '../detailNav'

// What the graph slot draws for one open task, as a typed value the slot
// switches over.
export type GraphSlotTarget =
  | { kind: 'none' } // a fan-out parent's Plan / Plan Review tab: no graph
  | { kind: 'stage-chain'; stages: StageChainKind }
  | { kind: 'milestone-graph' }
  | { kind: 'milestone-detail'; milestone: MilestoneStatus }

export function resolveGraphSlot(task: Task, nav: TaskDetailNav): GraphSlotTarget {
  if (!isFanoutParent(task)) {
    // A dispatched milestone child (projectTitle is set only for that shape)
    // never does its own planning — its plan lives in the parent's
    // tech-design.md — so opened on its own it shows the same six-stage chain
    // as the parent's drill-down. The chain's length is decided by
    // projectTitle alone, whether or not the parent has loaded yet.
    return { kind: 'stage-chain', stages: task.projectTitle ? 'milestone' : 'flat' }
  }
  // A fan-out parent's Plan and Plan Review tabs are the panel's; only the Dev
  // tab has a graph.
  if (nav.l1Tab !== 'dev') return { kind: 'none' }
  const milestone = task.milestones?.find((candidate) => candidate.id === nav.milestoneId)
  return milestone ? { kind: 'milestone-detail', milestone } : { kind: 'milestone-graph' }
}
