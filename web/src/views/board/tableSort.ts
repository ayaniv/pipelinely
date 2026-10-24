import type { Task } from '../../../../src/types'
import { MINI_RAIL_STAGES, cardCtaPair, cardStageView, primaryCtaLabel } from '../../stageView'
import { cardStageLabel, miniStageId } from '../../taskScope'

// The table's tri-state sort and the pure comparison behind it. The sort state
// itself is shared by both tables (see tableSortStore).

export type TableSortKey = 'task' | 'project' | 'stage' | 'state' | 'ctx' | 'next'
export type SortDirection = 'asc' | 'desc'

export interface TableSort {
  key: TableSortKey
  direction: SortDirection
}

// none → ascending → descending → none on one column; any other column starts
// ascending.
export function nextTableSort(sort: TableSort | null, key: TableSortKey): TableSort | null {
  if (!sort || sort.key !== key) return { key, direction: 'asc' }
  return sort.direction === 'asc' ? { key, direction: 'desc' } : null
}

// A Working row's State text. Shared by the cell and the sort, so the sort
// orders by what the user reads.
export function runningStateText(task: Task): string {
  const view = cardStageView(task)
  return `Agent is running ${cardStageLabel({ stage: view.stage ?? task.stage }) ?? 'a stage'}`
}

// What the State column shows for a row, as text.
export function rowStateText(task: Task): string {
  const view = cardStageView(task)
  if (view.attention === 'working') return runningStateText(task)
  if (view.summary) return `${view.summary.head} ${view.summary.rest}`.trim()
  return task.approvalPrompt?.summary ?? ''
}

function nextLabel(task: Task): string {
  const pair = cardCtaPair(task)
  return pair ? primaryCtaLabel(pair.primary) : ''
}

// Pipeline order of the task's own stage (the mini rail's five nodes, so the
// review-fix stages sort with their parent). A task with no stage has no rank.
function stageRank(task: Task): number | null {
  return task.stage ? MINI_RAIL_STAGES.indexOf(miniStageId(task.stage)) : null
}

type SortValue = string | number | null

const SORT_VALUE: Record<TableSortKey, (task: Task) => SortValue> = {
  task: (task) => task.title.toLowerCase(),
  project: (task) => task.repo || null,
  stage: stageRank,
  state: (task) => rowStateText(task).toLowerCase(),
  ctx: (task) => task.contextPct ?? null,
  // An empty label (a working leaf) sorts last, like a missing ctx.
  next: (task) => nextLabel(task).toLowerCase() || null,
}

// A missing value sorts last whichever way the column runs.
export function sortTableRows(tasks: Task[], sort: TableSort | null): Task[] {
  if (!sort) return tasks
  const valueOf = SORT_VALUE[sort.key]
  const sign = sort.direction === 'asc' ? 1 : -1
  return [...tasks].sort((a, b) => {
    const left = valueOf(a)
    const right = valueOf(b)
    if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1
    if (left === right) return 0
    return (left < right ? -1 : 1) * sign
  })
}
