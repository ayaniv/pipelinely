import type { BacklogItem, DoneDateGroup, Task } from '../../../../src/types'
import { pillStatusFor, type PillStatusKey } from '../../taskScope'

// activeTasksOf (the one "non-done, on-board task" predicate) lives in
// taskScope.ts — shared with the header's spend pill.
export { activeTasksOf } from '../../taskScope'

// The active board's pure derivations (project options, sorting, the active
// groups, the pulse-chip totals). Kept free of React so each rule is unit-testable on its own.

// Options describe what is on the board right now, never a fixed enum: the
// repos of the active tasks, the done tasks and the backlog rows — exactly
// the rows the filter can act on. Offering a repo with no visible row would
// be a filter that can only empty the board.
export function projectOptions(activeTasks: Task[], doneGroups: DoneDateGroup[], backlog: BacklogItem[]): string[] {
  const projects = new Set<string>()
  for (const task of activeTasks) if (task.repo) projects.add(task.repo)
  for (const group of doneGroups) for (const task of group.tasks) if (task.repo) projects.add(task.repo)
  for (const item of backlog) if (item.project) projects.add(item.project)
  return [...projects].sort()
}

const STATUS_ORDER: Record<string, number> = { waiting: 0, paused: 1, review: 2, working: 3, handover: 4, done: 5 }
const UNKNOWN_STATUS_RANK = 9

function sortByLifecycleStatus(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => (STATUS_ORDER[a.status] ?? UNKNOWN_STATUS_RANK) - (STATUS_ORDER[b.status] ?? UNKNOWN_STATUS_RANK))
}

export interface ActiveGroupDefinition {
  label: string
  testId: string
  art: string
  includes: (key: PillStatusKey) => boolean
}

// The design's own two-bucket split — keyed off pillStatusFor (the same
// grouping the status pill and the card's bright/muted background already
// use), not a hardcoded status match, so a paused/idle/orphaned task still
// lands in a bucket rather than being silently dropped.
export const ACTIVE_GROUPS: ActiveGroupDefinition[] = [
  { label: 'Needs you', testId: 'active-group-needs', art: 'head-beige-v3.png', includes: (key) => key === 'needs-you' || key === 'waiting' },
  { label: 'Working', testId: 'active-group-working', art: 'head-blue-v3.png', includes: (key) => key !== 'needs-you' && key !== 'waiting' },
]

export interface ActiveGroup {
  definition: ActiveGroupDefinition
  tasks: Task[]
}

// Empty buckets are omitted, not rendered as empty headers.
export function groupActiveTasks(tasks: Task[]): ActiveGroup[] {
  const sorted = sortByLifecycleStatus(tasks)
  return ACTIVE_GROUPS.map((definition) => ({
    definition,
    tasks: sorted.filter((task) => definition.includes(pillStatusFor(task))),
  })).filter((group) => group.tasks.length > 0)
}

export interface PulseCounts {
  needsYou: number
  working: number
}

// attentionStatus's own 'working' branch only fires once the iTerm2 liveness
// check confirms the session — when that check fails or times out it
// degrades to 'idle' even for a task whose STATUS says "working". STATUS is
// the authoritative lifecycle signal for "how many tasks are working", so
// count it directly rather than trusting a liveness check that can fail
// independently. A task with a genuine current CR/QA item stays under
// needs-you instead (same precedence attentionStatus already gives it).
export function pulseCounts(activeTasks: Task[]): PulseCounts {
  return {
    needsYou: activeTasks.filter((task) => task.attentionStatus === 'needs-you').length,
    working: activeTasks.filter((task) => task.status === 'working' && task.attentionStatus !== 'needs-you').length,
  }
}

// Sunday–Thursday work week, matching this team's convention (not Mon–Fri).
const WEEK_LENGTH_DAYS_AFTER_SUNDAY = 4

export function weekRangeLabel(now: Date, locale?: string): string {
  const sunday = new Date(now)
  sunday.setDate(now.getDate() - now.getDay())
  const thursday = new Date(sunday)
  thursday.setDate(sunday.getDate() + WEEK_LENGTH_DAYS_AFTER_SUNDAY)
  const format = (date: Date) => date.toLocaleDateString(locale ?? [], { month: 'short', day: 'numeric' })
  return `${format(sunday)} – ${format(thursday)}`
}

// The one project-filter rule, shared by every row the filter acts on —
// tasks, backlog items and done tasks differ only in which field carries the
// project. An empty selection means every project; an untagged row (null)
// never matches a non-empty one.
export function narrowByProject<Row>(rows: Row[], selected: ReadonlySet<string>, projectOf: (row: Row) => string | null): Row[] {
  if (selected.size === 0) return rows
  return rows.filter((row) => {
    const project = projectOf(row)
    return project !== null && selected.has(project)
  })
}

export interface BacklogRowModel {
  item: BacklogItem
  // The item's position in the UNFILTERED backlog — the server rewrites
  // BACKLOG.md by this index (/backlog/edit|dismiss|resume/:index), so
  // filtering must hide rows without renumbering them.
  index: number
}

export function visibleBacklogRows(backlog: BacklogItem[], selected: ReadonlySet<string>): BacklogRowModel[] {
  const rows = backlog.map((item, index) => ({ item, index }))
  return narrowByProject(rows, selected, (row) => row.item.project)
}

// A date header with no rows under it would be a worse answer than no
// header, so a group that drops to zero tasks under the filter is dropped.
export function visibleDoneGroups(groups: DoneDateGroup[], selected: ReadonlySet<string>): DoneDateGroup[] {
  return groups
    .map((group) => ({ ...group, tasks: narrowByProject(group.tasks, selected, (task) => task.repo) }))
    .filter((group) => group.tasks.length > 0)
}

export function countDoneTasks(groups: DoneDateGroup[]): number {
  return groups.reduce((sum, group) => sum + group.tasks.length, 0)
}

const TODAY_GROUP_LABEL = 'Today'

// What "copy standup" puts on the clipboard: only today's group is relevant
// to a standup update. Null when there is nothing to copy.
export function standupText(groups: DoneDateGroup[]): string | null {
  const today = groups.find((group) => group.label === TODAY_GROUP_LABEL)
  if (!today || today.tasks.length === 0) return null
  return today.tasks.map((task) => `• ${task.title}`).join('\n')
}
