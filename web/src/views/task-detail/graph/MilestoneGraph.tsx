import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react'
import type { MilestoneStatus, Task } from '../../../../../src/types'
import { runWaveBatch } from '../../../api/waveBatch'
import { clientState, useClientState } from '../../../data/clientState'
import { eligibleWaveMilestones, waveRule } from '../../../milestoneModel'
import { useTaskDetailNav } from '../detailNav'
import { MilestoneCard } from '../MilestoneCard'
import { useSnapshot } from '../../../data/snapshot'
import { DISPLAY_ONLY_FLOW_PROPS, NODE_HOSTS_BUTTONS_STYLE } from './flowConfig'
import { buildMilestoneEdges, layoutMilestoneGraph, waveHeaderNodeId } from './milestoneGraphLayout'
import { useElementWidth } from './useElementWidth'
import { READ_ONLY_INSTANCE_TITLE } from '../../../components/readOnly'

// The fan-out parent's milestone graph, rendered with React Flow: waves are
// rows, cards are nodes, and each declared `needs:` dependency is an edge.
// Each node is a MilestoneCard (status, stats, CTA) or a wave header (the
// wave's rule and its Run wave button). Selecting a milestone opens its
// drill-down through the task detail's nav.

type ReportHeight = (nodeId: string, height: number) => void

// Node objects handed to React Flow must keep their identity across renders: a
// re-adopted node loses its measurement and stays hidden until it's measured
// again, which never happens for an unchanged size. So everything that changes
// with each snapshot (the task, its milestones) reaches the node components
// through context, and the node objects only change when the layout does.
interface MilestoneGraphContextValue {
  task: Task
  milestoneById: ReadonlyMap<string, MilestoneStatus>
  // Whether this is the one real orchestrator dashboard (see
  // isCanonicalDispatchInstance in server.ts): a worktree's preview or an e2e
  // server report false, and dispatching from there is refused.
  isCanonical: boolean
  reportHeight: ReportHeight
}
const MilestoneGraphContext = createContext<MilestoneGraphContextValue | null>(null)

interface NodeIdentity extends Record<string, unknown> {
  wave: number
}
type WaveHeaderFlowNode = Node<NodeIdentity, 'waveHeader'>
type MilestoneFlowNode = Node<NodeIdentity, 'milestone'>

