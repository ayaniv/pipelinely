import type { DoneDateGroup } from '../../../../src/types'
import { localDateKey } from '../../../../src/dateKey'

// The You tab's GitHub-style work-density calendar, as data.

export const DENSITY_WEEKS = 53
const DAYS_PER_WEEK = 7
const MAX_DENSITY_LEVEL = 4
const UNKNOWN_DATE_KEY = 'unknown'

// One real session count per calendar day, from every done task's own
// per-session startedAt — not the task's completedAt, so a task worked on
// across several days spreads its sessions across the days they actually
// ran. A session with no startedAt falls back to the date its own task's
// bucket resolved; the 'unknown' bucket has no real date to attribute
// anything to, so it is skipped rather than guessed.
export function sessionDensityByDay(doneGroups: DoneDateGroup[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const group of doneGroups) {
    if (group.dateKey === UNKNOWN_DATE_KEY) continue
    for (const task of group.tasks) {
      for (const session of task.sessions) {
        const key = session.startedAt ? localDateKey(new Date(session.startedAt)) : group.dateKey
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
  }
  return counts
}

// Scales a real count against the busiest real day in the window, so the top
// shade always means "as busy as this account's own history gets" rather than
// a fixed absolute count some accounts would never reach.
export function densityLevel(count: number, max: number): number {
  if (!count || !max) return 0
  return Math.max(1, Math.min(MAX_DENSITY_LEVEL, Math.ceil((count / max) * MAX_DENSITY_LEVEL)))
}

export interface DensityCell {
  key: string
  count: number
  level: number
  label: string
}

export interface MonthRun {
  label: string
  weeks: number
}

export interface DensityGrid {
  weeks: DensityCell[][]
  monthRuns: MonthRun[]
  total: number
}

export function buildDensityGrid(counts: Map<string, number>, now: Date): DensityGrid {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  // The last week is the current Sun–Sat week, so it starts (WEEKS - 1) full
  // weeks before this week's own Sunday.
  const start = new Date(today)
  start.setDate(start.getDate() - today.getDay() - (DENSITY_WEEKS - 1) * DAYS_PER_WEEK)

  const max = Math.max(0, ...counts.values())
  let total = 0
  const monthRuns: MonthRun[] = []
  const weeks: DensityCell[][] = []

  for (let week = 0; week < DENSITY_WEEKS; week++) {
    const cells: DensityCell[] = []
    for (let day = 0; day < DAYS_PER_WEEK; day++) {
      const date = new Date(start)
      date.setDate(date.getDate() + week * DAYS_PER_WEEK + day)
      const key = localDateKey(date)
      const count = counts.get(key) ?? 0
      total += count
      cells.push({ key, count, level: densityLevel(count, max), label: date.toDateString().slice(4) })
    }
    weeks.push(cells)

    const month = new Date(start)
    month.setDate(month.getDate() + week * DAYS_PER_WEEK)
    const label = month.toLocaleString('en-US', { month: 'short' })
    const lastRun = monthRuns[monthRuns.length - 1]
    if (lastRun && lastRun.label === label) lastRun.weeks++
    else monthRuns.push({ label, weeks: 1 })
  }

  return { weeks, monthRuns, total }
}
