import { describe, expect, test } from 'vitest'
import { makeMilestone } from '../../../testing/makeTask'
import {
  ESTIMATED_CARD_HEIGHT,
  ESTIMATED_WAVE_HEADER_HEIGHT,
  MILESTONE_CARD_MIN_WIDTH,
  MILESTONE_GRID_GAP,
  WAVE_ROW_GAP,
  buildMilestoneEdges,
  columnsForWidth,
  layoutMilestoneGraph,
  milestoneNodeId,
  waveHeaderNodeId,
} from './milestoneGraphLayout'

const noHeights = new Map<string, number>()

function layoutOf(ms: ReturnType<typeof makeMilestone>[], containerWidth: number, heights = noHeights) {
  const layout = layoutMilestoneGraph({ milestones: ms, containerWidth, heights })
  const byId = new Map(layout.nodes.map((node) => [node.id, node]))
  return { layout, at: (id: string) => byId.get(id)! }
}

describe('columnsForWidth', () => {
  test('never fewer than one column, however narrow the container', () => {
    expect(columnsForWidth(0)).toBe(1)
    expect(columnsForWidth(120)).toBe(1)
  })

  test('fits as many minimum-width cards as the container allows, gaps included', () => {
    expect(columnsForWidth(MILESTONE_CARD_MIN_WIDTH)).toBe(1)
    expect(columnsForWidth(2 * MILESTONE_CARD_MIN_WIDTH + MILESTONE_GRID_GAP)).toBe(2)
    expect(columnsForWidth(2 * MILESTONE_CARD_MIN_WIDTH + MILESTONE_GRID_GAP - 1)).toBe(1)
  })
})

