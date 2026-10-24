import type { MilestoneStatus, Task } from '../../../../../src/types'
import { isMilestoneReadyForDev } from '../../../../../src/nextStageCta'
import { MILESTONE_STATE_LABEL, milestoneChildSlug } from '../../../milestoneModel'
import { MILESTONE_CHAIN_STAGES, chainStagesFor, isStagePanelTabId, resolveStageTab, stageChainKindFor, type StagePanelTabId } from '../../../pipelineStages'
import { isFanoutParent } from '../../../taskScope'
import type { TaskDetailNav } from '../detailNav'
import type { PlanStage } from './PlanTab'
import type { StagePanelExtra } from './stageBodies'

// What the panel slot shows for one open task, as a typed value the view
// switches over.

export type ParentMilestoneStage = 'cr' | 'qa' | 'merge'

export type PanelTarget =
  | { kind: 'none' }
  // A milestone child opened on its own, before its parent (which holds its
  // declaration) has arrived in the snapshot.
  | { kind: 'loading-milestone' }
  | { kind: 'plan'; task: Task; stage: PlanStage }
  // A fan-out parent's Dev body: the project summary and the wave graph.
  | { kind: 'milestone-graph'; task: Task }
  // A fan-out parent's Code review, QA or Merge: the milestones sitting there.
  | { kind: 'parent-stage'; stage: ParentMilestoneStage; milestones: MilestoneStatus[] }
  | { kind: 'stage'; tab: StagePanelTabId; child: Task | null; extra: StagePanelExtra }

// A flat task has no declared dependencies, so its dispatch block carries
// only a state label derived from its own status/stage.
function flatStateLabel(task: Task): string {
  if (task.status === 'done') return MILESTONE_STATE_LABEL.done
  if (task.stage === 'planning' || task.stage === 'plan-review') return 'Not started'
  return MILESTONE_STATE_LABEL.dispatched
}

function fanoutTarget(task: Task, nav: TaskDetailNav): PanelTarget {
  switch (nav.l1Tab) {
    case 'planning':
      return { kind: 'plan', task, stage: 'planning' }
    case 'plan-review':
      return { kind: 'plan', task, stage: 'plan-review' }
    case 'cr':
    case 'qa':
    case 'merge':
      return { kind: 'parent-stage', stage: nav.l1Tab, milestones: task.milestones ?? [] }
    case 'dev': {
      const milestones = task.milestones ?? []
      const milestone = milestones.find((m) => m.id === nav.milestoneId)
      // The plan can lose a milestone between renders (an edit to
      // tech-design.md), so a drill-down into one that is gone is no drill-down.
      if (!milestone) return { kind: 'milestone-graph', task }

      const tab = resolveStageTab(nav.l2Tab, MILESTONE_CHAIN_STAGES, milestone.task)
      return {
        kind: 'stage',
        tab: isStagePanelTabId(tab) ? tab : 'dev',
        child: milestone.task,
        extra: {
          needs: milestone.needs,
          stateLabel: MILESTONE_STATE_LABEL[milestone.state],
          readyForDev: isMilestoneReadyForDev(milestone, new Map(milestones.map((m) => [m.id, m])), task.stageHistory),
          milestoneSlug: milestoneChildSlug(task.slug, milestone.id),
        },
      }
    }
  }
}

function milestoneChildTarget(task: Task, nav: TaskDetailNav, allTasks: Task[]): PanelTarget {
  const parent = allTasks.find((t) => t.slug === task.projectBase)
  const own = parent?.milestones?.find((m) => m.task?.slug === task.slug)
  if (!own) return { kind: 'loading-milestone' }

  const tab = resolveStageTab(nav.l2Tab, MILESTONE_CHAIN_STAGES, task)
  return { kind: 'stage', tab: isStagePanelTabId(tab) ? tab : 'dev', child: task, extra: { needs: own.needs, stateLabel: MILESTONE_STATE_LABEL[own.state] } }
}

function flatTarget(task: Task, nav: TaskDetailNav): PanelTarget {
  const tab = resolveStageTab(nav.l2Tab, chainStagesFor(stageChainKindFor(task)), task)
  if (isStagePanelTabId(tab)) return { kind: 'stage', tab, child: task, extra: { needs: null, stateLabel: flatStateLabel(task) } }
  return { kind: 'plan', task, stage: tab }
}

export function resolvePanelTarget(task: Task, nav: TaskDetailNav, allTasks: Task[]): PanelTarget {
  if (isFanoutParent(task)) return fanoutTarget(task, nav)
  // A dispatched milestone child never does its own planning (its plan lives
  // in the parent's tech-design.md), so it gets the six-stage chain. The
  // chain's length is decided by projectTitle alone, whether or not its
  // parent has loaded yet.
  if (task.projectTitle) return milestoneChildTarget(task, nav, allTasks)
  return flatTarget(task, nav)
}
