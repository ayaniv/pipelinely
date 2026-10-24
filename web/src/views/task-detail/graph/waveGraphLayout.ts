import type { ContentBounds } from './flowViewport'

// Placement of the wave graph's circles (REQUEST-v4.md §3 "Layout"), in flow
// units and as circle centres: the root at x=0 on a horizontal spine, wave i
// every WAVE_SPACING along it, and each wave's tasks fanned out above and
// below. Pure maths, so the arrangement is pinned without React Flow.

export const ROOT_SIZE = 84
export const WAVE_SIZE = 54
export const CARD_SIZE = 42
export const WAVE_SPACING = 215
export const CARD_OFFSET_X = 100
export const FIRST_ROW = 118
export const ROW_STEP = 110
export const ROW_SHIFT = 18
// From five tasks a wave shows this many and a "+N more" circle in the fifth slot.
export const MAX_VISIBLE_CARDS = 4

// Label blocks hang under their circle; the bounds need their extent so the
// box never clips a title.
export const ROOT_LABEL_WIDTH = 150
export const CARD_LABEL_WIDTH = 130
export const WAVE_LABEL_WIDTH = 130
export const ROOT_LABEL_HEIGHT = 64
export const WAVE_LABEL_HEIGHT = 40
export const CARD_LABEL_HEIGHT = 50
export const LABEL_GAP = 8
// A running node's halo reaches this far past its circle.
export const HALO_REACH = 8
// An un-expanded wave can put its "+N more" slot on the third row, so the
// bounds always reserve room for it: the box width then doesn't change when a
// wave gains a task or is expanded.
const MIN_RESERVED_RANK = 2

export type CardSide = 'above' | 'below'

export interface CardSlot {
  x: number
  y: number
  side: CardSide
  // 0 is the row nearest the spine.
  rank: number
}

// Slot order is the order tasks fill them: the upper half outermost first,
// then the lower half from the spine outward.
export function placeWaveCards(count: number, waveX: number): CardSlot[] {
  const aboveCount = Math.floor(count / 2)
  const belowCount = count - aboveCount
  const slotAt = (side: CardSide, rank: number): CardSlot => ({
    x: waveX + CARD_OFFSET_X + rank * ROW_SHIFT,
    y: (side === 'above' ? -1 : 1) * (FIRST_ROW + rank * ROW_STEP),
    side,
    rank,
  })
  return [
    ...Array.from({ length: aboveCount }, (_, index) => slotAt('above', aboveCount - 1 - index)),
    ...Array.from({ length: belowCount }, (_, rank) => slotAt('below', rank)),
  ]
}

export interface WaveGraphInput {
  wave: number
  cardIds: string[]
  // Absent counts as not complete; the first incomplete wave is the focus.
  isComplete?: boolean
}

export interface PlacedWave {
  wave: number
  x: number
  y: number
}

export interface PlacedCard extends CardSlot {
  id: string
  wave: number
}

export interface PlacedMore extends CardSlot {
  wave: number
  // How many tasks the circle stands in for.
  count: number
}

export interface WaveGraphLayout {
  root: { x: number; y: number }
  waves: PlacedWave[]
  cards: PlacedCard[]
  more: PlacedMore[]
  bounds: ContentBounds
  // Flow x the viewport pulls to the middle when the graph does not fit.
  focusX: number
}

export function layoutWaveGraph(waves: WaveGraphInput[], expandedWaves: ReadonlySet<number>): WaveGraphLayout {
  const placedWaves: PlacedWave[] = waves.map((input, index) => ({ wave: input.wave, x: (index + 1) * WAVE_SPACING, y: 0 }))
  const cards: PlacedCard[] = []
  const more: PlacedMore[] = []

  waves.forEach((input, index) => {
    const isCapped = input.cardIds.length > MAX_VISIBLE_CARDS && !expandedWaves.has(input.wave)
    const slots = placeWaveCards(isCapped ? MAX_VISIBLE_CARDS + 1 : input.cardIds.length, placedWaves[index].x)
    const visibleIds = isCapped ? input.cardIds.slice(0, MAX_VISIBLE_CARDS) : input.cardIds
    visibleIds.forEach((id, slotIndex) => cards.push({ id, wave: input.wave, ...slots[slotIndex] }))
    if (isCapped) more.push({ wave: input.wave, count: input.cardIds.length - MAX_VISIBLE_CARDS, ...slots[MAX_VISIBLE_CARDS] })
  })

  const focusWave = placedWaves.find((_, index) => !waves[index].isComplete)
  return { root: { x: 0, y: 0 }, waves: placedWaves, cards, more, bounds: boundsOf(placedWaves, [...cards, ...more]), focusX: focusWave?.x ?? 0 }
}

