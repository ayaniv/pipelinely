// Horizontal placement of the stage chain's React Flow nodes. Connectors
// soak up whatever width the row has (min 12px), so the chain fills its card on desktop, and
// still scrolls (the row's own overflow-x) instead of squashing on a narrow one.

export const MIN_EDGE_LENGTH = 12

export interface StageChainLayoutInput {
  nodeCount: number
  nodeWidth: number
  availableWidth: number
}

export interface StageChainLayout {
  xPositions: number[]
  width: number
}

export function layoutStageChain({ nodeCount, nodeWidth, availableWidth }: StageChainLayoutInput): StageChainLayout {
  if (nodeCount === 0) return { xPositions: [], width: 0 }
  if (nodeCount === 1) return { xPositions: [0], width: nodeWidth }

  const gapCount = nodeCount - 1
  const gap = Math.max(MIN_EDGE_LENGTH, (availableWidth - nodeCount * nodeWidth) / gapCount)
  return {
    xPositions: Array.from({ length: nodeCount }, (_, index) => index * (nodeWidth + gap)),
    width: nodeCount * nodeWidth + gapCount * gap,
  }
}
