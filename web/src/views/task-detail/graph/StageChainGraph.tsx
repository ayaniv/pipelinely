import { createContext, useContext, useMemo, type KeyboardEvent } from 'react'
import { BaseEdge, getStraightPath, Handle, Position, ReactFlow, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react'
import type { Task } from '../../../../../src/types'
import { formatWhen } from '../../../format'
import { STAGE_CHAIN_GROUPS, chainStagesFor, resolveSelectedStageTab, type StageChainKind } from '../../../pipelineStages'
import { useTaskDetailNav } from '../detailNav'
import { DISPLAY_ONLY_FLOW_PROPS, NODE_HOSTS_BUTTONS_STYLE } from './flowConfig'
import { buildStageChainModel, type NoDataNote, type StageChainModel, type StageChainNode } from './stageChainModel'
import { layoutStageChain } from './stageChainLayout'
import { focusStepForKey } from './chainFocus'
import { useElementWidth } from './useElementWidth'

// The task-detail stage chain, rendered with React Flow. Selection is NOT
// owned here: a node (or the compact prev/next) asks the task detail's nav
// (detailNav.ts) to select its stage, which writes ?stage= and so drives the
// stage panel below.

const STAGE_NODE_WIDTH = 82
const MILESTONE_NODE_WIDTH = 92
// Room for the node's padding + 28px circle + 9px gap + name (+ the state
// line on the milestone rail) — React Flow needs an explicit canvas height.
const STAGE_FLOW_HEIGHT = 76
const MILESTONE_FLOW_HEIGHT = 96

function checkGlyph(node: StageChainNode): string {
  if (node.isDone) return '✓'
  if (node.isUnrecorded) return '–'
  return String(node.index + 1)
}

// Node objects handed to React Flow must keep their identity across renders:
// a re-adopted node loses its measurement and stays hidden until it's measured
// again, which never happens for an unchanged size. So the changing content
// (done/current state, notes) reaches StageNode through context, and the node
// objects below only change when the chain's shape or spacing does.
interface StageChainContextValue {
  model: StageChainModel
  isMilestoneRail: boolean
}
const StageChainContext = createContext<StageChainContextValue | null>(null)
type StageFlowNode = Node<Record<string, never>, 'stage'>

function StageNode({ id }: NodeProps<StageFlowNode>) {
  const context = useContext(StageChainContext)
  const { selectStageTab } = useTaskDetailNav()
  const node = context?.model.nodes.find((candidate) => candidate.id === id)
  if (!context || !node) return null
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} className="stage-flow-handle" />
      <button
        type="button"
        className={`stage-chain-node ${node.stateClass}`}
        data-testid={`stage-chain-${node.id}`}
        aria-current={node.isCurrent ? 'step' : 'false'}
        onClick={() => selectStageTab(node.tabId)}
      >
        <span className="stage-chain-check" aria-hidden="true">{checkGlyph(node)}</span>
        <span className="stage-chain-name">{node.label}</span>
        {context.isMilestoneRail && <span className="stage-chain-data" data-testid="stage-node-data">{node.stateWord}</span>}
      </button>
      <Handle type="source" position={Position.Right} isConnectable={false} className="stage-flow-handle" />
    </>
  )
}

function StageEdge({ id, sourceX, sourceY, targetX, targetY }: EdgeProps) {
  const [path] = getStraightPath({ sourceX, sourceY, targetX, targetY })
  return <BaseEdge id={id} path={path} className="stage-chain-edge" />
}

// Stable identities — React Flow re-registers renderers whenever these change.
const NODE_TYPES = { stage: StageNode }
const EDGE_TYPES = { stage: StageEdge }

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

// Arrow keys move focus along the chain without selecting — Tab/Enter stay
// the way to pick a stage, so browsing the rail never swaps the panel below.
function moveFocusAlongChain(event: KeyboardEvent<HTMLDivElement>) {
  const step = focusStepForKey(event.key, getComputedStyle(event.currentTarget).direction === 'rtl' ? 'rtl' : 'ltr')
  if (!step) return
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.stage-chain-node')]
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const next = buttons[current + step]
  if (current < 0 || !next) return
  event.preventDefault()
  next.focus()
}