function boundsOf(placedWaves: PlacedWave[], slots: CardSlot[]): ContentBounds {
  const lastWaveX = placedWaves.at(-1)?.x ?? 0
  const maxRank = Math.max(MIN_RESERVED_RANK, ...slots.map((slot) => slot.rank))
  const left = -ROOT_LABEL_WIDTH / 2
  const right = lastWaveX + CARD_OFFSET_X + maxRank * ROW_SHIFT + CARD_LABEL_WIDTH / 2

  const circleReach = CARD_SIZE / 2 + HALO_REACH
  const cardBottom = (slot: CardSlot) => slot.y + circleReach + LABEL_GAP + CARD_LABEL_HEIGHT
  const rootBottom = ROOT_SIZE / 2 + LABEL_GAP + ROOT_LABEL_HEIGHT
  const waveBottom = placedWaves.length ? WAVE_SIZE / 2 + LABEL_GAP + WAVE_LABEL_HEIGHT : 0
  const top = Math.min(-ROOT_SIZE / 2, ...(placedWaves.length ? [-WAVE_SIZE / 2 - HALO_REACH] : []), ...slots.map((slot) => slot.y - circleReach))
  const bottom = Math.max(rootBottom, waveBottom, ...slots.map(cardBottom))

  return { x: left, y: top, width: right - left, height: bottom - top }
}

export type OrbKind = 'root' | 'wave' | 'card' | 'more'

interface OrbBox {
  size: number
  width: number
  labelHeight: number
}

export const ORB_BOX: Record<OrbKind, OrbBox> = {
  root: { size: ROOT_SIZE, width: ROOT_LABEL_WIDTH, labelHeight: ROOT_LABEL_HEIGHT },
  wave: { size: WAVE_SIZE, width: WAVE_LABEL_WIDTH, labelHeight: WAVE_LABEL_HEIGHT },
  card: { size: CARD_SIZE, width: CARD_LABEL_WIDTH, labelHeight: CARD_LABEL_HEIGHT },
  more: { size: CARD_SIZE, width: CARD_LABEL_WIDTH, labelHeight: CARD_LABEL_HEIGHT },
}

// A node is its circle (with room for the halo above and beside it) and the
// label block hanging underneath; the layout's positions are circle centres.
export function orbNodeSize(kind: OrbKind): { width: number; height: number } {
  const { size, width, labelHeight } = ORB_BOX[kind]
  return { width, height: HALO_REACH + size + LABEL_GAP + labelHeight }
}

export function orbNodeOrigin(kind: OrbKind, centre: { x: number; y: number }): { x: number; y: number } {
  const { size, width } = ORB_BOX[kind]
  return { x: centre.x - width / 2, y: centre.y - HALO_REACH - size / 2 }
}

export type OrbHandleSide = 'in' | 'out' | 'up' | 'down'

// Where each connection point sits inside the node box: the left and right
// ones on the circle's centre line, the top one on the circle's top, and the
// bottom one under the label block, so a lower branch never runs through text.
export function orbHandleOffset(kind: OrbKind, side: OrbHandleSide): { left: number; top: number } {
  const { size, width, labelHeight } = ORB_BOX[kind]
  const centreX = width / 2
  const centreY = HALO_REACH + size / 2
  switch (side) {
    case 'in':
      return { left: centreX - size / 2, top: centreY }
    case 'out':
      return { left: centreX + size / 2, top: centreY }
    case 'up':
      return { left: centreX, top: HALO_REACH }
    case 'down':
      return { left: centreX, top: HALO_REACH + size + LABEL_GAP + labelHeight }
  }
}
