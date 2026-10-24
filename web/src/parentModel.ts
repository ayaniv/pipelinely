import type { MilestoneStatus, Task, TaskCreature } from '../../src/types'
import { waitingOnTitle, type NextWaveAction } from './nextWave'

// The pure derivations behind the Active tab's Parent tasks section: a
// parent's milestones as three-state icons grouped by wave, its progress, and
// which wave button (if any) it offers. Nothing here is stored — the progress
// count and the button are re-derived on every render.

export type MilestoneState = 'done' | 'working' | 'idle'

export interface ParentMilestone {
  id: string
  title: string
  state: MilestoneState
}

export interface ParentWave {
  wave: number
  milestones: ParentMilestone[]
}

export interface ParentView {
  slug: string
  title: string
  project: string
  creature: TaskCreature | null
  waves: ParentWave[]
}

// merged -> done; a dispatched child -> working, whichever of running, in
// review, waiting or paused it is (the design draws exactly three states, and
// anything dispatched-but-unmerged is in the pipeline); queued -> idle.
const MILESTONE_STATE_BY_STATUS = { done: 'done', dispatched: 'working', queued: 'idle' } as const satisfies Record<MilestoneStatus['state'], MilestoneState>

export function milestoneStateOf(milestone: Pick<MilestoneStatus, 'state'>): MilestoneState {
  return MILESTONE_STATE_BY_STATUS[milestone.state]
}

export function toParentView(task: Task): ParentView {
  const byWave = new Map<number, ParentMilestone[]>()
  for (const milestone of task.milestones ?? []) {
    const inWave = byWave.get(milestone.wave) ?? []
    inWave.push({ id: milestone.id, title: milestone.name, state: milestoneStateOf(milestone) })
    byWave.set(milestone.wave, inWave)
  }
  const waves = [...byWave].sort(([a], [b]) => a - b).map(([wave, milestones]) => ({ wave, milestones }))
  return { slug: task.slug, title: task.title, project: task.repo, creature: task.creature, waves }
}

export function parentProgress(waves: ParentWave[]): { done: number; total: number } {
  const milestones = waves.flatMap((wave) => wave.milestones)
  return { done: milestones.filter((milestone) => milestone.state === 'done').length, total: milestones.length }
}

export type WaveButton =
  | { kind: 'none' }
  | { kind: 'run'; wave: number }
  | { kind: 'locked'; wave: number; tooltip: string }

// Which wave runs next is nextWaveAction's call, the same one the inner view's
// Run next wave makes; this only decides how the row draws it. A blocked wave
// locks the button on the next wave that still has a queued milestone, and
// with nothing queued anywhere there is nothing to offer.
export function waveButtonFor(action: NextWaveAction, milestones: MilestoneStatus[]): WaveButton {
  switch (action.kind) {
    case 'all-merged':
      return { kind: 'none' }
    case 'run':
    case 'plan-not-reviewed':
      return { kind: 'run', wave: action.wave }
    case 'blocked': {
      const queuedWaves = milestones.filter((milestone) => milestone.state === 'queued' && milestone.wave >= action.wave).map((milestone) => milestone.wave)
      return queuedWaves.length ? { kind: 'locked', wave: Math.min(...queuedWaves), tooltip: waitingOnTitle(action) } : { kind: 'none' }
    }
  }
}
