import { useMemo, useRef, type KeyboardEvent } from 'react'
import { MarkerType, ReactFlow, ReactFlowProvider, type CoordinateExtent, type Edge } from '@xyflow/react'
import type { Logger } from '../../../log'
import type { ChainStageId } from '../../../pipelineStages'
import { STAGE_TONE_VARS } from '../../../stageView'
import { focusStepForKey } from './chainFocus'
import { DISPLAY_ONLY_FLOW_PROPS, NODE_HOSTS_BUTTONS_STYLE } from './flowConfig'
import { computeFlowViewport, zoomFloor } from './flowViewport'
import { CHART_CONTENT_HEIGHT, CHART_PAD, STAGE_NODE_WIDTH, layoutPipelineChart } from './pipelineChartLayout'
import { GradientEdge, ReworkLoopEdge, type GradientFlowEdge, type ReworkLoopFlowEdge } from './pipelineEdges'
import { LOOP_SOURCE_HANDLE_ID, LOOP_TARGET_HANDLE_ID, PipelineChartContext, SOURCE_HANDLE_ID, StageCircleNode, TARGET_HANDLE_ID, type StageFlowNode } from './StageCircleNode'
import type { StageChainModel } from './stageChainModel'
import { useElementWidth } from './useElementWidth'
import { ViewportController } from './ViewportController'

// The pipeline chart: five (or, for a milestone, four) circle stages chained by
// gradient edges, with a coral rework loop under a fan-out parent's Dev and
// Code review. The viewport is worked out by hand (flowViewport.ts) and applied
// through the React Flow instance, never through a `key` or fitView, so a
// selection or a live snapshot never re-mounts the chart or moves a user's pan.

// The brief's zoom floor, raised so the smallest text in the chart (the rework
// loop's 10.5px label) never renders under 10px.
const BRIEF_ZOOM_FLOOR = 0.8
const SMALLEST_TEXT_PX = 10.5
const CHART_ZOOM_FLOOR = zoomFloor(BRIEF_ZOOM_FLOOR, SMALLEST_TEXT_PX)

const DEV_NODE_ID = 'dev'
const CODE_REVIEW_NODE_ID = 'cr'
const REWORK_ARROW_COLOR = 'var(--crC)'
const NEUTRAL_EDGE_COLOR = 'var(--border2)'

const NODE_TYPES = { stage: StageCircleNode }
const EDGE_TYPES = { grad: GradientEdge, loop: ReworkLoopEdge }

function reworkLabel(milestoneIds: string[]): string {
  return `${milestoneIds.join(', ')} · findings → fixes`
}

// Arrow keys move focus along the chain without selecting — Tab/Enter stay
// the way to pick a stage, so browsing the chart never swaps the panel below.
function moveFocusAlongChain(event: KeyboardEvent<HTMLDivElement>) {
  const step = focusStepForKey(event.key, getComputedStyle(event.currentTarget).direction === 'rtl' ? 'rtl' : 'ltr')
  if (!step) return
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.pipeline-node')]
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const next = buttons[current + step]
  if (current < 0 || !next) return
  event.preventDefault()
  next.focus()
}

export interface PipelineChartProps {
  model: StageChainModel
  // The milestones in code review or CR fixes; non-empty draws the loop.
  reworkMilestoneIds: string[]
  onSelect: (tabId: ChainStageId) => void
  log?: Logger
}

