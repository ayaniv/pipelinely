import type { Stage, Task } from '../../src/types'
import { computeNextStageCta } from '../../src/nextStageCta'

// The one copy of the stage-chain vocabulary: chain node ids, their Stage
// values and labels, the folding of *-fixes/plan-review into a parent node,
// and the default tab for a task. The next-stage table itself is not here:
// it comes from src/nextStageCta.ts, shared with the server.

export type ChainStageId =
  | 'planning' | 'plan-review' | 'dev' | 'cr' | 'cr-fixes' | 'qa' | 'qa-fixes' | 'merge'
  // Only the design-system chain draws these.
  | 'design-intake' | 'design-qa' | 'design-approval' | 'design-fixes' | 'adopt'

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

// The design-system pipeline: the doc's steps around the shared dev stages.
// design-intake runs inside the planning worker but gets its own node because
// it is its own step in the doc.
export const DS_CHAIN_STAGES: ChainStage[] = [
  { id: 'design-intake', stage: 'design-intake', label: 'Design Intake' },
  ...FLAT_CHAIN_STAGES.filter((s) => s.id !== 'merge'),
  { id: 'design-qa', stage: 'design-qa', label: 'Design QA' },
  { id: 'design-approval', stage: 'design-approval', label: 'Design Approval' },
  { id: 'design-fixes', stage: 'design-fixes', label: 'Design fixes' },
  { id: 'merge', stage: 'merge', label: 'Merge' },
  { id: 'adopt', stage: 'adopt', label: 'Adopt' },
]

// Every node any chain can draw, once. The id lookups below read this rather
// than one chain, so a ds-only id is a known id.
export const ALL_CHAIN_STAGES: ChainStage[] = DS_CHAIN_STAGES

// merge-conflicts has no chain node of its own (it is off the main line,
// entered from wherever the task stood): it lives on the Merge tab, which is
// where its Fix conflicts button replaces Merge.
export const STAGE_TO_CHAIN_ID = {
  ...Object.fromEntries(ALL_CHAIN_STAGES.map((s) => [s.stage, s.id])),
  'merge-conflicts': 'merge',
} as Record<Stage, ChainStageId>

// Display-only grouping for the stage chain: a fresh-eyes plan review really
// is its own dispatch, and cr-fixes/qa-fixes really are their own tabs with
// their own panels and URLs — none of that changes. This only says which
// chain nodes render as ONE circle, folding the child id's state into the
// parent's. Every other reader still sees all eight/six ids.
export const STAGE_CHAIN_GROUPS: Record<string, ChainStageId[]> = {
  planning: ['plan-review'],
  cr: ['cr-fixes'],
  qa: ['qa-fixes'],
  'design-approval': ['design-fixes'],
}

// A flat task does its own planning; a dispatched milestone child never does
// (its plan lives in the parent's tech-design.md), so it gets the six-stage
// chain; a ds task gets the design-system one.
export type StageChainKind = 'flat' | 'milestone' | 'ds'

const CHAIN_STAGES_BY_KIND: Record<StageChainKind, ChainStage[]> = {
  flat: FLAT_CHAIN_STAGES,
  milestone: MILESTONE_CHAIN_STAGES,
  ds: DS_CHAIN_STAGES,
}

export function chainStagesFor(kind: StageChainKind): ChainStage[] {
  return CHAIN_STAGES_BY_KIND[kind]
}

// The one place a task's chain is chosen, shared by the graph slot and the
// panel slot so they can never disagree. A milestone child's chain is decided
// by projectTitle alone (ds tasks are always flat, never milestones).
export function stageChainKindFor(task: Task): StageChainKind {
  if (task.projectTitle) return 'milestone'
  return task.kind === 'ds' ? 'ds' : 'flat'
}

const CHAIN_STAGE_IDS: ReadonlySet<string> = new Set(ALL_CHAIN_STAGES.map((s) => s.id))

export function isChainStageId(value: string): value is ChainStageId {
  return CHAIN_STAGE_IDS.has(value)
}

export function chainStageById(id: ChainStageId): ChainStage {
  return ALL_CHAIN_STAGES.find((s) => s.id === id)!
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

// The stage a fan-out parent's chart has selected. Planning and Plan Review
// are one chart node (STAGE_CHAIN_GROUPS) but two panels, so both ids exist;
// the other four are the parent's summary of its milestones at that stage.
export type ParentStageId = 'planning' | 'plan-review' | 'dev' | 'cr' | 'qa' | 'merge'

// Every chain node that gets a stage panel (as opposed to the plan tab),
// including the ds-only nodes.
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

// Which stage a fan-out parent opens on. A parent already in its Dev state
// opens straight to Dev (its wave overview) — Planning only matters while it
// is still in planning or plan review. Reads the waitingReason-derived "real
// next stage" as well as raw task.stage, which lags behind reality mid-stage:
// a parent whose plan review just finished (STATUS "plan reviewed, ready for
// dev") still reads task.stage as 'plan-review' until dev's own TIMELINE entry
// lands.
export function initialParentStage(task: Task): ParentStageId {
  return task.stage === 'dev' || computeNextStageCta(task)?.stage === 'dev' ? 'dev' : 'planning'
}

// The tab a stage chain highlights as selected: the explicitly selected one if
// it belongs to this chain, otherwise the default. "Current" and "selected"
// coincide by construction. null for a done task or an undispatched milestone
// (child null), which highlights no node.
export function resolveSelectedStageTab(child: Task | null, stages: ChainStage[], selected: ChainStageId | null): ChainStageId | null {
  if (!child || !child.stage) return null
  return selected && stages.some((stage) => stage.id === selected) ? selected : defaultStageTab(child)
}
