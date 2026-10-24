import type { Task } from '../../src/types'
import { runWaveBatch, type WaveBatchDeps } from './api/waveBatch'
import { READ_ONLY_INSTANCE_TITLE } from './components/readOnly'
import { clientState as sharedClientState, type ClientState } from './data/clientState'
import { eligibleWaveMilestones, milestoneChildSlug } from './milestoneModel'
import { buildWaves } from './waveModel'

// The one rule behind a fan-out parent's wave buttons — the inner view's Run
// next wave (REQUEST-v4.md §4) and the Parent tasks row's Run wave N: waves run
// in order, so the target is the first wave that is not complete, and it
// starts only the milestones eligibleWaveMilestones says can start — never a
// second readiness rule. When that wave has nothing left to start, the button
// is blocked on it, naming what it is still waiting on.

export interface WaveBlocker {
  id: string
  label: string
}

export type NextWaveAction =
  | { kind: 'run'; wave: number; slugs: string[] }
  | { kind: 'blocked'; wave: number; waitingOn: WaveBlocker[] }
  | { kind: 'plan-not-reviewed'; wave: number }
  | { kind: 'all-merged' }

export function nextWaveAction(task: Pick<Task, 'slug' | 'milestones' | 'stageHistory'>): NextWaveAction {
  const milestones = task.milestones ?? []
  const target = buildWaves(milestones).find((wave) => wave.state !== 'complete')
  if (!target) return { kind: 'all-merged' }
  if (!task.stageHistory.some((event) => event.stage === 'plan-review')) return { kind: 'plan-not-reviewed', wave: target.wave }

  const eligible = eligibleWaveMilestones(milestones, target.wave, task.stageHistory)
  if (eligible.length) return { kind: 'run', wave: target.wave, slugs: eligible.map((milestone) => milestoneChildSlug(task.slug, milestone.id)) }

  const waitingOn = target.cards.filter((card) => card.status !== 'merged').map((card) => ({ id: card.id, label: card.label }))
  return { kind: 'blocked', wave: target.wave, waitingOn }
}

export function nextWaveTarget(action: NextWaveAction): number | undefined {
  return action.kind === 'all-merged' ? undefined : action.wave
}

export function waitingOnTitle(action: Extract<NextWaveAction, { kind: 'blocked' }>): string {
  return `Waiting on wave ${action.wave} · ${action.waitingOn.map((blocker) => `${blocker.id} ${blocker.label}`).join(', ')}`
}

export function nextWaveTitle(action: NextWaveAction, isCanonical: boolean): string {
  if (!isCanonical) return READ_ONLY_INSTANCE_TITLE
  switch (action.kind) {
    case 'run':
      return `Stages one command for wave ${action.wave}'s ${action.slugs.length} queued, unblocked milestone${action.slugs.length === 1 ? '' : 's'} — unsent, for you to review`
    case 'blocked':
      return waitingOnTitle(action)
    case 'plan-not-reviewed':
      return 'The plan has not been reviewed yet'
    case 'all-merged':
      return 'Every wave is merged'
  }
}

export interface NextWaveButtonState {
  isDisabled: boolean
  title: string
}

// Whether a wave button may fire, and what its tooltip says. A click that
// stages nothing (or is refused with a 403 that no board surface shows) is a
// silent failure, so every wave button is disabled in exactly these cases.
export function nextWaveButtonState(parentSlug: string, action: NextWaveAction, isCanonical: boolean, state: ClientState = sharedClientState): NextWaveButtonState {
  if (!isCanonical) return { isDisabled: true, title: READ_ONLY_INSTANCE_TITLE }
  if (action.kind === 'run' && state.isWaveRunning(parentSlug, action.wave)) return { isDisabled: true, title: `Staging wave ${action.wave}…` }
  return { isDisabled: action.kind !== 'run', title: nextWaveTitle(action, isCanonical) }
}

// Only a runnable wave does anything: a blocked, unreviewed or finished one is
// a no-op, so a click that slips past the disabled button cannot stage a wave
// out of order.
export async function runNextWave(task: Task, deps: WaveBatchDeps = {}): Promise<void> {
  const action = nextWaveAction(task)
  if (action.kind !== 'run') return
  await runWaveBatch(task, action.wave, deps)
}
