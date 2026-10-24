import { describe, expect, test } from 'vitest'
import { TABLE_COLUMNS, TABLE_COL_GAP_PX, TABLE_PAD_X_PX, gridTemplate, tableMinWidthPx, type TableColumn, type TableGroupKey } from './tableColumns'

const sumOfMinimums = (columns: TableColumn[]) => columns.reduce((total, column) => total + column.minPx, 0)

describe('gridTemplate', () => {
  test('a fixed column is its own width and a growing column is a minmax over its share', () => {
    expect(gridTemplate(TABLE_COLUMNS.needs)).toBe('minmax(220px, 1.5fr) 92px 110px minmax(180px, 1.5fr) 104px 140px 56px')
  })

  test("Working's State takes the share Next would have had", () => {
    expect(gridTemplate(TABLE_COLUMNS.working)).toBe('minmax(220px, 1.5fr) 92px 110px minmax(180px, 2fr) 104px 56px')
  })
})

describe('tableMinWidthPx', () => {
  test('is never narrower than every column minimum plus the gaps between them and the row padding', () => {
    for (const [group, columns] of Object.entries(TABLE_COLUMNS) as [TableGroupKey, TableColumn[]][]) {
      expect(tableMinWidthPx(group, columns)).toBeGreaterThanOrEqual(sumOfMinimums(columns) + (columns.length - 1) * TABLE_COL_GAP_PX + 2 * TABLE_PAD_X_PX)
    }
  })

  // Needs you keeps the design's 1060px floor, so below it the extra 14px still goes to State as in the design.
  test("keeps the design's floor when it is wider than the tracks need", () => {
    expect(tableMinWidthPx('needs', TABLE_COLUMNS.needs)).toBe(1060)
  })

  // The design's 880 for Working is 8px short of its own tracks, so the tracks win.
  test('takes the tracks when the design floor is too narrow for them', () => {
    expect(tableMinWidthPx('working', TABLE_COLUMNS.working)).toBe(888)
  })

  test('an empty column list is the design floor, never a negative gap', () => {
    expect(tableMinWidthPx('working', [])).toBe(880)
  })
})
