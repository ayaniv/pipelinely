import type { MilestoneStatus } from '../../../../../src/types'

// Pure layout for the fan-out parent's milestone graph:
// waves are rows, top to bottom in dependency order, and a wave's cards fill
// the row (design track: no card narrower than
// 280px, 12px gap). Rows rather than columns so the graph reads in the same
// direction as the page and stacks into one column on a phone with no
// horizontal pan — the layout is a function of container width, not of zoom.

export const MILESTONE_CARD_MIN_WIDTH = 280
export const MILESTONE_GRID_GAP = 12
// Room between one wave's last row and the next wave's header, so the
// dependency edges have somewhere to curve.
export const WAVE_ROW_GAP = 48
const HEADER_TO_CARDS_GAP = 14
// Used until React Flow / the node itself reports a real height, and for the
// first paint of a graph that's never been measured.
export const ESTIMATED_CARD_HEIGHT = 300
export const ESTIMATED_WAVE_HEADER_HEIGHT = 44

export type MilestoneGraphNodeKind = 'wave-header' | 'milestone'

export interface MilestoneLayoutNode {
  id: string
  kind: MilestoneGraphNodeKind
  wave: number
  milestoneId: string | null
  x: number
  y: number
  width: number
}

export interface MilestoneLayout {
  nodes: MilestoneLayoutNode[]
  height: number
}

export interface MilestoneEdge {
  id: string
  source: string
  target: string
  isSatisfied: boolean
}

export const waveHeaderNodeId = (wave: number) => `wave-${wave}`
export const milestoneNodeId = (milestoneId: string) => milestoneId

export function columnsForWidth(containerWidth: number): number {
  return Math.max(1, Math.floor((containerWidth + MILESTONE_GRID_GAP) / (MILESTONE_CARD_MIN_WIDTH + MILESTONE_GRID_GAP)))
}

function groupByWave(milestones: MilestoneStatus[]): Map<number, MilestoneStatus[]> {
  const byWave = new Map<number, MilestoneStatus[]>()
  for (const milestone of milestones) {
    byWave.set(milestone.wave, [...(byWave.get(milestone.wave) ?? []), milestone])
  }
  return new Map([...byWave.entries()].sort(([a], [b]) => a - b))
}

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = []
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size))
  return rows
}

export interface MilestoneLayoutInput {
  milestones: MilestoneStatus[]
  containerWidth: number
  // Rendered heights by node id; anything missing falls back to the estimate.
  heights: ReadonlyMap<string, number>
}

export function layoutMilestoneGraph({ milestones, containerWidth, heights }: MilestoneLayoutInput): MilestoneLayout {
  // Width 0 means "not measured yet", not "zero-wide": lay out one
  // minimum-width column so the first paint isn't collapsed.
  const width = containerWidth > 0 ? containerWidth : MILESTONE_CARD_MIN_WIDTH
  const columns = columnsForWidth(width)
  const cardWidth = (width - (columns - 1) * MILESTONE_GRID_GAP) / columns

  const nodes: MilestoneLayoutNode[] = []
  let cursorY = 0
  let isFirstWave = true

  for (const [wave, inWave] of groupByWave(milestones)) {
    if (!isFirstWave) cursorY += WAVE_ROW_GAP
    isFirstWave = false

    const headerId = waveHeaderNodeId(wave)
    nodes.push({ id: headerId, kind: 'wave-header', wave, milestoneId: null, x: 0, y: cursorY, width })
    cursorY += (heights.get(headerId) ?? ESTIMATED_WAVE_HEADER_HEIGHT) + HEADER_TO_CARDS_GAP

    chunk(inWave, columns).forEach((row, rowIndex) => {
      if (rowIndex > 0) cursorY += MILESTONE_GRID_GAP
      row.forEach((milestone, columnIndex) => {
        nodes.push({
          id: milestoneNodeId(milestone.id),
          kind: 'milestone',
          wave,
          milestoneId: milestone.id,
          x: columnIndex * (cardWidth + MILESTONE_GRID_GAP),
          y: cursorY,
          width: cardWidth,
        })
      })
      cursorY += Math.max(...row.map((milestone) => heights.get(milestoneNodeId(milestone.id)) ?? ESTIMATED_CARD_HEIGHT))
    })
  }

  return { nodes, height: nodes.length ? cursorY : 0 }
}

export function buildMilestoneEdges(milestones: MilestoneStatus[]): MilestoneEdge[] {
  const byId = new Map(milestones.map((milestone) => [milestone.id, milestone]))
  return milestones.flatMap((milestone) =>
    milestone.needs.flatMap((needId) => {
      const needed = byId.get(needId)
      // The parser only emits declared ids, but a hand-edited plan mid-save
      // can name one that isn't there yet — an edge with a missing end would
      // make React Flow log an error on every render.
      if (!needed) return []
      return [{
        id: `${needId}->${milestone.id}`,
        source: milestoneNodeId(needId),
        target: milestoneNodeId(milestone.id),
        isSatisfied: needed.state === 'done',
      }]
    }),
  )
}