describe('layoutMilestoneGraph', () => {
  test('waves stack top to bottom in ascending wave order, whatever order they were declared in', () => {
    const { at } = layoutOf([
      makeMilestone({ id: 'M2', wave: 3 }),
      makeMilestone({ id: 'M0', wave: 1 }),
      makeMilestone({ id: 'M1', wave: 2 }),
    ], 600)

    expect(at(waveHeaderNodeId(1)).y).toBeLessThan(at(waveHeaderNodeId(2)).y)
    expect(at(waveHeaderNodeId(2)).y).toBeLessThan(at(waveHeaderNodeId(3)).y)
  })

  test('a wave header spans the container and its cards sit below it', () => {
    const { at } = layoutOf([makeMilestone({ id: 'M0', wave: 1 })], 600)

    expect(at(waveHeaderNodeId(1))).toMatchObject({ x: 0, width: 600 })
    expect(at(milestoneNodeId('M0')).y).toBeGreaterThanOrEqual(at(waveHeaderNodeId(1)).y + ESTIMATED_WAVE_HEADER_HEIGHT)
  })

  test('cards in a wave share a row and split the container width evenly', () => {
    const width = 3 * MILESTONE_CARD_MIN_WIDTH + 2 * MILESTONE_GRID_GAP
    const { at } = layoutOf([
      makeMilestone({ id: 'M1', wave: 2 }), makeMilestone({ id: 'M2', wave: 2 }), makeMilestone({ id: 'M3', wave: 2 }),
    ], width)

    const cards = ['M1', 'M2', 'M3'].map((id) => at(milestoneNodeId(id)))
    expect(new Set(cards.map((card) => card.y)).size).toBe(1)
    expect(cards.map((card) => card.width)).toEqual([MILESTONE_CARD_MIN_WIDTH, MILESTONE_CARD_MIN_WIDTH, MILESTONE_CARD_MIN_WIDTH])
    expect(cards[1].x).toBe(MILESTONE_CARD_MIN_WIDTH + MILESTONE_GRID_GAP)
  })

  test('a wave wider than one row wraps onto the next, below the tallest card above', () => {
    const width = 2 * MILESTONE_CARD_MIN_WIDTH + MILESTONE_GRID_GAP
    const heights = new Map([[milestoneNodeId('M1'), 400], [milestoneNodeId('M2'), 300]])
    const { at } = layoutOf([
      makeMilestone({ id: 'M1', wave: 1 }), makeMilestone({ id: 'M2', wave: 1 }), makeMilestone({ id: 'M3', wave: 1 }),
    ], width, heights)

    expect(at(milestoneNodeId('M3')).x).toBe(0)
    expect(at(milestoneNodeId('M3')).y).toBe(at(milestoneNodeId('M1')).y + 400 + MILESTONE_GRID_GAP)
  })

  test('a narrow container stacks every card in one full-width column', () => {
    const { layout, at } = layoutOf([
      makeMilestone({ id: 'M0', wave: 1 }), makeMilestone({ id: 'M1', wave: 1 }),
    ], 350)

    expect(at(milestoneNodeId('M0')).width).toBe(350)
    expect(at(milestoneNodeId('M1')).x).toBe(0)
    expect(at(milestoneNodeId('M1')).y).toBeGreaterThan(at(milestoneNodeId('M0')).y)
    expect(layout.nodes.every((node) => node.x >= 0 && node.x + node.width <= 350)).toBe(true)
  })

  test('measured heights replace the estimates, and the next wave starts a row gap below the last row', () => {
    const heights = new Map([[waveHeaderNodeId(1), 50], [milestoneNodeId('M0'), 500]])
    const { at } = layoutOf([makeMilestone({ id: 'M0', wave: 1 }), makeMilestone({ id: 'M1', wave: 2 })], 600, heights)

    const cardY = at(milestoneNodeId('M0')).y
    expect(cardY).toBeGreaterThanOrEqual(50)
    expect(at(waveHeaderNodeId(2)).y).toBe(cardY + 500 + WAVE_ROW_GAP)
  })

  test('total height reaches the bottom of the last row', () => {
    const { layout, at } = layoutOf([makeMilestone({ id: 'M0', wave: 1 })], 600)
    expect(layout.height).toBe(at(milestoneNodeId('M0')).y + ESTIMATED_CARD_HEIGHT)
  })

  test('an unmeasured container (width 0) still lays out in one minimum-width column instead of collapsing', () => {
    const { layout, at } = layoutOf([makeMilestone({ id: 'M0', wave: 1 })], 0)

    expect(at(milestoneNodeId('M0')).width).toBe(MILESTONE_CARD_MIN_WIDTH)
    expect(layout.height).toBeGreaterThan(0)
  })

  test('no milestones means no nodes and no height', () => {
    const { layout } = layoutOf([], 600)
    expect(layout).toEqual({ nodes: [], height: 0 })
  })
})

describe('buildMilestoneEdges', () => {
  test('one edge per declared dependency, from the milestone it needs to the one that needs it', () => {
    const edges = buildMilestoneEdges([
      makeMilestone({ id: 'M0' }),
      makeMilestone({ id: 'M1', needs: ['M0'] }),
      makeMilestone({ id: 'M2', needs: ['M0', 'M1'] }),
    ])

    expect(edges.map((edge) => [edge.source, edge.target])).toEqual([
      [milestoneNodeId('M0'), milestoneNodeId('M1')],
      [milestoneNodeId('M0'), milestoneNodeId('M2')],
      [milestoneNodeId('M1'), milestoneNodeId('M2')],
    ])
  })

  test('an edge is satisfied once the milestone it leaves has merged', () => {
    const edges = buildMilestoneEdges([
      makeMilestone({ id: 'M0', state: 'done' }),
      makeMilestone({ id: 'M1', state: 'dispatched' }),
      makeMilestone({ id: 'M2', needs: ['M0', 'M1'] }),
    ])

    expect(edges.map((edge) => edge.isSatisfied)).toEqual([true, false])
  })

  test('a dependency on a milestone the plan does not declare is dropped instead of drawing a dangling edge', () => {
    const edges = buildMilestoneEdges([makeMilestone({ id: 'M1', needs: ['M9'] })])
    expect(edges).toEqual([])
  })
})
