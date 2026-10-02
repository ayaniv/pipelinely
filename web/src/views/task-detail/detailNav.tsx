import { createContext, useCallback, useContext, useState } from 'react'
import { useSearchParams } from 'react-router'
import type { Task } from '../../../../src/types'
import { initialL1Tab, isChainStageId, type ChainStageId, type L1TabId } from '../../pipelineStages'

// Where you are inside one open task detail: the fan-out parent's L1 tab, the
// drilled-into milestone, and the selected stage node. The stage selection
// lives in the URL (?stage=) — the router is its one source of truth, so a
// refresh or a shared link lands on the same stage. The L1 tab and the
// milestone are component state: they reset with the task (TaskDetail keys
// this by slug) and survive a snapshot re-render, which is all they need.

export interface TaskDetailNav {
  l1Tab: L1TabId
  // null: nothing explicitly selected yet — the panel resolves its own
  // default (see pipelineStages.ts's defaultStageTab).
  l2Tab: ChainStageId | null
  // Set while a fan-out parent's Dev tab is drilled into one milestone.
  milestoneId: string | null
}

export interface TaskDetailNavApi {
  nav: TaskDetailNav
  selectL1Tab: (id: L1TabId) => void
  // A stage-node click (or "Select findings to fix"): select the stage and
  // keep it in the URL. A replace, not a push — it is a within-task filter,
  // not a page navigation.
  selectStageTab: (id: ChainStageId) => void
  selectMilestone: (id: string) => void
  // Steps back to the milestone list — a different destination from the
  // header's Back, which leaves the task entirely.
  leaveMilestone: () => void
}

const STAGE_PARAM = 'stage'

export function useTaskDetailNavState(task: Task): TaskDetailNavApi {
  const [searchParams, setSearchParams] = useSearchParams()
  const [l1Tab, setL1Tab] = useState<L1TabId>(() => initialL1Tab(task))
  const [drilledMilestoneId, setDrilledMilestoneId] = useState<string | null>(null)

  const stageParam = searchParams.get(STAGE_PARAM)
  const l2Tab = stageParam && isChainStageId(stageParam) ? stageParam : null
  // The plan can lose a milestone between renders (an edit to tech-design.md),
  // so a drill-down into one that is gone is no drill-down.
  const milestoneId = task.milestones?.some((m) => m.id === drilledMilestoneId) ? drilledMilestoneId : null

  const writeStageParam = useCallback((stage: string | null) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous)
      if (stage) next.set(STAGE_PARAM, stage)
      else next.delete(STAGE_PARAM)
      return next
    }, { replace: true })
  }, [setSearchParams])

  const selectL1Tab = useCallback((id: L1TabId) => {
    setL1Tab(id)
    // Switching away from Dev leaves the drill-down; coming back starts at the
    // milestone list rather than wherever you last were.
    setDrilledMilestoneId(null)
  }, [])

  const selectMilestone = useCallback((id: string) => {
    setDrilledMilestoneId(id)
    // A stage selected on the old milestone's chain no longer applies.
    writeStageParam(null)
  }, [writeStageParam])

  const leaveMilestone = useCallback(() => setDrilledMilestoneId(null), [])

  return { nav: { l1Tab, l2Tab, milestoneId }, selectL1Tab, selectStageTab: writeStageParam, selectMilestone, leaveMilestone }
}

const TaskDetailNavContext = createContext<TaskDetailNavApi | null>(null)
export const TaskDetailNavProvider = TaskDetailNavContext.Provider

export function useTaskDetailNav(): TaskDetailNavApi {
  const api = useContext(TaskDetailNavContext)
  if (!api) throw new Error('useTaskDetailNav must be used inside a TaskDetailNavProvider (TaskDetail provides one)')
  return api
}
