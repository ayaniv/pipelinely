import type { Task } from '../../../../../src/types'
import { formatWhen } from '../../../format'
import { cardStageView } from '../../../stageView'
import { STAGE_CHAIN_GROUPS, STAGE_TO_CHAIN_ID, chainStagesFor, resolveSelectedStageTab, type ChainStageId, type ParentStageId, type StageChainKind } from '../../../pipelineStages'
import { reworkMilestoneIds } from '../../../waveModel'
import { useTaskDetailNav } from '../detailNav'
import { PipelineChart } from './PipelineChart'
import { parentStageChainModel } from './parentStageModel'
import { buildStageChainModel, type NoDataNote, type StageChainModel, type StageChainNode } from './stageChainModel'

// The task-detail pipeline chart. Selection is NOT owned here: a node (or the
// compact prev/next) asks the task detail's nav (detailNav.ts) to select its
// stage, which drives the stage panel below. A flat task or milestone writes
// ?stage=; a fan-out parent keeps its stage in component state.

function checkGlyph(node: StageChainNode): string {
  if (node.isDone) return '✓'
  if (node.isUnrecorded) return '–'
  return String(node.index + 1)
}

function describeNoData(note: NoDataNote): string {
  switch (note.kind) {
    case 'inferred-current':
      return `No pipeline data recorded for this task yet — its current stage (${note.currentLabel}) is inferred from status/files on disk, not from a written TIMELINE.`
    case 'finished-unrecorded':
      return 'No pipeline data was ever recorded for this task — it finished with no TIMELINE written.'
    case 'unplaced':
      return 'No pipeline data recorded for this task yet, and its stage could not be placed on this chain.'
  }
}

// Below 641px CSS swaps the wide chart for this prev/tile/next stepper; both
// are always in the DOM, so there is no resize listener to leak.
function StageChainCompact({ model, onSelect }: { model: StageChainModel; onSelect: (tabId: ChainStageId) => void }) {
  const selected = model.nodes[model.selectedIndex]
  const previous = model.nodes[model.selectedIndex - 1]
  const next = model.nodes[model.selectedIndex + 1]
  return (
    <div className="stepper-compact" data-testid="stepper-compact">
      <button
        className="stepper-nav-btn"
        type="button"
        data-testid="stepper-prev"
        aria-label="Previous stage"
        disabled={!previous}
        onClick={() => previous && onSelect(previous.tabId)}
      >&lsaquo;</button>
      <div className={`stepper-tile ${selected.stateClass}`}>
        <span className="stage-chain-check" aria-hidden="true">{checkGlyph(selected)}</span>
        <div className="stepper-tile-text">
          <span className="stage-chain-name">{selected.label}</span>
          <span className="stage-chain-data">{selected.note}</span>
        </div>
        <span className="stepper-position" data-testid="stepper-position">{model.selectedIndex + 1}/{model.nodes.length}</span>
      </div>
      <button
        className="stepper-nav-btn"
        type="button"
        data-testid="stepper-next"
        aria-label="Next stage"
        disabled={!next}
        onClick={() => next && onSelect(next.tabId)}
      >&rsaquo;</button>
    </div>
  )
}

interface ChartSectionProps {
  model: StageChainModel
  reworkIds: string[]
  onSelect: (tabId: ChainStageId) => void
}

function ChartSection({ model, reworkIds, onSelect }: ChartSectionProps) {
  if (model.nodes.length === 0) return null
  return (
    <>
      {model.noDataNote && <div className="detail-row-note" data-testid="stage-chain-no-data">{describeNoData(model.noDataNote)}</div>}
      <div className="stepper-wide" data-testid="stepper-wide">
        <PipelineChart model={model} reworkMilestoneIds={reworkIds} onSelect={onSelect} />
      </div>
      <StageChainCompact model={model} onSelect={onSelect} />
      <div className="detail-row-note" data-testid="stage-chain-selected-note">{model.selectedNote}</div>
    </>
  )
}

export interface StageChainGraphProps {
  // The task whose stage/stageHistory drive the chain — null for a milestone
  // that hasn't dispatched yet, which renders every node pending.
  child: Task | null
  stages: StageChainKind
}

export function StageChainGraph({ child, stages }: StageChainGraphProps) {
  const { nav, selectStageTab } = useTaskDetailNav()
  const stageList = chainStagesFor(stages)
  // Deliberately not memoized: a handful of nodes, re-derived on every
  // snapshot tick and every selection change.
  const taskView = child ? cardStageView(child) : null
  const model = buildStageChainModel({
    child,
    stages: stageList,
    groups: STAGE_CHAIN_GROUPS,
    resolvedTab: resolveSelectedStageTab(child, stageList, nav.l2Tab),
    taskStageId: taskView?.stage ? STAGE_TO_CHAIN_ID[taskView.stage] ?? null : null,
    formatWhen,
  })
  return <ChartSection model={model} reworkIds={[]} onSelect={selectStageTab} />
}

// A fan-out parent's chart: the same five nodes, summarising its milestones
// from Dev on, plus the rework loop while any of them is in code review.
export function ParentChartGraph({ task }: { task: Task }) {
  const { nav, selectL1Tab } = useTaskDetailNav()
  const model = parentStageChainModel(task, nav.l1Tab)
  return <ChartSection model={model} reworkIds={reworkMilestoneIds(task.milestones ?? [])} onSelect={(tabId) => selectL1Tab(tabId as ParentStageId)} />
}
