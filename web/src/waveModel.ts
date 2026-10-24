import type { MilestoneStatus, Stage } from '../../src/types'

// The one model of a fan-out parent's waves, drawn by the pipeline chart
// (Dev's wave dots, the rework loop) and the wave graph. Waves and milestone
// states come from computeMilestones (src/taskParser.ts); this only folds them
// into what the charts show, with no readiness rule of its own.

export type WaveCardStatus = 'merged' | 'review' | 'working' | 'queued'
export type WaveState = 'complete' | 'running' | 'locked'

export interface WaveCard {
  id: string
  status: WaveCardStatus
  label: string
  // The dispatched child's slug; null while the milestone is still queued.
  childSlug: string | null
  milestone: MilestoneStatus
}

export interface Wave {
  wave: number
  cards: WaveCard[]
  state: WaveState
  doneCount: number
}

type MilestoneProgress = Pick<MilestoneStatus, 'state' | 'task'>

// Which of the parent's four milestone-bearing stages a milestone is in.
// Queued milestones, and a dispatched one whose child has not loaded yet, are
// still in Dev; a merged one is in none.
export type MilestoneStage = 'dev' | 'cr' | 'qa' | 'merge'

const MILESTONE_STAGE_BY_CHILD_STAGE: Partial<Record<Stage, MilestoneStage>> = {
  'code-review': 'cr',
  'comment-fix': 'cr',
  qa: 'qa',
  'qa-fixes': 'qa',
  merge: 'merge',
  'merge-conflicts': 'merge',
}

export function milestoneStage(milestone: MilestoneProgress): MilestoneStage | null {
  if (milestone.state === 'done') return null
  if (milestone.state === 'queued' || !milestone.task?.stage) return 'dev'
  return MILESTONE_STAGE_BY_CHILD_STAGE[milestone.task.stage] ?? 'dev'
}

export function waveCardStatus(milestone: MilestoneProgress): WaveCardStatus {
  if (milestone.state === 'done') return 'merged'
  if (milestone.state === 'queued') return 'queued'
  // A dispatched milestone whose child has not loaded yet is working, not queued.
  return milestoneStage(milestone) === 'cr' ? 'review' : 'working'
}

const LABEL_BY_STAGE: Record<MilestoneStage, string> = { dev: 'working', cr: 'in review', qa: 'in QA', merge: 'ready to merge' }

export function waveCardLabel(milestone: MilestoneProgress): string {
  const status = waveCardStatus(milestone)
  if (status === 'merged' || status === 'queued') return status
  return LABEL_BY_STAGE[milestoneStage(milestone) ?? 'dev']
}

export function buildWaves(milestones: MilestoneStatus[]): Wave[] {
  const waveNumbers = [...new Set(milestones.map((milestone) => milestone.wave))].sort((a, b) => a - b)
  let isEarlierWaveIncomplete = false
  return waveNumbers.map((wave) => {
    const cards: WaveCard[] = milestones
      .filter((milestone) => milestone.wave === wave)
      .map((milestone) => ({
        id: milestone.id,
        status: waveCardStatus(milestone),
        label: waveCardLabel(milestone),
        childSlug: milestone.task?.slug ?? null,
        milestone,
      }))
    const doneCount = cards.filter((card) => card.status === 'merged').length
    const isComplete = doneCount === cards.length
    const state: WaveState = isComplete ? 'complete' : isEarlierWaveIncomplete ? 'locked' : 'running'
    if (!isComplete) isEarlierWaveIncomplete = true
    return { wave, cards, state, doneCount }
  })
}

export function reworkMilestoneIds(milestones: MilestoneStatus[]): string[] {
  return milestones.filter((milestone) => waveCardStatus(milestone) === 'review').map((milestone) => milestone.id)
}
