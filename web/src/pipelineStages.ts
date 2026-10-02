import type { Stage, Task } from '../../src/types'
import { computeNextStageCta } from '../../src/nextStageCta'

// The one copy of the stage-chain vocabulary: chain node ids, their Stage
// values and labels, the folding of *-fixes/plan-review into a parent node,
// and the default tab for a task. The next-stage table itself is not here:
// it comes from src/nextStageCta.ts, shared with the server.

export type ChainStageId = 'planning' | 'plan-review' | 'dev' | 'cr' | 'cr-fixes' | 'qa' | 'qa-fixes' | 'merge'

export interface ChainStage {
  id: ChainStageId
  stage: Stage
  label: string
}

export const MILESTONE_CHAIN_STAGES: ChainStage[] = [
  { id: 'dev', stage: 'dev', label: 'Dev' },
  { id: 'cr', stage: 'code-review', label: 'CR' },
  { id: 'cr-fixes', stage: 'comment-fix', label: 'CR fixes' },
  { id: 'qa', stage: 'qa', label: 'QA' },
  { id: 'qa-fixes', stage: 'qa-fixes', label: 'QA fixes' },
  { id: 'merge', stage: 'merge', label: 'Merge' },
]

export const FLAT_CHAIN_STAGES: ChainStage[] = [
  { id: 'planning', stage: 'planning', label: 'Planning' },
  { id: 'plan-review', stage: 'plan-review', label: 'Plan Review' },
  ...MILESTONE_CHAIN_STAGES,
]

export const STAGE_TO_CHAIN_ID = Object.fromEntries(FLAT_CHAIN_STAGES.map((s) => [s.stage, s.id])) as Record<Stage, ChainStageId>

// Display-only grouping for the stage chain: a fresh-eyes plan review really
// is its own dispatch, and cr-fixes/qa-fixes really are their own tabs with
// their own panels and URLs — none of that changes. This only says which
// chain nodes render as ONE circle, folding the child id's state into the
// parent's. Every other reader still sees all eight/six ids.
export const STAGE_CHAIN_GROUPS: Record<string, ChainStageId[]> = {
  planning: ['plan-review'],
  cr: ['cr-fixes'],
  qa: ['qa-fixes'],
}

// A flat task does its own planning; a dispatched milestone child never does
// (its plan lives in the parent's tech-design.md), so it gets the six-stage
// chain.
export type StageChainKind = 'flat' | 'milestone'

export function chainStagesFor(kind: StageChainKind): ChainStage[] {
  return kind === 'flat' ? FLAT_CHAIN_STAGES : MILESTONE_CHAIN_STAGES
}

const CHAIN_STAGE_IDS: ReadonlySet<string> = new Set(FLAT_CHAIN_STAGES.map((s) => s.id))

export function isChainStageId(value: string): value is ChainStageId {
  return CHAIN_STAGE_IDS.has(value)
}

export function chainStageById(id: ChainStageId): ChainStage {
  return FLAT_CHAIN_STAGES.find((s) => s.id === id)!
}

// The tab to show when nothing has been explicitly clicked yet. Prefers the
// waitingReason-derived next stage over raw task.stage, which can lag behind
// reality mid-stage. 'planning' is
// safe to trust off task.stage because it is the pipeline's first stage and
// so can never be a stale leftover. `null` is an undispatched milestone.
export function defaultStageTab(child: Task | null): ChainStageId {
  const nextStage = child && computeNextStageCta(child)?.stage
  if (nextStage) return STAGE_TO_CHAIN_ID[nextStage] ?? 'dev'
  if (child && child.stage === 'planning') return 'planning'
  return 'dev'
}

// Level 1 of a fan-out parent's drill-down. Plan and Plan Review are not a
// one-way gate — a review can send the plan back — so each tab carries a
// round counter (the count of its `stage`'s TIMELINE entries) rather than a
// checkmark.
export type L1TabId = 'plan' | 'plan-review' | 'dev'

export interface L1Tab {
  id: L1TabId
  label: string
  stage: Stage
}

export const L1_TABS: L1Tab[] = [
  { id: 'plan', label: 'Plan', stage: 'planning' },
  { id: 'plan-review', label: 'Plan Review', stage: 'plan-review' },
  { id: 'dev', label: 'Dev', stage: 'dev' },
]

export function isL1TabId(value: string): value is L1TabId {
  return L1_TABS.some((tab) => tab.id === value)
}

// The six stages every chain shares, i.e. everything a stage panel (as
// opposed to the plan tab) renders.
export type StagePanelTabId = Exclude<ChainStageId, 'planning' | 'plan-review'>

export function isStagePanelTabId(id: ChainStageId): id is StagePanelTabId {
  return id !== 'planning' && id !== 'plan-review'
}

// The tab a panel shows: the explicitly selected one if it belongs to this
// chain, otherwise the default. A milestone chain has no plan nodes, so a
// plan tab (a stale or hand-edited ?stage=) must not be honoured there — and
// neither may a default that would land on one.
export function resolveStageTab(selected: ChainStageId | null, chain: ChainStage[], child: Task | null): ChainStageId {
  const isInChain = (id: ChainStageId) => chain.some((s) => s.id === id)
  if (selected && isInChain(selected)) return selected
  const fallback = defaultStageTab(child)
  return isInChain(fallback) ? fallback : 'dev'
}

// Which L1 tab a fan-out parent opens on. A parent already in its Dev state
// opens straight to the Dev tab (its wave overview) — Plan/Plan Review only
// matter while it is still in those stages. Reads the waitingReason-derived
// "real next stage" as well as raw task.stage, which lags behind reality
// mid-stage: a parent whose plan review just finished (STATUS "plan reviewed,
// ready for dev") still reads task.stage as 'plan-review' until dev's own
// TIMELINE entry lands.
export function initialL1Tab(task: Task): L1TabId {
  return task.stage === 'dev' || computeNextStageCta(task)?.stage === 'dev' ? 'dev' : 'plan'
}

// The tab a stage chain highlights as selected: the explicitly selected one if
// it belongs to this chain, otherwise the default. "Current" and "selected"
// coincide by construction. null for a done task or an undispatched milestone
// (child null), which highlights no node.
export function resolveSelectedStageTab(child: Task | null, stages: ChainStage[], selected: ChainStageId | null): ChainStageId | null {
  if (!child || !child.stage) return null
  return selected && stages.some((stage) => stage.id === selected) ? selected : defaultStageTab(child)
}
