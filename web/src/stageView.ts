import type { Stage, Task } from '../../src/types'
import { computeNextStageCta, HUMAN_GATE_STAGES, isCrFixSelectionMissing, isReadyForResultReview, matchWaitingReason } from '../../src/nextStageCta'
import { CARD_CTA_LABEL, READ_RESULT_LABEL, SHOW_TASK_LABEL, TRIAGE_CR_COMMENTS_LABEL, isCardMergeReady } from './nextStage'
import { CARD_STATUS_META, cardStageLabel, isTaskWorking, isWorkingLeaf, pillStatusFor } from './taskScope'
import { STAGE_TO_CHAIN_ID, type ChainStageId } from './pipelineStages'

// The one model of "where is this task, in the v3 design's terms", shared by
// the board card, the table row and the inner task view. Nothing else maps a
// stage to a colour, an icon or a summary.

// The five pipeline stages the card's mini rail and the table's Stage sort
// order by, in pipeline order.
export const MINI_RAIL_STAGES = ['planning', 'dev', 'cr', 'qa', 'merge']

export type StageTone = 'plan' | 'dev' | 'cr' | 'qa' | 'merge'

// The design's `stageKey`: the five tones plus the two review-fix stages, which
// share their parent's tone but read differently (their callout icon).
export type StageKey = 'planning' | 'dev' | 'cr' | 'crfix' | 'qa' | 'qareview' | 'merge'

export type CardAttention = 'needs-you' | 'working' | 'done' | 'backlog'

export type SummaryIcon = 'check' | 'comment' | 'dot'

export interface StageSummary {
  head: string
  rest: string
}

export interface CardStageView {
  // The stage the card reads as being at — the next stage a waiting reason
  // hands off to, else merge when merge-ready, else task.stage. Null for a
  // done task.
  stage: Stage | null
  tone: StageTone
  stageKey: StageKey
  attention: CardAttention
  summary: StageSummary | null
  summaryIcon: SummaryIcon
}

export interface StageToneVars {
  c: string
  soft: string
  ink: string
}

// The only place that maps a tone to its CSS tokens (defined in app.css, one
// set per theme).
export const STAGE_TONE_VARS: Record<StageTone, StageToneVars> = {
  plan: { c: 'var(--planC)', soft: 'var(--planSoft)', ink: 'var(--planInk)' },
  dev: { c: 'var(--devC)', soft: 'var(--devSoft)', ink: 'var(--devInk)' },
  cr: { c: 'var(--crC)', soft: 'var(--crSoft)', ink: 'var(--crInk)' },
  qa: { c: 'var(--qaC)', soft: 'var(--qaSoft)', ink: 'var(--qaInk)' },
  merge: { c: 'var(--mergeC)', soft: 'var(--mergeSoft)', ink: 'var(--mergeInk)' },
}

const TONE_BY_STAGE_KEY: Record<StageKey, StageTone> = { planning: 'plan', dev: 'dev', cr: 'cr', crfix: 'cr', qa: 'qa', qareview: 'qa', merge: 'merge' }

const STAGE_KEY_BY_STAGE: Record<Stage, StageKey> = {
  planning: 'planning',
  'plan-review': 'planning',
  dev: 'dev',
  'code-review': 'cr',
  'comment-fix': 'crfix',
  qa: 'qa',
  'qa-fixes': 'qareview',
  merge: 'merge',
  // No palette tone of its own: a conflict fix is about getting the PR
  // mergeable, so it reads in the merge tone.
  'merge-conflicts': 'merge',
  // The ds pipeline's stages fold into the nearest dev tone: intake is
  // planning work, design QA/approval/fixes are QA work, adopt follows merge.
  'design-intake': 'planning',
  'design-qa': 'qa',
  'design-approval': 'qa',
  'design-fixes': 'qa',
  adopt: 'merge',
}

// The tone a pipeline stage is drawn in (the chart's nodes and edges).
export function stageToneOf(stage: Stage): StageTone {
  return TONE_BY_STAGE_KEY[STAGE_KEY_BY_STAGE[stage] ?? 'planning']
}

const SUMMARY_ICON_BY_KEY: Partial<Record<StageKey, SummaryIcon>> = { merge: 'check', crfix: 'comment', qareview: 'comment' }

// "Head. Rest of the text." — the first sentence leads, the rest follows.
// The period stays on the head. Null when there is nothing to say.
export function splitSummary(text: string | undefined): StageSummary | null {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return null
  const breakAt = trimmed.indexOf('. ')
  if (breakAt === -1) return { head: trimmed, rest: '' }
  return { head: trimmed.slice(0, breakAt + 1), rest: trimmed.slice(breakAt + 2).trim() }
}

function effectiveStage(task: Task): Stage | null {
  if (task.status === 'done') return null
  const nextStage = matchWaitingReason(task)?.stage
  if (nextStage) return nextStage
  return isCardMergeReady(task) ? 'merge' : task.stage
}

function attentionOf(task: Task): CardAttention {
  if (task.status === 'shelved') return 'backlog'
  const pill = pillStatusFor(task)
  if (pill === 'done') return 'done'
  return pill === 'needs-you' || pill === 'waiting' ? 'needs-you' : 'working'
}

