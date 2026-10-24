// Horizontal placement of the pipeline chart's nodes (REQUEST-v4.md §2): one
// row of 150px nodes whose gap soaks up the box's spare width, so the chart
// spreads to fill it.

export const STAGE_NODE_WIDTH = 150
export const CHART_CONTENT_HEIGHT = 108
// Room under the label blocks for the rework loop to run beneath them.
export const CHART_LOOP_HEIGHT = 144
export const CHART_PAD = 24
const MIN_GAP = 28
const MAX_GAP = 220

export function stageGap(containerWidth: number, nodeCount: number): number {
  if (nodeCount < 2) return MIN_GAP
  const spare = (containerWidth - 2 * CHART_PAD - nodeCount * STAGE_NODE_WIDTH) / (nodeCount - 1)
  return Math.min(MAX_GAP, Math.max(MIN_GAP, spare))
}

export interface PipelineChartLayoutInput {
  nodeCount: number
  containerWidth: number
  hasLoop: boolean
}

export interface PipelineChartLayout {
  xPositions: number[]
  width: number
  height: number
}

export function layoutPipelineChart({ nodeCount, containerWidth, hasLoop }: PipelineChartLayoutInput): PipelineChartLayout {
  const height = hasLoop ? CHART_LOOP_HEIGHT : CHART_CONTENT_HEIGHT
  if (nodeCount === 0) return { xPositions: [], width: 0, height }
  const gap = stageGap(containerWidth, nodeCount)
  return {
    xPositions: Array.from({ length: nodeCount }, (_, index) => index * (STAGE_NODE_WIDTH + gap)),
    width: nodeCount * STAGE_NODE_WIDTH + (nodeCount - 1) * gap,
    height,
  }
}
