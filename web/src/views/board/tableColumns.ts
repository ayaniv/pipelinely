import type { TableSortKey } from './tableSort'

export type TableGroupKey = 'needs' | 'working'

// One column list per group feeds the header row and every body row, so their
// grid tracks and widths cannot drift apart.

interface ColumnBase {
  label: string
  minPx: number
  // The column's share of the leftover width, or null for a fixed column.
  growFr: number | null
}

// A sortable column names the sort key it cycles, so the header needs no cast.
export type TableColumn =
  | (ColumnBase & { key: TableSortKey; isSortable: true })
  | (ColumnBase & { key: 'actions'; isSortable: false })

// The design's tracks (Pipelinely Dashboard v4 `tableGroups.cols`): only Task
// and State grow.
const TASK: TableColumn = { key: 'task', label: 'Task', minPx: 220, growFr: 1.5, isSortable: true }
const PROJECT: TableColumn = { key: 'project', label: 'Project', minPx: 92, growFr: null, isSortable: true }
const STAGE: TableColumn = { key: 'stage', label: 'Stage', minPx: 110, growFr: null, isSortable: true }
const CTX: TableColumn = { key: 'ctx', label: 'Ctx', minPx: 104, growFr: null, isSortable: true }
const NEXT: TableColumn = { key: 'next', label: 'Next', minPx: 140, growFr: null, isSortable: true }
const ACTIONS: TableColumn = { key: 'actions', label: '', minPx: 56, growFr: null, isSortable: false }
// Working has no Next column, so its State takes the extra share.
const STATE_NEEDS: TableColumn = { key: 'state', label: 'State', minPx: 180, growFr: 1.5, isSortable: true }
const STATE_WORKING: TableColumn = { ...STATE_NEEDS, growFr: 2 }

export const TABLE_COLUMNS: Record<TableGroupKey, TableColumn[]> = {
  needs: [TASK, PROJECT, STAGE, STATE_NEEDS, CTX, NEXT, ACTIONS],
  working: [TASK, PROJECT, STAGE, STATE_WORKING, CTX, ACTIONS],
}

// The table sets these as CSS variables, so the min width below and the
// stylesheet read the same numbers.
export const TABLE_COL_GAP_PX = 18
export const TABLE_PAD_X_PX = 18

export function gridTemplate(columns: TableColumn[]): string {
  return columns.map((column) => (column.growFr === null ? `${column.minPx}px` : `minmax(${column.minPx}px, ${column.growFr}fr)`)).join(' ')
}

// The design's own min-width per table (Pipelinely Dashboard v4 `tableGroups.minW`).
// Needs you's 1060 leaves 14px past its tracks, which State takes; Working's
// 880 is short of its own tracks, so those win.
const DESIGN_MIN_WIDTH_PX: Record<TableGroupKey, number> = { needs: 1060, working: 880 }

// The narrowest a table gets before its own scroller scrolls sideways: the
// design's floor, or every track at its minimum plus the gaps and the row
// padding, whichever is wider.
export function tableMinWidthPx(group: TableGroupKey, columns: TableColumn[]): number {
  const tracks = columns.reduce((total, column) => total + column.minPx, 0)
  const gaps = Math.max(0, columns.length - 1) * TABLE_COL_GAP_PX
  return Math.max(DESIGN_MIN_WIDTH_PX[group], tracks + gaps + 2 * TABLE_PAD_X_PX)
}