// Reports the node's rendered height so the layout can stack rows by their
// real size (cards vary: a queued milestone has no stats row, a dispatched one
// has a CTA footer) — React Flow needs the positions up front.
function useReportHeight(nodeId: string, reportHeight: ReportHeight | undefined) {
  const elementRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const element = elementRef.current
    if (!element || !reportHeight) return
    reportHeight(nodeId, Math.ceil(element.getBoundingClientRect().height))
    const observer = new ResizeObserver(([entry]) => {
      if (entry) reportHeight(nodeId, Math.ceil(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [nodeId, reportHeight])
  return elementRef
}

function WaveHeaderNode({ id, data }: NodeProps<WaveHeaderFlowNode>) {
  const context = useContext(MilestoneGraphContext)
  const { wave } = data
  const elementRef = useReportHeight(id, context?.reportHeight)
  if (!context) return null
  const { task, isCanonical } = context
  const milestones = task.milestones ?? []
  const rule = waveRule(milestones.filter((milestone) => milestone.wave === wave))
  const eligibleCount = eligibleWaveMilestones(milestones, wave, task.stageHistory).length
  const isRunning = clientState.isWaveRunning(task.slug, wave)
  const isRunDisabled = eligibleCount === 0 || isRunning || !isCanonical
  const runTitle = !isCanonical
    ? READ_ONLY_INSTANCE_TITLE
    : isRunning
      ? `Staging wave ${wave}…`
      : eligibleCount
        ? `Stages one command for wave ${wave}'s queued, unblocked milestones — unsent, for you to review`
        : 'Nothing queued and unblocked in this wave yet'

  return (
    <div ref={elementRef} className="wave milestone-flow-wave" data-testid="wave" data-wave={wave}>
      <div className="wave-header" data-testid="wave-header">
        <span className="wave-name">Wave {wave}</span>
        <span className="wave-rule">{rule}</span>
        <button
          className="btn wave-batch-btn"
          type="button"
          data-testid="wave-batch-btn"
          disabled={isRunDisabled}
          title={runTitle}
          onClick={() => { void runWaveBatch(task, wave) }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M7 5l12 7-12 7V5z" /></svg>
          <span>Run wave (<span data-testid="wave-batch-count">{eligibleCount}</span>)</span>
        </button>
      </div>
    </div>
  )
}

function MilestoneNode({ id }: NodeProps<MilestoneFlowNode>) {
  const context = useContext(MilestoneGraphContext)
  const { selectMilestone } = useTaskDetailNav()
  const elementRef = useReportHeight(id, context?.reportHeight)
  const milestone = context?.milestoneById.get(id)
  if (!context || !milestone) return null
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} className="milestone-flow-handle" />
      <div ref={elementRef}>
        <div data-testid={`milestone-node-${milestone.id}`}>
          <MilestoneCard milestone={milestone} parent={context.task} onSelect={selectMilestone} />
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="milestone-flow-handle" />
    </>
  )
}

const NODE_TYPES = { waveHeader: WaveHeaderNode, milestone: MilestoneNode }

export interface MilestoneGraphProps {
  task: Task
  milestones: MilestoneStatus[]
}

export function MilestoneGraph({ task, milestones }: MilestoneGraphProps) {
  // Re-renders the wave headers when a wave batch starts or settles.
  useClientState()
  const { data } = useSnapshot()
  const [frameRef, containerWidth] = useElementWidth<HTMLDivElement>()
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map())
  const reportHeight = useCallback<ReportHeight>((nodeId, height) => {
    setHeights((previous) => {
      if (previous.get(nodeId) === height) return previous
      return new Map(previous).set(nodeId, height)
    })
  }, [])

  // Drop measurements for nodes the plan no longer has (a milestone removed by
  // a tech-design.md edit), so the map can't grow for the life of the view.
  const nodeIdsKey = milestones.map((milestone) => `${milestone.id}@${milestone.wave}`).join(',')
  useEffect(() => {
    const liveIds = new Set([...milestones.map((milestone) => milestone.id), ...milestones.map((milestone) => waveHeaderNodeId(milestone.wave))])
    setHeights((previous) => {
      const kept = [...previous].filter(([nodeId]) => liveIds.has(nodeId))
      return kept.length === previous.size ? previous : new Map(kept)
    })
  }, [nodeIdsKey]) // keyed on the ids the effect reads

  const layout = layoutMilestoneGraph({ milestones, containerWidth, heights })
  const milestoneById = new Map(milestones.map((milestone) => [milestone.id, milestone]))

  // Keyed on the layout's own serialisation — see MilestoneGraphContext above.
  const nodesKey = layout.nodes.map((placed) => `${placed.id}:${placed.kind}:${placed.wave}:${placed.x}:${placed.y}:${placed.width}`).join('|')
  // The cast: `type` is picked by a ternary, which TypeScript widens to a union
  // it can't match back to each member's own node type; the two node types
  // carry identical data, so the object is valid for whichever it names.
  const nodes = useMemo<Array<WaveHeaderFlowNode | MilestoneFlowNode>>(() => layout.nodes.map((placed) => ({
    id: placed.id,
    type: placed.kind === 'wave-header' ? 'waveHeader' : 'milestone',
    position: { x: placed.x, y: placed.y },
    width: placed.width,
    style: NODE_HOSTS_BUTTONS_STYLE,
    data: { wave: placed.wave },
  } as WaveHeaderFlowNode | MilestoneFlowNode)), [nodesKey])

  const edges: Edge[] = buildMilestoneEdges(milestones).map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    className: edge.isSatisfied ? 'is-satisfied' : undefined,
  }))

  return (
    // React Flow fills 100% of its parent and ignores its own height style, so
    // the canvas height lives on this frame.
    <div ref={frameRef} className="milestone-flow-frame" style={{ height: layout.height }}>
      <MilestoneGraphContext.Provider value={{ task, milestoneById, isCanonical: data?.isCanonical ?? false, reportHeight }}>
        <ReactFlow
          {...DISPLAY_ONLY_FLOW_PROPS}
          className="milestone-flow"
          data-testid="milestone-flow"
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
        />
      </MilestoneGraphContext.Provider>
    </div>
  )
}