export function cardStageView(task: Task): CardStageView {
  const stage = effectiveStage(task)
  const stageKey: StageKey = stage ? STAGE_KEY_BY_STAGE[stage] ?? 'planning' : task.status === 'done' ? 'merge' : 'planning'
  return {
    stage,
    tone: TONE_BY_STAGE_KEY[stageKey],
    stageKey,
    attention: attentionOf(task),
    summary: splitSummary(task.waitingReason || task.pausedReason),
    summaryIcon: SUMMARY_ICON_BY_KEY[stageKey] ?? 'dot',
  }
}

export type StagePillVariant = 'stage' | 'merged' | 'backlog'

export interface StagePillView {
  variant: StagePillVariant
  tone: StageTone
  label: string
  // CSS colour values (tokens), ready for an inline style.
  bg: string
  dot: string
  ink: string
  // The colour of a live pill's breathing halo: the status dot, not the stage tone.
  halo: string
  isLive: boolean
}

// The stage pill of the card and of the inner view's header: names the STAGE
// and carries attention by colour (the stage tone on a Needs-you task, the
// status palette otherwise). A done or shelved task never appears on a card,
// so those two variants are the inner view's own.
export function stagePillView(task: Task): StagePillView {
  const view = cardStageView(task)
  const statusKey = pillStatusFor(task)
  const meta = CARD_STATUS_META[statusKey] ?? CARD_STATUS_META.idle
  if (view.attention === 'backlog') return { variant: 'backlog', tone: view.tone, label: 'Backlog', bg: 'var(--surface2)', dot: 'var(--text3)', ink: 'var(--text2)', halo: 'var(--text3)', isLive: false }
  if (view.attention === 'done') return { variant: 'merged', tone: view.tone, label: 'Merged', bg: meta.bg, dot: meta.dot, ink: meta.fg, halo: meta.dot, isLive: false }
  const tone = view.attention === 'needs-you' ? STAGE_TONE_VARS[view.tone] : null
  return {
    variant: 'stage',
    tone: view.tone,
    label: cardStageLabel({ stage: view.stage }) ?? meta.label,
    bg: tone?.soft ?? meta.bg,
    dot: tone?.c ?? meta.dot,
    ink: tone?.ink ?? meta.fg,
    halo: meta.dot,
    isLive: isTaskWorking(task),
  }
}

export type CardPrimaryCta =
  | { kind: 'stage-skill'; stage: Stage }
  | { kind: 'triage-first' }
  | { kind: 'merge' }
  | { kind: 'open-result' }
  | { kind: 'open-detail' }

// `taskStage` is the task view's ?stage= tab id, NOT a pipeline Stage: they
// differ for CR fixes ('comment-fix' vs 'cr-fixes'), and an unknown ?stage=
// silently lands on the default tab.
export type CardSecondaryCta =
  | { kind: 'read-plan'; taskStage: ChainStageId }
  | { kind: 'triage-comments'; taskStage: ChainStageId }
  | { kind: 'open-pr' }

// The primary button's text, without the trailing arrow. One mapping for the
// card footer, the table's Next column and its sort.
export function primaryCtaLabel(cta: CardPrimaryCta): string {
  switch (cta.kind) {
    case 'stage-skill': return CARD_CTA_LABEL[cta.stage] ?? 'Continue'
    case 'merge': return 'Merge'
    case 'open-result': return READ_RESULT_LABEL
    case 'triage-first': return TRIAGE_CR_COMMENTS_LABEL
    case 'open-detail': return SHOW_TASK_LABEL
  }
}

export interface CardCtaPair {
  primary: CardPrimaryCta
  secondary: CardSecondaryCta | null
}

function secondaryForStage(stage: Stage): CardSecondaryCta | null {
  if (stage === 'dev') return { kind: 'read-plan', taskStage: 'planning' }
  if (stage === 'comment-fix' || stage === 'qa-fixes') return { kind: 'triage-comments', taskStage: STAGE_TO_CHAIN_ID[stage] }
  return null
}

// A task's next-step buttons in the order the checks apply, whatever its
// lifecycle status. The footer renders this directly (a milestone card shows
// its working child's CTA); the board's card and the table's Next column go
// through `cardCtaPair`, which withholds it from a working leaf.
export function nextStepCtaPair(task: Task): CardCtaPair {
  const cta = computeNextStageCta(task)
  const shouldTriageFirst = !!cta && isCrFixSelectionMissing(task, cta.stage)
  // A human gate matches a hand-off but has no skill to stage: open the task on its tab.
  if (cta && HUMAN_GATE_STAGES.includes(cta.stage)) return { primary: { kind: 'open-detail' }, secondary: null }
  if (cta && !shouldTriageFirst) return { primary: { kind: 'stage-skill', stage: cta.stage }, secondary: secondaryForStage(cta.stage) }
  if (isCardMergeReady(task)) return { primary: { kind: 'merge' }, secondary: { kind: 'open-pr' } }
  if (task.resultDoc && isReadyForResultReview(task)) return { primary: { kind: 'open-result' }, secondary: null }
  return { primary: { kind: shouldTriageFirst ? 'triage-first' : 'open-detail' }, secondary: null }
}

// Null for a working leaf: its session is running, so Start dev or Run CR
// fixes would dispatch a second one. Shared by the board card and the table.
export function cardCtaPair(task: Task): CardCtaPair | null {
  return isWorkingLeaf(task) ? null : nextStepCtaPair(task)
}
