import { useCallback, useRef, useState } from 'react'
import { ControlButton, Panel, ReactFlow, ReactFlowProvider, useNodesState, useReactFlow, useStore, type Edge } from '@xyflow/react'
import type { Task } from '../../../../../src/types'
import { useCreaturePlacement } from '../../../data/creaturePlacement'
import type { Logger } from '../../../log'
import { navigateToTask } from '../../../shell/appNavigation'
import { buildWaves, type Wave, type WaveCard } from '../../../waveModel'
import { useTaskDetailNav } from '../detailNav'
import { DISPLAY_ONLY_FLOW_PROPS, NODE_HOSTS_BUTTONS_STYLE } from './flowConfig'
import { computeFlowViewport, zoomFloor, type FlowViewport } from './flowViewport'
import { GradientEdge, type GradientEdgeData, type GradientFlowEdge } from './pipelineEdges'
import { useElementWidth } from './useElementWidth'
import { ViewportController } from './ViewportController'
import { orbNodeOrigin, orbNodeSize, layoutWaveGraph, type OrbKind, type WaveGraphLayout } from './waveGraphLayout'
import { OrbNode, WaveGraphContext, type OrbFlowNode, type OrbIdentity } from './WaveNodes'

// The Dev wave graph (REQUEST-v4.md §3): the task's creature as the root,
// waves on a spine and each wave's milestones branching off it. Like the
// pipeline chart its viewport is worked out by hand and applied through the
// React Flow instance; unlike it, nodes can be dragged (React Flow state
// only, never persisted) and there are zoom controls.

const BRIEF_ZOOM_FLOOR = 0.88
const SMALLEST_TEXT_PX = 10.5
const WAVE_ZOOM_FLOOR = zoomFloor(BRIEF_ZOOM_FLOOR, SMALLEST_TEXT_PX)
const MAX_ZOOM = 2
const GRAPH_PAD = 28

const SPINE_WIDTH = 2.5
const BRANCH_WIDTH = 1.8
const EDGE_CURVATURE = 0.45
const LOCKED_LINK_DASH = '6 6'
const QUEUED_BRANCH_DASH = '4 5'
const NEUTRAL_EDGE_COLOR = 'var(--border2)'
const SPINE_LABEL = 'then'

const NODE_TYPES = { orb: OrbNode }
const EDGE_TYPES = { grad: GradientEdge }

const WAVE_COLOR: Record<Wave['state'], string> = { complete: 'var(--sage)', running: 'var(--devC)', locked: NEUTRAL_EDGE_COLOR }
const CARD_COLOR: Record<WaveCard['status'], string> = { merged: 'var(--sage)', review: 'var(--crC)', working: 'var(--devC)', queued: NEUTRAL_EDGE_COLOR }
const ROOT_COLOR = 'var(--devC)'

const ROOT_NODE_ID = 'root'
const waveNodeId = (wave: number) => `wave-${wave}`
const cardNodeId = (cardId: string) => `card-${cardId}`
const moreNodeId = (wave: number) => `more-${wave}`

function buildNodes(layout: WaveGraphLayout): OrbFlowNode[] {
  const place = (id: string, kind: OrbKind, centre: { x: number; y: number }, data: OrbIdentity): OrbFlowNode => ({
    id,
    type: 'orb',
    position: orbNodeOrigin(kind, centre),
    ...orbNodeSize(kind),
    style: NODE_HOSTS_BUTTONS_STYLE,
    data,
  })
  return [
    place(ROOT_NODE_ID, 'root', layout.root, { kind: 'root' }),
    ...layout.waves.map((wave) => place(waveNodeId(wave.wave), 'wave', wave, { kind: 'wave', wave: wave.wave })),
    ...layout.cards.map((card) => place(cardNodeId(card.id), 'card', card, { kind: 'card', cardId: card.id, side: card.side })),
    ...layout.more.map((more) => place(moreNodeId(more.wave), 'more', more, { kind: 'more', wave: more.wave, count: more.count })),
  ]
}

