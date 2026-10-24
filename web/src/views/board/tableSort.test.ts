import { describe, expect, test } from 'vitest'
import { nextTableSort, sortTableRows, type TableSort } from './tableSort'
import { makeTask } from './testTask'

describe('nextTableSort', () => {
  test('cycles none → asc → desc → none on the same key', () => {
    const asc = nextTableSort(null, 'task')
    expect(asc).toEqual({ key: 'task', direction: 'asc' })
    const desc = nextTableSort(asc, 'task')
    expect(desc).toEqual({ key: 'task', direction: 'desc' })
    expect(nextTableSort(desc, 'task')).toBeNull()
  })

  test('a different key starts ascending', () => {
    expect(nextTableSort({ key: 'task', direction: 'desc' }, 'ctx')).toEqual({ key: 'ctx', direction: 'asc' })
  })
})

describe('sortTableRows', () => {
  const slugs = (sort: TableSort | null, tasks = rows) => sortTableRows(tasks, sort).map((t) => t.slug)
  const rows = [
    makeTask({ slug: 'b', title: 'Beta', repo: 'web', contextPct: 50, stage: 'qa' }),
    makeTask({ slug: 'a', title: 'alpha', repo: 'api', contextPct: 9, stage: 'planning' }),
    makeTask({ slug: 'c', title: 'Gamma', repo: 'cli', contextPct: undefined, stage: 'dev' }),
  ]

  test('no sort keeps the original order and does not mutate', () => {
    const input = [...rows]
    expect(slugs(null)).toEqual(['b', 'a', 'c'])
    expect(input).toEqual(rows)
  })

  test('task sorts by lower-cased title', () => {
    expect(slugs({ key: 'task', direction: 'asc' })).toEqual(['a', 'b', 'c'])
    expect(slugs({ key: 'task', direction: 'desc' })).toEqual(['c', 'b', 'a'])
  })

  test('project sorts by repo', () => {
    expect(slugs({ key: 'project', direction: 'asc' })).toEqual(['a', 'c', 'b'])
  })

  test('stage sorts in pipeline order, not alphabetically', () => {
    expect(slugs({ key: 'stage', direction: 'asc' })).toEqual(['a', 'c', 'b'])
  })

  test('ctx sorts numerically with a missing value last in both directions', () => {
    expect(slugs({ key: 'ctx', direction: 'asc' })).toEqual(['a', 'b', 'c'])
    expect(slugs({ key: 'ctx', direction: 'desc' })).toEqual(['b', 'a', 'c'])
  })

  test('state sorts by its text', () => {
    const withReasons = [
      makeTask({ slug: 'x', status: 'waiting', attentionStatus: 'needs-you', waitingReason: 'Zeta. later' }),
      makeTask({ slug: 'y', status: 'waiting', attentionStatus: 'needs-you', waitingReason: 'Alpha. later' }),
    ]
    expect(slugs({ key: 'state', direction: 'asc' }, withReasons)).toEqual(['y', 'x'])
  })

  test('a Working row sorts by the "Agent is running <stage>" text it shows', () => {
    const working = [
      makeTask({ slug: 'qa', status: 'working', attentionStatus: 'working', stage: 'qa' }),
      makeTask({ slug: 'dev', status: 'working', attentionStatus: 'working', stage: 'dev' }),
    ]
    expect(slugs({ key: 'state', direction: 'asc' }, working)).toEqual(['dev', 'qa'])
    expect(slugs({ key: 'state', direction: 'desc' }, working)).toEqual(['qa', 'dev'])
  })

  test('next sorts by the primary CTA label, with a working leaf (no CTA) last in both directions', () => {
    const tasks = [
      makeTask({ slug: 'leaf', status: 'working', attentionStatus: 'working', stage: 'dev' }),
      makeTask({ slug: 'start-dev', status: 'waiting', attentionStatus: 'needs-you', stage: 'plan-review', waitingReason: 'plan reviewed, ready for dev' }),
      makeTask({ slug: 'show-task', status: 'waiting', attentionStatus: 'needs-you', stage: 'dev', waitingReason: 'needs a human decision' }),
    ]
    const asc = slugs({ key: 'next', direction: 'asc' }, tasks)
    expect(asc[asc.length - 1]).toBe('leaf')
    const desc = slugs({ key: 'next', direction: 'desc' }, tasks)
    expect(desc[desc.length - 1]).toBe('leaf')
    // 'Show task' (no next step) < 'Start dev' alphabetically.
    expect(asc.slice(0, 2)).toEqual(['show-task', 'start-dev'])
    expect(desc.slice(0, 2)).toEqual(['start-dev', 'show-task'])
  })

  test('a task with no stage or no repo sorts last in both directions', () => {
    const tasks = [
      makeTask({ slug: 'none', stage: undefined as never, repo: '' }),
      makeTask({ slug: 'dev', stage: 'dev', repo: 'api' }),
      makeTask({ slug: 'qa', stage: 'qa', repo: 'web' }),
    ]
    for (const key of ['stage', 'project'] as const) {
      expect(slugs({ key, direction: 'asc' }, tasks).pop()).toBe('none')
      expect(slugs({ key, direction: 'desc' }, tasks).pop()).toBe('none')
    }
  })
})
