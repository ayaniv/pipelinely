import type { StageEvent, Task } from '../../../../../src/types'
import type { ChainStage, ChainStageId } from '../../../pipelineStages'
import { stageToneOf, type StageTone } from '../../../stageView'
import { panelHeaderPill } from '../panel/panelHeader'
import type { WaveCardStatus } from '../../../waveModel'

// The node/selection model of the task-detail stage chain, so React Flow
// renders from data. The stage *definitions* are pipelineStages.ts's; only the
// derivation of "which node is done / current / pending" lives here.

export type StageNodeState = 'is-current is-selected' | 'is-done' | 'is-unrecorded' | 'is-pending'

export interface StageChainNode {
  id: ChainStageId
  // The tab a click on this node selects. Differs from `id` for a grouped
  // node (Planning routes to Plan Review once that's the stage in play).
  tabId: ChainStageId
  label: string
  index: number
  // The node of the selected tab (what the panel below shows).
  isSelected: boolean
  isDone: boolean
  isUnrecorded: boolean
  // The node of the stage the task itself is at, independent of which tab is
  // selected (isSelected follows the selection).
  isTaskStage: boolean
  // What the chart draws: the task's own stage is current, a recorded one is
  // done, the rest are not started — whichever tab is selected.
  state: 'done' | 'current' | 'todo'
  // The stage's own status pill text, so the chart's subtitle and the panel's
  // pill come from one source.
  sub: string
  tone: StageTone
  // A fan-out parent's Dev node: one dot per milestone, grouped by wave.
  dotGroups?: WaveDot[][]
  stateClass: StageNodeState
  // The milestone rail's terse third line under a node — distinct from
  // `note`, which is the recorded outcome shown in the selected-stage row.
  stateWord: 'current' | 'done' | '—'
  note: string
  when: string | null
}

export interface WaveDot {
  milestoneId: string
  status: WaveCardStatus
}

export interface StageChainEdge {
  sourceId: ChainStageId
  targetId: ChainStageId
  // The stage it enters has been reached; an unreached edge draws dashed.
  isReached: boolean
}

export type NoDataNote =
  | { kind: 'inferred-current'; currentLabel: string }
  | { kind: 'finished-unrecorded' }
  | { kind: 'unplaced' }

export interface StageChainModel {
  nodes: StageChainNode[]
  edges: StageChainEdge[]
  selectedIndex: number
  noDataNote: NoDataNote | null
  selectedNote: string
}

export interface StageChainModelInput {
  // The task whose stage/stageHistory drive done/current/pending — null for a
  // milestone that hasn't dispatched yet, so every node renders pending.
  child: Task | null
  stages: ChainStage[]
  groups: Record<string, ChainStageId[]>
  resolvedTab: ChainStageId | null
  // The chain id of the stage the task is at (cardStageView's), null when it
  // has none (a done task, an undispatched milestone).
  taskStageId: ChainStageId | null
  formatWhen: (iso: string) => string
}

function latestEventByStage(child: Task | null): Map<string, StageEvent> {
  return new Map((child ? child.stageHistory : []).map((event) => [event.stage, event]))
}

export function stageNodeState(isSelected: boolean, isDone: boolean, isUnrecorded: boolean): StageNodeState {
  if (isSelected) return 'is-current is-selected'
  if (isDone) return 'is-done'
  if (isUnrecorded) return 'is-unrecorded'
  return 'is-pending'
}

export function buildStageChainModel({ child, stages, groups, resolvedTab, taskStageId, formatWhen }: StageChainModelInput): StageChainModel {
  const reached = latestEventByStage(child)
  const foldedIds = new Set(Object.values(groups).flat())
  // A finished task has nothing left "pending", but an un-reached stage on it
  // is not known to have been skipped either — TIMELINE absence proves
  // nothing was *recorded*, not that nothing happened. "Unrecorded" is the
  // honest word; "skipped" would claim more than the data supports.
  const isFinished = child?.status === 'done'

  const nodes: StageChainNode[] = stages
    .filter((stage) => !foldedIds.has(stage.id))
    .map((stage, index) => {
      const members = [stage, ...(groups[stage.id] ?? []).map((id) => stages.find((s) => s.id === id)).filter((s): s is ChainStage => !!s)]
      const isSelected = members.some((member) => member.id === resolvedTab)
      // The furthest-along member TIMELINE actually reached represents the
      // group, so a node already showing one of its own sub-tabs doesn't
      // jump to a different one on re-render.
      let representative = stage
      for (const member of members) if (reached.has(member.stage)) representative = member
      const isTaskStage = taskStageId !== null && members.some((member) => member.id === taskStageId)
      const tabId = isSelected && resolvedTab ? resolvedTab : representative.id
      // Only a stage TIMELINE recorded counts as done: inferring it from
      // position alone drew a false history for a task whose worker never
      // wrote TIMELINE at all.
      const isRecorded = reached.has(representative.stage)
      const isDone = !isSelected && isRecorded
      const isUnrecorded = !isSelected && !isDone && isFinished
      const event = reached.get(representative.stage)
      const note = event ? (event.note || 'done') : isSelected ? 'current' : isUnrecorded ? 'not recorded' : '—'
      return {
        id: stage.id,
        tabId,
        label: stage.label,
        index,
        isSelected,
        isDone,
        isUnrecorded,
        isTaskStage,
        state: isTaskStage ? 'current' : isRecorded ? 'done' : 'todo',
        sub: panelHeaderPill(child, tabId).label,
        tone: stageToneOf(stage.stage),
        stateClass: stageNodeState(isSelected, isDone, isUnrecorded),
        stateWord: isSelected ? 'current' : isDone ? 'done' : '—',
        note,
        when: event ? formatWhen(event.at) : null,
      }
    })

  const edges: StageChainEdge[] = nodes.slice(1).map((node, i) => ({
    sourceId: nodes[i].id,
    targetId: node.id,
    isReached: node.state !== 'todo',
  }))

  // An empty stage list (a partially registered or malformed definitions
  // object) degrades to an empty model, which the graph renders as nothing.
  if (nodes.length === 0) return { nodes, edges: [], selectedIndex: 0, noDataNote: null, selectedNote: '' }

  const currentIndex = nodes.findIndex((node) => node.isSelected)
  const selectedIndex = currentIndex >= 0 ? currentIndex : 0
  const selected = nodes[selectedIndex]

  return {
    nodes,
    edges,
    selectedIndex,
    noDataNote: child && reached.size === 0 ? describeMissingTimeline(child, resolvedTab ? selected.label : null) : null,
    selectedNote: `${selected.label}: ${selected.note}${selected.when ? ` · ${selected.when}` : ''}`,
  }
}

// A dispatched task with zero TIMELINE entries would otherwise render as a
// wall of numbered/pending nodes indistinguishable from "hasn't started".
// child.stage is null once a task is done, so there is no "current stage"
// left to name in that case.
function describeMissingTimeline(child: Task, currentLabel: string | null): NoDataNote {
  if (currentLabel) return { kind: 'inferred-current', currentLabel }
  return child.status === 'done' ? { kind: 'finished-unrecorded' } : { kind: 'unplaced' }
}