function gradientEdge(edgeId: string, source: string, sourceHandle: string, target: string, targetColor: string, sourceColor: string, extra: Partial<GradientEdgeData> & { isReached: boolean }): GradientFlowEdge {
  return {
    id: edgeId,
    source,
    sourceHandle,
    target,
    targetHandle: 'in',
    type: 'grad',
    data: { edgeId, sourceColor, targetColor, curvature: EDGE_CURVATURE, ...extra },
  }
}

function buildEdges(waves: Wave[], layout: WaveGraphLayout): GradientFlowEdge[] {
  const spine = waves.map((wave, index) => {
    const isLocked = wave.state === 'locked'
    const previous = waves[index - 1]
    const sourceId = previous ? waveNodeId(previous.wave) : ROOT_NODE_ID
    return gradientEdge(
      `${previous ? `w${previous.wave}` : 'root'}-w${wave.wave}`,
      sourceId,
      'out',
      waveNodeId(wave.wave),
      WAVE_COLOR[wave.state],
      previous ? WAVE_COLOR[previous.state] : ROOT_COLOR,
      { isReached: !isLocked, width: SPINE_WIDTH, dash: isLocked ? LOCKED_LINK_DASH : undefined, isDim: isLocked, label: previous ? SPINE_LABEL : undefined },
    )
  })

  const branchesOf = (wave: Wave): GradientFlowEdge[] => {
    const sourceColor = WAVE_COLOR[wave.state]
    const sourceId = waveNodeId(wave.wave)
    const cards = layout.cards.filter((card) => card.wave === wave.wave).map((placed) => {
      const status = wave.cards.find((card) => card.id === placed.id)?.status ?? 'queued'
      return gradientEdge(`w${wave.wave}-${placed.id}`, sourceId, placed.side === 'above' ? 'up' : 'down', cardNodeId(placed.id), CARD_COLOR[status], sourceColor, {
        isReached: status !== 'queued',
        width: BRANCH_WIDTH,
        dash: status === 'queued' ? QUEUED_BRANCH_DASH : undefined,
        isDim: status === 'queued',
      })
    })
    const more = layout.more.filter((placed) => placed.wave === wave.wave).map((placed) =>
      gradientEdge(`w${wave.wave}-more`, sourceId, placed.side === 'above' ? 'up' : 'down', moreNodeId(wave.wave), NEUTRAL_EDGE_COLOR, sourceColor, {
        isReached: false,
        width: BRANCH_WIDTH,
        dash: QUEUED_BRANCH_DASH,
        isDim: true,
      }))
    return [...cards, ...more]
  }
  return [...spine, ...waves.flatMap(branchesOf)]
}

interface ZoomControlsProps {
  viewportRef: { current: FlowViewport }
  log: Logger
}

// Zoom in, zoom out and back to the hand-worked fit; no lock button, since
// nothing here is editable. A Panel rather than <Controls>, which takes no
// testid and always draws the lock.
function ZoomControls({ viewportRef, log }: ZoomControlsProps) {
  const { zoomIn, zoomOut, setViewport } = useReactFlow()
  const run = (action: string, apply: () => Promise<unknown>) => () => {
    apply().catch((err: unknown) => log(`[wave-graph] could not ${action}`, err))
  }
  return (
    <Panel position="top-right" className="react-flow__controls wave-graph-controls" data-testid="wave-graph-controls">
      <ControlButton data-testid="wave-graph-zoom-in" title="Zoom in" aria-label="Zoom in" onClick={run('zoom in', () => zoomIn())}>+</ControlButton>
      <ControlButton data-testid="wave-graph-zoom-out" title="Zoom out" aria-label="Zoom out" onClick={run('zoom out', () => zoomOut())}>−</ControlButton>
      <ControlButton data-testid="wave-graph-fit" title="Fit to view" aria-label="Fit to view" onClick={run('fit the view', () => setViewport(viewportRef.current))}>⤢</ControlButton>
    </Panel>
  )
}

export interface WaveGraphProps {
  task: Task
  log?: Logger
}

