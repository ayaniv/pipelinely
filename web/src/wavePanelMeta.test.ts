import { describe, expect, test } from 'vitest'
import type { StageEvent } from '../../src/types'
import { makeMilestone, makeTask } from './testing/makeTask'
import { wavePanelMeta } from './wavePanelMeta'

const startedAt = (at: string): StageEvent[] => [{ stage: 'dev', at, note: null }]
const merged = (id: string, wave: number) => makeMilestone({ id, wave, state: 'done', task: makeTask({ slug: `p-${id.toLowerCase()}`, stage: null, status: 'done' }) })
const working = (id: string, wave: number, stageHistory: StageEvent[]) => makeMilestone({ id, wave, state: 'dispatched', task: makeTask({ slug: `p-${id.toLowerCase()}`, stageHistory }) })

describe('wavePanelMeta', () => {
  test('names the running wave, the merged count and when the wave started', () => {
    const meta = wavePanelMeta({ milestones: [merged('M0', 1), working('M1', 2, startedAt('2026-08-10T08:40:00Z')), makeMilestone({ id: 'M2', wave: 3 }), makeMilestone({ id: 'M3', wave: 3 })] })
    expect(meta).toMatch(/^wave 2 of 3 · 1 of 4 merged · started \d\d:\d\d$/)
  })

  test('the start time is the earliest across the running wave', () => {
    const startOf = (meta: string) => meta.split(' · ').at(-1)
    const early = wavePanelMeta({ milestones: [working('M0', 1, startedAt('2026-08-10T08:00:00Z'))] })
    const both = wavePanelMeta({ milestones: [working('M0', 1, startedAt('2026-08-10T08:00:00Z')), working('M1', 1, startedAt('2026-08-10T09:30:00Z'))] })
    expect(startOf(both)).toBe(startOf(early))
  })

  test('with nothing dispatched yet there is no start time to claim', () => {
    expect(wavePanelMeta({ milestones: [makeMilestone({ id: 'M0', wave: 1 })] })).toBe('wave 1 of 1 · 0 of 1 merged')
  })

  test('an unparseable timeline entry is ignored, not shown as an invalid time', () => {
    expect(wavePanelMeta({ milestones: [working('M0', 1, startedAt('not-a-date'))] })).toBe('wave 1 of 1 · 0 of 1 merged')
  })

  test('every wave merged', () => {
    expect(wavePanelMeta({ milestones: [merged('M0', 1), merged('M1', 2)] })).toBe('2 waves · 2 of 2 merged')
  })
})
