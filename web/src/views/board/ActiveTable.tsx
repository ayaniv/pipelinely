import type { KeyboardEvent } from 'react'
import type { CreaturePlacement, Task } from '../../../../src/types'
import type { OpenTask } from '../../shell/appNavigation'
import { ActiveGroupHeader } from './ActiveGroupHeader'
import { groupActiveTasks, type ActiveGroup } from './boardModel'
import { EmptyState } from './EmptyState'
import { TABLE_COLUMNS, TABLE_COL_GAP_PX, TABLE_PAD_X_PX, gridTemplate, tableMinWidthPx, type TableColumn, type TableGroupKey } from './tableColumns'
import { sortTableRows, type TableSort } from './tableSort'
import { tableSortStore, useTableSort } from './tableSortStore'
import { TableRow } from './TableRow'

// The Active panel's table view: one table per attention group, sharing one
// sort. Every row renders and the page does the scrolling; the table is ARIA
// roles over a CSS grid, not <table>, and its container scrolls sideways only.

export interface ActiveTableProps {
  tasks: Task[]
  now: number
  isTaskOffFocus: (slug: string) => boolean
  onToggleOffFocus: (slug: string) => void
  onOpenDetail: OpenTask
  creaturePlacement: CreaturePlacement
}

const ARIA_SORT = { asc: 'ascending', desc: 'descending' } as const
const SORT_ARROW = { asc: '▲', desc: '▼' } as const

function HeaderCell({ column, sort }: { column: TableColumn; sort: TableSort | null }) {
  const activeSort = sort?.key === column.key ? sort : null
  const sortKey = column.isSortable ? column.key : null
  const cycle = () => { if (sortKey) tableSortStore.cycle(sortKey) }
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      cycle()
    }
  }
  return (
    <div
      role="columnheader"
      className={`table-col${column.isSortable ? ' is-sortable' : ''}`}
      data-testid={`table-col-${column.key}`}
      aria-sort={column.isSortable ? (activeSort ? ARIA_SORT[activeSort.direction] : 'none') : undefined}
      tabIndex={column.isSortable ? 0 : undefined}
      onClick={column.isSortable ? cycle : undefined}
      onKeyDown={column.isSortable ? handleKeyDown : undefined}
    >
      {column.label}
      {activeSort && <span className="table-sort-arrow" data-testid="table-sort-arrow">{SORT_ARROW[activeSort.direction]}</span>}
    </div>
  )
}

interface GroupTableProps extends Omit<ActiveTableProps, 'tasks'> {
  group: TableGroupKey
  // The group's heading, which names the table for a screen reader.
  label: string
  tasks: Task[]
  sort: TableSort | null
}

function GroupTable({ group, label, tasks, sort, now, isTaskOffFocus, onToggleOffFocus, onOpenDetail, creaturePlacement }: GroupTableProps) {
  const columns = TABLE_COLUMNS[group]
  const sorted = sortTableRows(tasks, sort)

  return (
    <div className="active-table-scroll" data-testid="active-table-scroll">
      <div
        role="table"
        className="active-table"
        data-testid={`active-table-${group}`}
        aria-label={label}
        aria-rowcount={sorted.length + 1}
        style={{
          minWidth: tableMinWidthPx(group, columns),
          ['--table-columns' as string]: gridTemplate(columns),
          ['--table-col-gap' as string]: `${TABLE_COL_GAP_PX}px`,
          ['--table-pad-x' as string]: `${TABLE_PAD_X_PX}px`,
        }}
      >
        <div role="row" className="table-header-row" data-testid="table-header-row" aria-rowindex={1}>
          {columns.map((column) => <HeaderCell key={column.key} column={column} sort={sort} />)}
        </div>
        <div role="rowgroup" className="table-body">
          {sorted.map((task, index) => (
            <TableRow
              key={task.slug}
              task={task}
              group={group}
              columns={columns}
              index={index}
              now={now}
              isOffFocus={isTaskOffFocus(task.slug)}
              onToggleOffFocus={onToggleOffFocus}
              onOpenDetail={onOpenDetail}
              creaturePlacement={creaturePlacement}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

export function ActiveTable({ tasks, ...rest }: ActiveTableProps) {
  const sort = useTableSort()
  if (tasks.length === 0) return <EmptyState />
  return (
    <div className="active-tables" data-testid="active-tables">
      {groupActiveTasks(tasks).map(({ definition, tasks: groupTasks }: ActiveGroup) => (
        <div className="active-group" data-testid={definition.testId} key={definition.testId}>
          <ActiveGroupHeader label={definition.label} count={groupTasks.length} />
          <GroupTable group={definition.key} label={definition.label} tasks={groupTasks} sort={sort} {...rest} />
        </div>
      ))}
    </div>
  )
}
