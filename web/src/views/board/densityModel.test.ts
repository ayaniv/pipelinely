import { describe, expect, test } from 'vitest'
import type { DoneDateGroup } from '../../../../src/types'
import { DENSITY_WEEKS, buildDensityGrid, densityLevel, sessionDensityByDay } from './densityModel'
import { makeTask } from './testTask'

const group = (dateKey: string, sessionStarts: Array<string | null>): DoneDateGroup => ({
  dateKey,
  label: dateKey,
  tasks: [makeTask({ sessions: sessionStarts.map((startedAt) => ({ startedAt })) as never })],
})

describe('densityLevel', () => {
  test('is 0 for no sessions or an empty history, and scales against the busiest day otherwise', () => {
    expect(densityLevel(0, 8)).toBe(0)
    expect(densityLevel(3, 0)).toBe(0)
    expect(densityLevel(1, 8)).toBe(1)
    expect(densityLevel(4, 8)).toBe(2)
    expect(densityLevel(8, 8)).toBe(4)
  })

  test('a non-zero count never rounds down to the empty shade', () => {
    expect(densityLevel(1, 1000)).toBe(1)
  })
})

describe('sessionDensityByDay', () => {
  test('counts each session on the day it started, not the task\'s completion day', () => {
    const counts = sessionDensityByDay([group('2026-09-10', ['2026-09-08T09:00:00', '2026-09-08T15:00:00', '2026-09-09T09:00:00'])])
    expect(counts.get('2026-09-08')).toBe(2)
    expect(counts.get('2026-09-09')).toBe(1)
    expect(counts.has('2026-09-10')).toBe(false)
  })

  test('a session with no startedAt falls back to its task\'s own date bucket', () => {
    expect(sessionDensityByDay([group('2026-09-10', [null])]).get('2026-09-10')).toBe(1)
  })

  test('the unknown-date bucket has no real day to attribute to, so it is skipped', () => {
    expect(sessionDensityByDay([group('unknown', [null, null])]).size).toBe(0)
  })
})

describe('buildDensityGrid', () => {
  // A Thursday, so the current Sun–Sat week is partly in the future.
  const today = new Date(2026, 8, 24)

  test('is 53 weeks of 7 days, the last week being the current Sun–Sat week', () => {
    const { weeks } = buildDensityGrid(new Map(), today)

    expect(weeks).toHaveLength(DENSITY_WEEKS)
    expect(weeks.every((week) => week.length === 7)).toBe(true)
    expect(weeks[DENSITY_WEEKS - 1][0].key).toBe('2026-09-20')
    expect(weeks[DENSITY_WEEKS - 1][4].key).toBe('2026-09-24')
    expect(weeks[0][0].key).toBe('2025-09-21')
  })

  test('each cell carries its count, its level against the busiest day, and a readable date label', () => {
    const counts = new Map([['2026-09-24', 4], ['2026-09-23', 1]])

    const { weeks } = buildDensityGrid(counts, today)

    const busiest = weeks[DENSITY_WEEKS - 1][4]
    expect(busiest).toMatchObject({ count: 4, level: 4, label: 'Sep 24 2026' })
    expect(weeks[DENSITY_WEEKS - 1][3]).toMatchObject({ count: 1, level: 1 })
    expect(weeks[0][0]).toMatchObject({ count: 0, level: 0 })
  })

  test('the total counts only sessions inside the window, so a stale day cannot inflate it', () => {
    const counts = new Map([['2026-09-24', 2], ['2026-09-01', 3], ['2019-01-01', 50]])
    expect(buildDensityGrid(counts, today).total).toBe(5)
  })

  test('an empty history is a full grid with a zero total', () => {
    const grid = buildDensityGrid(new Map(), today)
    expect(grid.total).toBe(0)
    expect(grid.weeks.flat().every((cell) => cell.level === 0)).toBe(true)
  })

  test('month runs cover every week exactly once, in order', () => {
    const { monthRuns } = buildDensityGrid(new Map(), today)
    expect(monthRuns.reduce((sum, run) => sum + run.weeks, 0)).toBe(DENSITY_WEEKS)
    expect(monthRuns[0].label).toBe('Sep')
    expect(monthRuns[monthRuns.length - 1].label).toBe('Sep')
  })
})
