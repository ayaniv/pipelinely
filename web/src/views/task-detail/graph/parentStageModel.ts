import type { Task } from '../../../../../src/types'
import { computeNextStageCta } from '../../../../../src/nextStageCta'
import { FLAT_CHAIN_STAGES, STAGE_CHAIN_GROUPS, type ChainStageId } from '../../../pipelineStages'
import { stageToneOf } from '../../../stageView'
import { buildWaves, milestoneStage, type MilestoneStage } from '../../../waveModel'
import { panelHeaderPill } from '../panel/panelHeader'
import { stageNodeState, type StageChainEdge, type StageChainModel, type StageChainNode } from './stageChainModel'

// A fan-out parent's five chart nodes. The parent never runs Dev, Code review,
// QA or Merge itself: those nodes summarise its milestones. It is "current" at
// the earliest stage any unfinished milestone is in; stages every milestone has
// passed are done and the rest are not started (QUESTIONS.md #6).

const PARENT_STAGE_IDS: ChainStageId[] = ['planning', 'dev', 'cr', 'qa', 'merge']
const CURRENT_INDEX_WHEN_ALL_MERGED = -1
const STAGE_INDEX: Record<MilestoneStage, number> = { dev: 1, cr: 2, qa: 3, merge: 4 }

// The parent is still in its own planning while it has no milestones declared
// or its plan has not been handed to Dev. computeNextStageCta also covers a
// plan review that just finished while task.stage still lags behind.
function isParentPlanning(task: Task): boolean {
  if (!task.milestones?.length) return true
  const isStillPlanStage = task.stage === 'planning' || task.stage === 'plan-review'
  return isStillPlanStage && computeNextStageCta(task)?.stage !== 'dev'
}

function currentStageIndex(task: Task): number {
  if (isParentPlanning(task)) return 0
  const unfinished = (task.milestones ?? []).map(milestoneStage).filter((stage): stage is MilestoneStage => stage !== null)
  if (!unfinished.length) return CURRENT_INDEX_WHEN_ALL_MERGED
  return Math.min(...unfinished.map((stage) => STAGE_INDEX[stage]))
}

function countIn(task: Task, stage: MilestoneStage): number {
  return (task.milestones ?? []).filter((milestone) => milestoneStage(milestone) === stage).length
}

function devSub(task: Task, isPlanning: boolean): string {
  if (isPlanning) return 'not started'
  const waves = buildWaves(task.milestones ?? [])
  const runningIndex = waves.findIndex((wave) => wave.state === 'running')
  return runningIndex < 0 ? 'all merged' : `wave ${runningIndex + 1} of ${waves.length}`
}

function subOf(task: Task, id: ChainStageId, tabId: ChainStageId): string {
  const milestones = task.milestones ?? []
  const isPlanning = isParentPlanning(task)
  switch (id) {
    case 'planning':
      return panelHeaderPill(task, tabId).label
    case 'dev':
      return devSub(task, isPlanning)
    case 'cr':
      return `${countIn(task, 'cr')} in review`
    case 'qa':
      return `${countIn(task, 'qa')} in QA`
    default:
      return `${milestones.filter((milestone) => milestone.state === 'done').length} of ${milestones.length} merged`
  }
}

export function parentStageNodes(task: Task): StageChainNode[] {
  const currentIndex = currentStageIndex(task)
  const isPlanning = isParentPlanning(task)
  const recordedStages = new Set(task.stageHistory.map((event) => event.stage))
  return PARENT_STAGE_IDS.map((id, index) => {
    const chainStage = FLAT_CHAIN_STAGES.find((stage) => stage.id === id)!
    const state = currentIndex === CURRENT_INDEX_WHEN_ALL_MERGED || index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo'
    // Planning is one node for both planning and plan review; a click goes to
    // the furthest of the two that was recorded, as the stage chain does.
    const tabId: ChainStageId = id === 'planning' && recordedStages.has('plan-review') ? 'plan-review' : id
    const sub = subOf(task, id, tabId)
    return {
      id,
      tabId,
      label: chainStage.label,
      index,
      isSelected: false,
      isDone: state === 'done',
      isUnrecorded: false,
      isTaskStage: state === 'current',
      state,
      sub,
      tone: stageToneOf(chainStage.stage),
      dotGroups: id === 'dev' && !isPlanning ? buildWaves(task.milestones ?? []).map((wave) => wave.cards.map((card) => ({ milestoneId: card.id, status: card.status }))) : undefined,
      stateClass: stageNodeState(false, state === 'done', false),
      stateWord: state === 'current' ? 'current' : state === 'done' ? 'done' : '—',
      note: sub,
      when: null,
    }
  })
}

export function isParentStageSelected(node: StageChainNode, selected: ChainStageId): boolean {
  return node.id === selected || (STAGE_CHAIN_GROUPS[node.id] ?? []).includes(selected)
}

// The parent's chart model with `selected` (the L1 stage the panel shows)
// applied to its nodes.
export function parentStageChainModel(task: Task, selected: ChainStageId): StageChainModel {
  const nodes = parentStageNodes(task).map((node) => {
    const isSelected = isParentStageSelected(node, selected)
    return { ...node, isSelected, tabId: isSelected ? selected : node.tabId, stateClass: stageNodeState(isSelected, node.isDone, false) }
  })
  const edges: StageChainEdge[] = nodes.slice(1).map((node, index) => ({ sourceId: nodes[index].id, targetId: node.id, isReached: node.state !== 'todo' }))
  const selectedIndex = Math.max(0, nodes.findIndex((node) => node.isSelected))
  return { nodes, edges, selectedIndex, noDataNote: null, selectedNote: `${nodes[selectedIndex].label}: ${nodes[selectedIndex].sub}` }
}