function PipelineChartFlow({ model, reworkMilestoneIds, onSelect, log = console.error }: PipelineChartProps) {
  const [boxRef, containerWidth] = useElementWidth<HTMLDivElement>()
  const hasLoop = reworkMilestoneIds.length > 0 && model.nodes.some((node) => node.id === DEV_NODE_ID) && model.nodes.some((node) => node.id === CODE_REVIEW_NODE_ID)
  const nodeCount = model.nodes.length

  const layout = layoutPipelineChart({ nodeCount, containerWidth, hasLoop })
  const currentIndex = Math.max(0, model.nodes.findIndex((node) => node.state === 'current'))
  const viewport = computeFlowViewport({
    containerWidth,
    contentBounds: { x: 0, y: 0, width: layout.width, height: layout.height },
    pad: CHART_PAD,
    minZoom: CHART_ZOOM_FLOOR,
    focusX: (layout.xPositions[currentIndex] ?? 0) + STAGE_NODE_WIDTH / 2,
  })
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport

  // Node objects keep their identity until the chart's shape or spacing
  // changes: a re-adopted node loses its measurement and stays hidden until
  // it is measured again, which never happens for an unchanged size.
  const nodeIds = model.nodes.map((node) => node.id)
  const nodesKey = `${nodeIds.join(',')}|${layout.xPositions.join(',')}|${layout.height}`
  const nodes = useMemo<StageFlowNode[]>(() => nodeIds.map((id, index) => ({
    id,
    type: 'stage',
    position: { x: layout.xPositions[index], y: 0 },
    width: STAGE_NODE_WIDTH,
    height: CHART_CONTENT_HEIGHT,
    style: NODE_HOSTS_BUTTONS_STYLE,
    data: {},
  })), [nodesKey])

  const toneColor = new Map(model.nodes.map((node) => [node.id, STAGE_TONE_VARS[node.tone].c]))
  const gradientEdges: GradientFlowEdge[] = model.edges.map((edge) => ({
    id: `${edge.sourceId}-${edge.targetId}`,
    source: edge.sourceId,
    target: edge.targetId,
    sourceHandle: SOURCE_HANDLE_ID,
    targetHandle: TARGET_HANDLE_ID,
    type: 'grad',
    data: {
      edgeId: `${edge.sourceId}-${edge.targetId}`,
      sourceColor: model.nodes.find((node) => node.id === edge.sourceId)?.state === 'todo' ? NEUTRAL_EDGE_COLOR : toneColor.get(edge.sourceId) ?? NEUTRAL_EDGE_COLOR,
      targetColor: edge.isReached ? toneColor.get(edge.targetId) ?? NEUTRAL_EDGE_COLOR : NEUTRAL_EDGE_COLOR,
      isReached: edge.isReached,
    },
  }))
  const loopEdges: ReworkLoopFlowEdge[] = hasLoop
    ? [{
        id: 'cr-dev-loop',
        source: CODE_REVIEW_NODE_ID,
        target: DEV_NODE_ID,
        sourceHandle: LOOP_SOURCE_HANDLE_ID,
        targetHandle: LOOP_TARGET_HANDLE_ID,
        type: 'loop',
        markerEnd: { type: MarkerType.ArrowClosed, color: REWORK_ARROW_COLOR },
        data: { label: reworkLabel(reworkMilestoneIds) },
      }]
    : []
  const edges: Edge[] = [...gradientEdges, ...loopEdges]

  // Panning is horizontal only, limited to the content plus its padding: the
  // extent is exactly the visible height, so d3-zoom has no vertical slack.
  const topEdge = -viewport.y / viewport.zoom
  const translateExtent: CoordinateExtent = [
    [-CHART_PAD / viewport.zoom, topEdge],
    [layout.width + CHART_PAD / viewport.zoom, topEdge + viewport.boxHeight / viewport.zoom],
  ]

  // The current stage is part of the key: when it advances in a chart wider
  // than its box, the viewport has to follow it to the new focus point.
  const shapeKey = `${containerWidth}|${nodeCount}|${hasLoop}|${currentIndex}`
  return (
    // content-box so the height below IS the inner (client) height the
    // viewport maths was computed for, not that plus the border.
    <div
      ref={boxRef}
      className="pipeline-chart"
      data-testid="pipeline-chart"
      data-fits={viewport.fits ? 'true' : 'false'}
      data-content-height={layout.height}
      style={{ height: viewport.boxHeight }}
      onKeyDown={moveFocusAlongChain}
    >
      <PipelineChartContext.Provider value={{ model, onSelect }}>
        <ReactFlow
          {...DISPLAY_ONLY_FLOW_PROPS}
          className="stage-flow"
          data-testid="stage-flow"
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          minZoom={CHART_ZOOM_FLOOR}
          maxZoom={1}
          panOnDrag={!viewport.fits}
          translateExtent={translateExtent}
          defaultViewport={{ x: viewport.x, y: viewport.y, zoom: viewport.zoom }}
        >
          <ViewportController viewportRef={viewportRef} shapeKey={shapeKey} log={log} graphName="pipeline-chart" />
        </ReactFlow>
      </PipelineChartContext.Provider>
    </div>
  )
}

export function PipelineChart(props: PipelineChartProps) {
  return (
    <ReactFlowProvider>
      <PipelineChartFlow {...props} />
    </ReactFlowProvider>
  )
}
