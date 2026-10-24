import { describe, expect, test } from 'vitest'
import type { MilestoneStatus } from '../../src/types'
import { makeTask } from './views/board/testTask'
import { nextWaveAction } from './nextWave'
import { milestoneStateOf, parentProgress, toParentView, waveButtonFor, type MilestoneState, type ParentWave } from './parentModel'

function milestone(id: string, wave: number, state: MilestoneStatus['state'], overrides: Partial<MilestoneStatus> = {}): MilestoneStatus {
  return { id, name: `${id} name`, needs: [], estimate: null, specFile: null, wave, task: null, state, ...overrides }
}

function wave(number: number, ...states: MilestoneState[]): ParentWave {
  return { wave: number, milestones: states.map((state, index) => ({ id: `M${number * 10 + index}`, title: `title ${number}.${index}`, state })) }
}

describe('milestoneStateOf', () => {
  test('merged maps to done, a dispatched child (running or in review) to working, queued to idle', () => {
    expect(milestoneStateOf(milestone('M0', 1, 'done'))).toBe('done')
    expect(milestoneStateOf(milestone('M0', 1, 'dispatched'))).toBe('working')
    expect(milestoneStateOf(milestone('M0', 1, 'queued'))).toBe('idle')
  })

  test('a dispatched child that is waiting, paused or in review is still working, never idle', () => {
    for (const status of ['waiting', 'paused', 'review', 'working'] as const) {
      const child = makeTask({ slug: 'p-m0', status })
      expect(milestoneStateOf(milestone('M0', 1, 'dispatched', { task: child }))).toBe('working')
    }
  })
})

describe('toParentView', () => {
  test('groups milestones by wave in ascending wave order, keeping declared order inside a wave', () => {
    const parent = makeTask({
      slug: 'p', title: 'Parent', repo: 'cockpit-ai', creature: { name: 'Rosie', color: '#a8d8c9', shape: '50%' },
      milestones: [milestone('M2', 2, 'queued'), milestone('M0', 1, 'done'), milestone('M1', 1, 'dispatched')],
    })
    const view = toParentView(parent)
    expect(view.waves.map((w) => w.wave)).toEqual([1, 2])
    expect(view.waves[0].milestones.map((m) => `${m.id}:${m.state}`)).toEqual(['M0:done', 'M1:working'])
    expect(view.waves[1].milestones.map((m) => m.title)).toEqual(['M2 name'])
    expect(view.slug).toBe('p')
    expect(view.project).toBe('cockpit-ai')
    expect(view.creature?.name).toBe('Rosie')
  })

  test('a task with no milestones has no waves', () => {
    expect(toParentView(makeTask({ milestones: undefined })).waves).toEqual([])
  })
})

describe('parentProgress', () => {
  test('counts done milestones over all milestones across waves', () => {
    expect(parentProgress([wave(1, 'done', 'done'), wave(2, 'working', 'idle', 'done')])).toEqual({ done: 3, total: 5 })
  })

  test('no waves is 0 of 0', () => {
    expect(parentProgress([])).toEqual({ done: 0, total: 0 })
  })
})

describe('waveButtonFor', () => {
  const PLAN_REVIEWED = [{ stage: 'plan-review' as const, at: '2026-01-01T00:00:00Z', note: '' }]
  const buttonFor = (milestones: MilestoneStatus[], stageHistory = PLAN_REVIEWED) =>
    waveButtonFor(nextWaveAction(makeTask({ slug: 'p', milestones, stageHistory })), milestones)

  test('everything merged, or no milestones: no button', () => {
    expect(buttonFor([milestone('M1', 1, 'done'), milestone('M2', 2, 'done')])).toEqual({ kind: 'none' })
    expect(buttonFor([])).toEqual({ kind: 'none' })
  })

  test('nothing queued anywhere: no button', () => {
    expect(buttonFor([milestone('M1', 1, 'done'), milestone('M2', 2, 'dispatched')])).toEqual({ kind: 'none' })
  })

  test('all earlier waves merged: Run wave N for the first wave that is not', () => {
    expect(buttonFor([milestone('M1', 1, 'done'), milestone('M2', 2, 'queued'), milestone('M3', 3, 'queued')])).toEqual({ kind: 'run', wave: 2 })
  })

  test('a partly started wave runs its queued remainder, as the inner view\'s Run next wave does', () => {
    expect(buttonFor([milestone('M1', 1, 'done'), milestone('M2', 1, 'queued'), milestone('M3', 2, 'queued')])).toEqual({ kind: 'run', wave: 1 })
  })

  test('before plan review the target wave still shows, for the run state to disable', () => {
    expect(buttonFor([milestone('M1', 1, 'queued')], [])).toEqual({ kind: 'run', wave: 1 })
  })

  test('a fully started wave locks the next queued wave, with the shared "Waiting on wave N" tooltip', () => {
    const milestones = [milestone('M1', 1, 'dispatched'), milestone('M2', 1, 'done'), milestone('M4', 1, 'dispatched'), milestone('M5', 2, 'queued')]
    expect(buttonFor(milestones)).toEqual({ kind: 'locked', wave: 2, tooltip: 'Waiting on wave 1 · M1 working, M4 working' })
  })

  test('the lock skips a wave that is already fully started', () => {
    const milestones = [milestone('M1', 1, 'dispatched'), milestone('M2', 2, 'dispatched'), milestone('M3', 3, 'queued')]
    expect(buttonFor(milestones)).toEqual({ kind: 'locked', wave: 3, tooltip: 'Waiting on wave 1 · M1 working' })
  })
})
