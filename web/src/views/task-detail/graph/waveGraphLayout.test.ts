import { describe, expect, test } from 'vitest'
import {
  CARD_OFFSET_X,
  FIRST_ROW,
  MAX_VISIBLE_CARDS,
  ROW_SHIFT,
  ROW_STEP,
  LABEL_GAP,
  ORB_BOX,
  WAVE_SPACING,
  layoutWaveGraph,
  orbHandleOffset,
  orbNodeOrigin,
  orbNodeSize,
  placeWaveCards,
  type WaveGraphInput,
} from './waveGraphLayout'

// dashboard-v4-inner-view M2. REQUEST-v4.md §3 "Layout": root at x=0, waves
// on the spine every 215px; tasks 100px right of their wave, floor(n/2) above
// and the rest below; the first row 118px from the spine, each extra row
// 110px further out and 18px further right; from five tasks a wave shows four
// and a "+N more" circle. Positions here are circle centres in flow units.

function waves(...sizes: number[]): WaveGraphInput[] {
  return sizes.map((size, index) => ({
    wave: index + 1,
    cardIds: Array.from({ length: size }, (_, card) => `W${index + 1}C${card}`),
  }))
}

describe('placeWaveCards', () => {
  test('1 task: below, 100px right, 118px down', () => {
    expect(placeWaveCards(1, 215)).toEqual([{ x: 215 + CARD_OFFSET_X, y: FIRST_ROW, side: 'below', rank: 0 }])
  })

  test('2 tasks: one above, one below', () => {
    expect(placeWaveCards(2, 0).map((card) => card.side)).toEqual(['above', 'below'])
    expect(placeWaveCards(2, 0).map((card) => card.y)).toEqual([-FIRST_ROW, FIRST_ROW])
  })

  test('3 tasks: one above, two below, the outer one 110px further and 18px right', () => {
    const cards = placeWaveCards(3, 0)
    expect(cards.map((card) => card.side)).toEqual(['above', 'below', 'below'])
    expect(cards[2]).toEqual({ x: CARD_OFFSET_X + ROW_SHIFT, y: FIRST_ROW + ROW_STEP, side: 'below', rank: 1 })
  })

  test('4 tasks: two above (outer first), two below', () => {
    const cards = placeWaveCards(4, 0)
    expect(cards.map((card) => card.side)).toEqual(['above', 'above', 'below', 'below'])
    expect(cards.map((card) => card.y)).toEqual([-(FIRST_ROW + ROW_STEP), -FIRST_ROW, FIRST_ROW, FIRST_ROW + ROW_STEP])
    expect(cards[0].x).toBe(CARD_OFFSET_X + ROW_SHIFT)
  })

  test('no tasks, no positions', () => {
    expect(placeWaveCards(0, 0)).toEqual([])
  })
})

describe('layoutWaveGraph', () => {
  test('the root sits at x=0 and each wave 215px further along the spine', () => {
    const layout = layoutWaveGraph(waves(1, 2, 1), new Set())
    expect(layout.root).toEqual({ x: 0, y: 0 })
    expect(layout.waves.map((wave) => wave.x)).toEqual([WAVE_SPACING, 2 * WAVE_SPACING, 3 * WAVE_SPACING])
    expect(new Set(layout.waves.map((wave) => wave.y))).toEqual(new Set([0]))
  })

  test('a wave of five or more shows four tasks and one "+N more" in the fifth slot', () => {
    const layout = layoutWaveGraph(waves(6), new Set())
    expect(layout.cards.map((card) => card.id)).toEqual(['W1C0', 'W1C1', 'W1C2', 'W1C3'])
    expect(MAX_VISIBLE_CARDS).toBe(4)
    expect(layout.more).toHaveLength(1)
    expect(layout.more[0]).toMatchObject({ wave: 1, count: 2 })
    const fifthSlot = placeWaveCards(5, WAVE_SPACING)
    expect(fifthSlot.some((slot) => slot.x === layout.more[0].x && slot.y === layout.more[0].y)).toBe(true)
  })

  test('an expanded wave shows every task and no "+N more"', () => {
    const layout = layoutWaveGraph(waves(6), new Set([1]))
    expect(layout.cards).toHaveLength(6)
    expect(layout.more).toEqual([])
  })

  test('exactly four tasks needs no "+N more"', () => {
    expect(layoutWaveGraph(waves(4), new Set()).more).toEqual([])
  })

  test('the bounds grow with the busiest wave', () => {
    const quiet = layoutWaveGraph(waves(1, 1), new Set())
    const busy = layoutWaveGraph(waves(1, 4), new Set())
    expect(busy.bounds.height).toBeGreaterThan(quiet.bounds.height)
    expect(busy.bounds.width).toBe(quiet.bounds.width)
  })

  test('the bounds start left of the root, so its blob and title are inside them', () => {
    const layout = layoutWaveGraph(waves(1), new Set())
    expect(layout.bounds.x).toBeLessThan(-42)
  })
})

describe('orb node geometry', () => {
  test('the circle centre sits where the layout puts it, whatever the node kind', () => {
    for (const kind of ['root', 'wave', 'card', 'more'] as const) {
      const origin = orbNodeOrigin(kind, { x: 300, y: -118 })
      const inHandle = orbHandleOffset(kind, 'in')
      const outHandle = orbHandleOffset(kind, 'out')
      expect(origin.y + inHandle.top).toBe(-118)
      expect(origin.x + (inHandle.left + outHandle.left) / 2).toBe(300)
      expect(outHandle.left - inHandle.left).toBe(ORB_BOX[kind].size)
    }
  })

  test('the bottom handle starts below the label block, so lower branches never leave through text', () => {
    for (const kind of ['wave', 'card'] as const) {
      const { size, labelHeight } = ORB_BOX[kind]
      const labelBottom = orbHandleOffset(kind, 'in').top + size / 2 + LABEL_GAP + labelHeight
      expect(orbHandleOffset(kind, 'down').top).toBeGreaterThanOrEqual(labelBottom)
      expect(orbHandleOffset(kind, 'down').top).toBeLessThanOrEqual(orbNodeSize(kind).height)
    }
  })

  test('the top handle sits on the circle\'s top edge', () => {
    expect(orbHandleOffset('wave', 'up').top).toBe(orbHandleOffset('wave', 'in').top - ORB_BOX.wave.size / 2)
  })
})
