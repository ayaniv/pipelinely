import { describe, expect, test } from 'vitest'
import type { BacklogItem, DoneDateGroup } from '../../../../src/types'
import {
  activeTasksOf, countDoneTasks, groupActiveTasks, narrowByProject, projectOptions, pulseCounts, standupText, visibleBacklogRows,
  visibleDoneGroups, weekRangeLabel,
} from './boardModel'
import { makeTask } from './testTask'

const backlogItem = (project: string | null): BacklogItem =>
  ({ description: 'x', date: null, context: null, done: false, shelvedSlug: null, project }) as BacklogItem

describe('activeTasksOf', () => {
  test('drops done tasks and tasks that do not show on the board', () => {
    const tasks = [
      makeTask({ slug: 'a' }),
      makeTask({ slug: 'b', status: 'done' }),
      makeTask({ slug: 'c', showsOnBoard: false }),
    ]
    expect(activeTasksOf(tasks).map((t) => t.slug)).toEqual(['a'])
  })
})

describe('projectOptions', () => {
  test('is the sorted union of active repos, done repos and backlog projects, with blanks and duplicates dropped', () => {
    const doneGroups: DoneDateGroup[] = [{ dateKey: '2026-09-01', label: 'x', tasks: [makeTask({ repo: 'acme-api' }), makeTask({ repo: '' })] }]
    const options = projectOptions(
      [makeTask({ repo: 'cockpit-ai' }), makeTask({ repo: 'acme-api' })],
      doneGroups,
      [backlogItem('acme-clock'), backlogItem(null)],
    )
    expect(options).toEqual(['acme-api', 'acme-clock', 'cockpit-ai'])
  })
})

describe('groupActiveTasks', () => {
  test('splits into Needs-you and Working buckets, in that order, sorted by lifecycle status within each', () => {
    const groups = groupActiveTasks([
      makeTask({ slug: 'w1', status: 'working', attentionStatus: 'working' }),
      makeTask({ slug: 'n1', status: 'working', attentionStatus: 'needs-you' }),
      makeTask({ slug: 'n0', status: 'waiting', attentionStatus: 'needs-you' }),
    ])
    expect(groups.map((g) => g.definition.testId)).toEqual(['active-group-needs', 'active-group-working'])
    // waiting sorts ahead of working (STATUS_ORDER), so n0 leads its bucket
    expect(groups[0].tasks.map((t) => t.slug)).toEqual(['n0', 'n1'])
    expect(groups[1].tasks.map((t) => t.slug)).toEqual(['w1'])
  })

  test('omits a bucket with no tasks', () => {
    const groups = groupActiveTasks([makeTask({ attentionStatus: 'working' })])
    expect(groups.map((g) => g.definition.testId)).toEqual(['active-group-working'])
  })

  test('an orphaned task lands in Needs-you even when its attention status says working', () => {
    const groups = groupActiveTasks([makeTask({ orphaned: true, attentionStatus: 'working' })])
    expect(groups.map((g) => g.definition.testId)).toEqual(['active-group-needs'])
  })

  test('a paused or idle task is never silently dropped', () => {
    const groups = groupActiveTasks([makeTask({ slug: 'p', status: 'paused', attentionStatus: 'paused' }), makeTask({ slug: 'i', attentionStatus: 'idle' })])
    expect(groups.flatMap((g) => g.tasks.map((t) => t.slug)).sort()).toEqual(['i', 'p'])
  })

  test('returns no groups for no tasks', () => {
    expect(groupActiveTasks([])).toEqual([])
  })
})

describe('pulseCounts', () => {
  test('counts needs-you tasks and working-status tasks that are not needing you', () => {
    const counts = pulseCounts([
      makeTask({ status: 'working', attentionStatus: 'working' }),
      makeTask({ status: 'working', attentionStatus: 'idle' }),
      makeTask({ status: 'working', attentionStatus: 'needs-you' }),
      makeTask({ status: 'waiting', attentionStatus: 'needs-you' }),
      makeTask({ status: 'paused', attentionStatus: 'paused' }),
    ])
    expect(counts).toEqual({ needsYou: 2, working: 2 })
  })

  test('is zero for an empty board', () => {
    expect(pulseCounts([])).toEqual({ needsYou: 0, working: 0 })
  })
})