function StageChainFlow({ model, isMilestoneRail }: { model: StageChainModel; isMilestoneRail: boolean }) {
  const [scrollerRef, availableWidth] = useElementWidth<HTMLDivElement>()
  const nodeWidth = isMilestoneRail ? MILESTONE_NODE_WIDTH : STAGE_NODE_WIDTH
  const layout = layoutStageChain({ nodeCount: model.nodes.length, nodeWidth, availableWidth })

  const nodeIds = model.nodes.map((node) => node.id)
  const nodesKey = `${nodeWidth}|${nodeIds.join(',')}|${layout.xPositions.join(',')}`
  // Keyed on nodesKey, the serialisation of everything read below.
  const nodes = useMemo<StageFlowNode[]>(() => nodeIds.map((nodeId, index) => ({
    id: nodeId,
    type: 'stage',
    position: { x: layout.xPositions[index], y: 0 },
    width: nodeWidth,
    style: NODE_HOSTS_BUTTONS_STYLE,
    data: {},
  })), [nodesKey])

  const edges: Edge[] = model.edges.map((edge) => ({
    id: `${edge.sourceId}->${edge.targetId}`,
    source: edge.sourceId,
    target: edge.targetId,
    type: 'stage',
    className: edge.isTraversed ? 'is-traversed' : undefined,
  }))

  return (
    // The scroller carries the row's class + testid: overflow-x and
    // the 8px bleed that stops the current node's halo being clipped.
    <div ref={scrollerRef} className="stage-chain" data-testid="stage-chain" onKeyDown={moveFocusAlongChain}>
      {/* React Flow fills 100% of its parent and ignores its own width/height
          style, so the canvas size lives on this wrapper. */}
      <div className="stage-flow-canvas" style={{ width: layout.width, height: isMilestoneRail ? MILESTONE_FLOW_HEIGHT : STAGE_FLOW_HEIGHT }}>
        <StageChainContext.Provider value={{ model, isMilestoneRail }}>
          <ReactFlow
            {...DISPLAY_ONLY_FLOW_PROPS}
            className="stage-flow"
            data-testid="stage-flow"
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
          />
        </StageChainContext.Provider>
      </div>
    </div>
  )
}

// Below 641px CSS swaps the wide rail for this prev/tile/next stepper; both
// are always in the DOM, so there is no resize listener to leak.
function StageChainCompact({ model }: { model: StageChainModel }) {
  const { selectStageTab } = useTaskDetailNav()
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
        onClick={() => previous && selectStageTab(previous.tabId)}
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
        onClick={() => next && selectStageTab(next.tabId)}
      >&rsaquo;</button>
    </div>
  )
}

export interface StageChainGraphProps {
  // The task whose stage/stageHistory drive the chain — null for a milestone
  // that hasn't dispatched yet, which renders every node pending.
  child: Task | null
  stages: StageChainKind
}

export function StageChainGraph({ child, stages }: StageChainGraphProps) {
  const { nav } = useTaskDetailNav()
  const stageList = chainStagesFor(stages)
  // Deliberately not memoized: a handful of nodes, re-derived on every
  // snapshot tick and every selection change.
  const model = buildStageChainModel({
    child,
    stages: stageList,
    groups: STAGE_CHAIN_GROUPS,
    resolvedTab: resolveSelectedStageTab(child, stageList, nav.l2Tab),
    formatWhen,
  })

  if (model.nodes.length === 0) return null
  const isMilestoneRail = stages === 'milestone'

  return (
    <>
      {model.noDataNote && <div className="detail-row-note" data-testid="stage-chain-no-data">{describeNoData(model.noDataNote)}</div>}
      <div className={`stepper-wide${isMilestoneRail ? ' is-milestone' : ''}`} data-testid="stepper-wide">
        <StageChainFlow model={model} isMilestoneRail={isMilestoneRail} />
      </div>
      <StageChainCompact model={model} />
      <div className="detail-row-note" data-testid="stage-chain-selected-note">{model.selectedNote}</div>
    </>
  )
}