function WaveGraphFlow({ task, log = console.error }: WaveGraphProps) {
  const { selectMilestone } = useTaskDetailNav()
  const isCreatureShown = useCreaturePlacement() !== 'off'
  const [boxRef, containerWidth] = useElementWidth<HTMLDivElement>()
  const [expandedWaves, setExpandedWaves] = useState<ReadonlySet<number>>(() => new Set())

  const waves = buildWaves(task.milestones ?? [])
  const layout = layoutWaveGraph(
    waves.map((wave) => ({ wave: wave.wave, cardIds: wave.cards.map((card) => card.id), isComplete: wave.state === 'complete' })),
    expandedWaves,
  )
  const viewport = computeFlowViewport({ containerWidth, contentBounds: layout.bounds, pad: GRAPH_PAD, minZoom: WAVE_ZOOM_FLOOR, focusX: layout.focusX })
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport

  // Node objects keep their identity until the arrangement changes (a wave
  // gained or lost a milestone, a wave was expanded): a re-adopted node loses
  // its measurement. React Flow owns the list from there, so a drag moves a
  // node, and a rebuilt arrangement is what drops a dragged position. The
  // rebuild happens during render, not in an effect, so React Flow never sees
  // the new edges alongside the old nodes they don't point at yet.
  const arrangementKey = [layout.cards.map((card) => `${card.id}@${card.wave}${card.side}${card.rank}`), layout.more.map((more) => `${more.wave}+${more.count}`), layout.waves.map((wave) => wave.wave)].map((part) => part.join(',')).join('|')
  const [nodes, setNodes, onNodesChange] = useNodesState<OrbFlowNode>(buildNodes(layout))
  const [appliedArrangement, setAppliedArrangement] = useState(arrangementKey)
  if (appliedArrangement !== arrangementKey) {
    setAppliedArrangement(arrangementKey)
    setNodes(buildNodes(layout))
  }

  const edges: Edge[] = buildEdges(waves, layout)

  // A graph that fits its box has nothing to pan to until it is zoomed in past
  // the fit, which pushes nodes over the box's edges.
  const isZoomedPastFit = useStore((state) => state.transform[2] > viewport.zoom)
  const canPan = !viewport.fits || isZoomedPastFit

  const handleOpenCard = useCallback((card: WaveCard) => {
    if (card.childSlug) navigateToTask(card.childSlug)
    else selectMilestone(card.id)
  }, [selectMilestone])
  const handleExpandWave = useCallback((wave: number) => setExpandedWaves((previous) => new Set(previous).add(wave)), [])

  // The first incomplete wave is part of the key: when it advances in a graph
  // wider than its box, the viewport follows it to the new focus point.
  const shapeKey = `${containerWidth}|${arrangementKey}|${layout.focusX}`
  return (
    <div
      ref={boxRef}
      className="pipeline-chart wave-graph"
      data-testid="wave-graph"
      data-fits={viewport.fits ? 'true' : 'false'}
      data-content-height={layout.bounds.height}
      style={{ height: viewport.boxHeight }}
    >
      <WaveGraphContext.Provider value={{ task, waves, isCreatureShown, onOpenCard: handleOpenCard, onExpandWave: handleExpandWave }}>
        <ReactFlow<OrbFlowNode>
          {...DISPLAY_ONLY_FLOW_PROPS}
          className="stage-flow wave-flow"
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          nodesDraggable
          panOnDrag={canPan}
          minZoom={WAVE_ZOOM_FLOOR}
          maxZoom={MAX_ZOOM}
          defaultViewport={{ x: viewport.x, y: viewport.y, zoom: viewport.zoom }}
        >
          <ViewportController viewportRef={viewportRef} shapeKey={shapeKey} log={log} graphName="wave-graph" />
          <ZoomControls viewportRef={viewportRef} log={log} />
        </ReactFlow>
      </WaveGraphContext.Provider>
      {!viewport.fits && <div className="wave-graph-fade" data-testid="wave-graph-fade" />}
    </div>
  )
}

export function WaveGraph(props: WaveGraphProps) {
  return (
    <ReactFlowProvider>
      <WaveGraphFlow {...props} />
    </ReactFlowProvider>
  )
}
