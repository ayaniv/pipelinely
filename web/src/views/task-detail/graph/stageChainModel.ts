import type { StageEvent, Task } from '../../../../../src/types'
import type { ChainStage, ChainStageId } from '../../../pipelineStages'

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
  isCurrent: boolean
  isDone: boolean
  isUnrecorded: boolean
  stateClass: StageNodeState
  // The milestone rail's terse third line under a node — distinct from
  // `note`, which is the recorded outcome shown in the selected-stage row.
  stateWord: 'current' | 'done' | '—'
  note: string
  when: string | null
}

export interface StageChainEdge {
  sourceId: ChainStageId
  targetId: ChainStageId
  isTraversed: boolean
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
  formatWhen: (iso: string) => string
}

function latestEventByStage(child: Task | null): Map<string, StageEvent> {
  return new Map((child ? child.stageHistory : []).map((event) => [event.stage, event]))
}

function stageNodeState(isCurrent: boolean, isDone: boolean, isUnrecorded: boolean): StageNodeState {
  if (isCurrent) return 'is-current is-selected'
  if (isDone) return 'is-done'
  if (isUnrecorded) return 'is-unrecorded'
  return 'is-pending'
}

export function buildStageChainModel({ child, stages, groups, resolvedTab, formatWhen }: StageChainModelInput): StageChainModel {
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
      const isCurrent = members.some((member) => member.id === resolvedTab)
      // The furthest-along member TIMELINE actually reached represents the
      // group, so a node already showing one of its own sub-tabs doesn't
      // jump to a different one on re-render.
      let representative = stage
      for (const member of members) if (reached.has(member.stage)) representative = member
      const tabId = isCurrent && resolvedTab ? resolvedTab : representative.id
      // Only a stage TIMELINE recorded counts as done: inferring it from
      // position alone drew a false history for a task whose worker never
      // wrote TIMELINE at all.
      const isDone = !isCurrent && reached.has(representative.stage)
      const isUnrecorded = !isCurrent && !isDone && isFinished
      const event = reached.get(representative.stage)
      const note = event ? (event.note || 'done') : isCurrent ? 'current' : isUnrecorded ? 'not recorded' : '—'
      return {
        id: stage.id,
        tabId,
        label: stage.label,
        index,
        isCurrent,
        isDone,
        isUnrecorded,
        stateClass: stageNodeState(isCurrent, isDone, isUnrecorded),
        stateWord: isCurrent ? 'current' : isDone ? 'done' : '—',
        note,
        when: event ? formatWhen(event.at) : null,
      }
    })

  const edges: StageChainEdge[] = nodes.slice(1).map((node, i) => ({
    sourceId: nodes[i].id,
    targetId: node.id,
    isTraversed: nodes[i].isDone || nodes[i].isCurrent,
  }))

  // An empty stage list (a partially registered or malformed definitions
  // object) degrades to an empty model, which the graph renders as nothing.
  if (nodes.length === 0) return { nodes, edges: [], selectedIndex: 0, noDataNote: null, selectedNote: '' }

  const currentIndex = nodes.findIndex((node) => node.isCurrent)
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