describe('weekRangeLabel', () => {
  test('spans the Sunday through Thursday of the week containing the date', () => {
    // 2026-09-23 is a Wednesday → Sun Sep 20 – Thu Sep 24
    const label = weekRangeLabel(new Date(2026, 8, 23), 'en-US')
    expect(label).toBe('Sep 20 – Sep 24')
  })

  test('a Sunday is the start of its own week', () => {
    expect(weekRangeLabel(new Date(2026, 8, 20), 'en-US')).toBe('Sep 20 – Sep 24')
  })

  test('crosses a month boundary cleanly', () => {
    expect(weekRangeLabel(new Date(2026, 9, 1), 'en-US')).toBe('Sep 27 – Oct 1')
  })
})

describe('narrowByProject', () => {
  const rows = [{ project: 'a' }, { project: 'b' }, { project: null }]
  const projectOf = (row: { project: string | null }) => row.project

  test('an empty selection means every project, including untagged ones', () => {
    expect(narrowByProject(rows, new Set(), projectOf)).toEqual(rows)
  })

  test('a selection keeps only rows in a selected project, and an untagged row never matches one', () => {
    expect(narrowByProject(rows, new Set(['a', 'b']), projectOf)).toEqual([{ project: 'a' }, { project: 'b' }])
    expect(narrowByProject(rows, new Set(['a']), projectOf)).toEqual([{ project: 'a' }])
  })
})

describe('visibleBacklogRows', () => {
  const items = [backlogItem('a'), backlogItem('b'), backlogItem('a')]

  test('keeps each row\'s position in the full list, since the server rewrites BACKLOG.md by that index', () => {
    expect(visibleBacklogRows(items, new Set(['a'])).map((row) => row.index)).toEqual([0, 2])
  })

  test('without a filter every row is visible at its own index', () => {
    expect(visibleBacklogRows(items, new Set()).map((row) => row.index)).toEqual([0, 1, 2])
  })
})

describe('visibleDoneGroups and countDoneTasks', () => {
  const groups: DoneDateGroup[] = [
    { dateKey: '2026-09-02', label: 'Today', tasks: [makeTask({ slug: 'a', repo: 'api' }), makeTask({ slug: 'b', repo: 'web' })] },
    { dateKey: '2026-09-01', label: 'Yesterday', tasks: [makeTask({ slug: 'c', repo: 'web' })] },
  ]

  test('narrows each group\'s tasks and drops a group left with none, rather than an empty header', () => {
    const visible = visibleDoneGroups(groups, new Set(['api']))

    expect(visible.map((group) => group.label)).toEqual(['Today'])
    expect(visible[0].tasks.map((task) => task.slug)).toEqual(['a'])
  })

  test('does not mutate the snapshot\'s groups', () => {
    visibleDoneGroups(groups, new Set(['api']))
    expect(groups[0].tasks).toHaveLength(2)
  })

  test('counts tasks across groups', () => {
    expect(countDoneTasks(groups)).toBe(3)
    expect(countDoneTasks([])).toBe(0)
  })
})

describe('standupText', () => {
  const todayGroup = (titles: string[]): DoneDateGroup => ({ dateKey: 'k', label: 'Today', tasks: titles.map((title) => makeTask({ title })) })

  test('is one bullet line per task finished today', () => {
    expect(standupText([todayGroup(['One', 'Two'])])).toBe('• One\n• Two')
  })

  test('is null when nothing finished today, so there is nothing to copy', () => {
    expect(standupText([])).toBeNull()
    expect(standupText([{ ...todayGroup(['x']), label: 'Yesterday' }])).toBeNull()
    expect(standupText([todayGroup([])])).toBeNull()
  })
})
