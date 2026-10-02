import { describe, expect, test } from 'vitest'
import { MIN_EDGE_LENGTH, layoutStageChain } from './stageChainLayout'

const NODE_WIDTH = 82

describe('layoutStageChain', () => {
  test('spreads nodes across the available width, like the flexing connectors it replaces', () => {
    const layout = layoutStageChain({ nodeCount: 5, nodeWidth: NODE_WIDTH, availableWidth: 700 })

    expect(layout.width).toBe(700)
    expect(layout.xPositions[0]).toBe(0)
    expect(layout.xPositions[4] + NODE_WIDTH).toBe(700)
    const gaps = layout.xPositions.slice(1).map((x, i) => x - layout.xPositions[i] - NODE_WIDTH)
    expect(new Set(gaps).size).toBe(1)
  })

  test('never lets a connector shrink below its minimum, and reports the overflow width so the row scrolls', () => {
    const layout = layoutStageChain({ nodeCount: 5, nodeWidth: NODE_WIDTH, availableWidth: 300 })

    expect(layout.xPositions[1] - layout.xPositions[0] - NODE_WIDTH).toBe(MIN_EDGE_LENGTH)
    expect(layout.width).toBe(5 * NODE_WIDTH + 4 * MIN_EDGE_LENGTH)
  })

  test('an unmeasured (hidden) container falls back to the minimum spacing', () => {
    const layout = layoutStageChain({ nodeCount: 3, nodeWidth: NODE_WIDTH, availableWidth: 0 })
    expect(layout.width).toBe(3 * NODE_WIDTH + 2 * MIN_EDGE_LENGTH)
  })

  test('a lone node sits at the start with no gap', () => {
    expect(layoutStageChain({ nodeCount: 1, nodeWidth: NODE_WIDTH, availableWidth: 500 })).toEqual({ xPositions: [0], width: NODE_WIDTH })
  })

  test('no nodes, no width', () => {
    expect(layoutStageChain({ nodeCount: 0, nodeWidth: NODE_WIDTH, availableWidth: 500 })).toEqual({ xPositions: [], width: 0 })
  })
})
