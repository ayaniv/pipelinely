import { describe, expect, test } from 'vitest'
import { CHART_CONTENT_HEIGHT, CHART_LOOP_HEIGHT, STAGE_NODE_WIDTH, layoutPipelineChart, stageGap } from './pipelineChartLayout'

// dashboard-v4-inner-view M1. REQUEST-v4.md §2: nodes in one row, the gap
// between them clamp(28, (containerWidth − 48 − n×150) / (n − 1), 220), so the
// chart spreads to fill its box; ~108px of content, ~144px with a loop.

describe('stageGap', () => {
  test('five nodes in a 1100px box spread to fill it', () => {
    expect(stageGap(1100, 5)).toBe((1100 - 48 - 5 * STAGE_NODE_WIDTH) / 4)
  })

  test('never closer than 28px', () => {
    expect(stageGap(700, 5)).toBe(28)
  })

  test('never further apart than 220px', () => {
    expect(stageGap(3000, 5)).toBe(220)
  })

  test('a milestone child\'s four nodes share the same rule over three gaps', () => {
    expect(stageGap(1000, 4)).toBe((1000 - 48 - 4 * STAGE_NODE_WIDTH) / 3)
  })

  test('an unmeasured box falls back to the minimum gap', () => {
    expect(stageGap(0, 5)).toBe(28)
  })
})

describe('layoutPipelineChart', () => {
  test('places nodes left to right on one row and reports the content width', () => {
    const layout = layoutPipelineChart({ nodeCount: 5, containerWidth: 1100, hasLoop: false })
    const gap = stageGap(1100, 5)
    expect(layout.xPositions).toEqual([0, 1, 2, 3, 4].map((i) => i * (STAGE_NODE_WIDTH + gap)))
    expect(layout.width).toBe(5 * STAGE_NODE_WIDTH + 4 * gap)
  })

  test('content height is 108px, or 144px when a rework loop has to fit underneath', () => {
    expect(layoutPipelineChart({ nodeCount: 5, containerWidth: 1100, hasLoop: false }).height).toBe(CHART_CONTENT_HEIGHT)
    expect(layoutPipelineChart({ nodeCount: 5, containerWidth: 1100, hasLoop: true }).height).toBe(CHART_LOOP_HEIGHT)
    expect(CHART_CONTENT_HEIGHT).toBe(108)
    expect(CHART_LOOP_HEIGHT).toBe(144)
  })

  test('no nodes, no width', () => {
    expect(layoutPipelineChart({ nodeCount: 0, containerWidth: 1100, hasLoop: false })).toEqual({ xPositions: [], width: 0, height: CHART_CONTENT_HEIGHT })
  })
})
