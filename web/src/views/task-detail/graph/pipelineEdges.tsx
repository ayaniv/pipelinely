import { useId } from 'react'
import { EdgeLabelRenderer, getBezierPath, getSmoothStepPath, type Edge, type EdgeProps } from '@xyflow/react'

// The pipeline chart's two edge kinds. Every colour is a `var(--…)` token, so
// dark mode is the token swap alone; gradients are userSpaceOnUse because a
// straight horizontal edge has a zero-height bounding box, which an
// objectBoundingBox gradient cannot paint.

export interface GradientEdgeData extends Record<string, unknown> {
  // `<source>-<target>`: what the specs, and the no-edge-crosses-a-label
  // check, find an edge by.
  edgeId: string
  sourceColor: string
  targetColor: string
  isReached: boolean
  // The wave graph's edges differ from the chart's only in these: bend,
  // stroke width and dash, a dimmed look for what hasn't started, and an
  // optional label at the midpoint. Absent, the chart's own CSS applies.
  curvature?: number
  width?: number
  dash?: string
  isDim?: boolean
  label?: string
}

export type GradientFlowEdge = Edge<GradientEdgeData, 'grad'>

const REACHED_STOP_OPACITY = 0.9
const UNREACHED_STOP_OPACITY = 0.55
const DIM_OPACITY = 0.55
const EDGE_LABEL_RISE = 8

export function GradientEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<GradientFlowEdge>) {
  const gradientId = `grad-${useId().replace(/:/g, '')}`
  if (!data) return null
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, curvature: data.curvature })
  const stopOpacity = data.isReached ? REACHED_STOP_OPACITY : UNREACHED_STOP_OPACITY
  return (
    <>
      <defs>
        <linearGradient id={gradientId} data-edge-id={data.edgeId} gradientUnits="userSpaceOnUse" x1={sourceX} y1={sourceY} x2={targetX} y2={targetY}>
          <stop offset="0" style={{ stopColor: data.sourceColor }} stopOpacity={stopOpacity} />
          <stop offset="1" style={{ stopColor: data.targetColor }} stopOpacity={stopOpacity} />
        </linearGradient>
      </defs>
      <path
        d={path}
        className="pipeline-edge"
        data-testid="flow-edge"
        data-edge-id={data.edgeId}
        data-reached={data.isReached ? 'true' : 'false'}
        data-dim={data.isDim ? 'true' : undefined}
        stroke={`url(#${gradientId})`}
        fill="none"
        style={{ strokeWidth: data.width, strokeDasharray: data.dash, opacity: data.isDim ? DIM_OPACITY : undefined }}
      />
      {data.label && <text className="wave-edge-label" data-testid="wave-edge-label" x={labelX} y={labelY - EDGE_LABEL_RISE} textAnchor="middle">{data.label}</text>}
    </>
  )
}

export interface ReworkLoopData extends Record<string, unknown> {
  label: string
}

export type ReworkLoopFlowEdge = Edge<ReworkLoopData, 'loop'>

// How far under the label blocks the loop runs, and its corner radius.
const LOOP_DROP = 22
const LOOP_RADIUS = 12

export function ReworkLoopEdge({ source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps<ReworkLoopFlowEdge>) {
  const [path] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, offset: LOOP_DROP, borderRadius: LOOP_RADIUS })
  return (
    <>
      <path
        d={path}
        className="pipeline-loop"
        data-testid="stage-rework-loop"
        data-edge-id={`${source}-${target}-loop`}
        data-source={source}
        data-target={target}
        data-animated="true"
        markerEnd={markerEnd}
        fill="none"
      />
      <EdgeLabelRenderer>
        <div
          className="stage-rework-label"
          data-testid="stage-rework-label"
          style={{ transform: `translate(-50%, -50%) translate(${(sourceX + targetX) / 2}px, ${Math.max(sourceY, targetY) + LOOP_DROP}px)` }}
        >
          {data?.label}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}
