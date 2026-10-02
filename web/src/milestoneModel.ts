import type { MilestoneStatus, StageEvent, Task } from '../../src/types'
import { isMilestoneReadyForDev } from '../../src/nextStageCta'
import type { StatusMeta } from './taskScope'

// The pure derivations behind a fan-out parent's Dev tab: a milestone's
// child slug, its status tone and est-vs-actual line, and which milestones of
// a wave a batch dispatch would actually start.

export const MILESTONE_STATE_LABEL = { queued: 'Queued', dispatched: 'Dispatched', done: 'Merged' } as const satisfies Record<MilestoneStatus['state'], string>

// A dispatched milestone's child task dir is the parent's slug plus the
// lower-cased milestone id.
export function milestoneChildSlug(parentSlug: string, milestoneId: string): string {
  return `${parentSlug}-${milestoneId.toLowerCase()}`
}

// Each wave header states the rule the wave is under, so the grouping is
// legible without opening the plan. More than one milestone means they
// genuinely run side by side; a lone milestone waiting on two or more
// blockers is a convergence point; anything else is the next link in a chain.
export function waveRule(inWave: Pick<MilestoneStatus, 'needs'>[]): string {
  if (inWave.length > 1) return `parallel · ${inWave.length} tabs`
  const needs = inWave[0].needs.length
  return needs >= 2 ? `converges · waits for ${needs}` : 'sequential · alone'
}

// Which milestones of one wave a batch dispatch would actually start: queued
// AND unblocked, by the same isMilestoneReadyForDev gate each milestone
// card's own Start dev CTA applies — never a second copy of that rule.
export function eligibleWaveMilestones(milestones: MilestoneStatus[], wave: number, parentStageHistory: StageEvent[]): MilestoneStatus[] {
  const byId = new Map(milestones.map((m) => [m.id, m]))
  return milestones.filter((m) => m.wave === wave && isMilestoneReadyForDev(m, byId, parentStageHistory))
}

// The design's own dev-card status tone: queued (gray) vs. done (sage
// "merged") vs. anything dispatched in between (accent, labelled by the
// child's own real stage — dev/code review/qa/merge — rather than a generic
// "dispatched").
export function milestoneStatusMeta(milestone: Pick<MilestoneStatus, 'state' | 'task'>): StatusMeta {
  if (milestone.state === 'queued') return { label: 'queued', dot: 'var(--text3)', fg: 'var(--text2)', bg: 'var(--surface2)' }
  if (milestone.state === 'done') return { label: 'merged', dot: 'var(--sage)', fg: 'var(--sageInk)', bg: 'var(--sageSoft)' }
  const stage = milestone.task?.stage
  const label = stage === 'code-review' ? 'code review' : stage ? stage.replace(/-/g, ' ') : 'dev'
  return { label, dot: 'var(--accent)', fg: 'var(--accentInk)', bg: 'var(--accentSoft)' }
}

// est-vs-actual is the whole reason estimates are recorded before the work
// starts. "Actual" runs from the child's first TIMELINE entry to its resolved
// completion date. Either one missing means there is no honest number, so
// none is shown rather than a guess.
export function milestoneActual(child: Task | null): string | null {
  if (!child || !child.completedAt || !child.stageHistory.length) return null
  const start = new Date(child.stageHistory[0].at).getTime()
  const end = new Date(child.completedAt).getTime()
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null

  const minutes = Math.round((end - start) / 60000)
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (hours && remainder) return `${hours}h${remainder}m`
  if (hours) return `${hours}h`
  return `${remainder}m`
}
