import type { MilestoneStatus, PipelineKind, PrMergeState, Stage, StageEvent, Task } from './types.js'

// Pure next-stage derivations, split out of taskParser.ts so the React client
// (web/) can import them without dragging in that module's node:fs/execa
// imports. taskParser.ts re-exports everything here, so server-side callers
// and tests are unchanged.

// Deliberately keyed off waitingReason, not task.stage — see tech-design.md's
// "Why waitingReason, not task.stage". task.stage (computeStage in taskParser.ts) reads
// TIMELINE's last entry, which a stage only appends once it hands back to the
// human — so a task mid-stage, waiting on an unrelated clarifying question,
// would misreport its stage as "just finished the previous one" and offer a
// CTA that double-dispatches an already-running session. Each STATUS phrase
// below is unique and written in the same breath as the handoff itself, so
// matching on it side-steps that staleness entirely.
//
// Shared with the React client under web/, which imports this module directly
// instead of keeping its own copy — so the dashboard's "live" CTA and the
// server's computed stage can never drift apart.
export const NEXT_STAGE_BY_WAITING_REASON: { marker: string; stage: Stage }[] = [
  { marker: 'plan ready for review', stage: 'plan-review' },
  { marker: 'plan reviewed, ready for dev', stage: 'dev' },
  { marker: 'PR open, ready for CR', stage: 'code-review' },
  { marker: 'triage and dispatch cr-fixes', stage: 'comment-fix' },
  { marker: 'CR approved, ready for QA', stage: 'qa' },
  { marker: 'comments addressed, ready for QA', stage: 'qa' },
  { marker: 'triage and dispatch qa-fixes', stage: 'qa-fixes' },
  { marker: 'fixes pushed, ready to re-run QA', stage: 'qa' },
  // "QA passed, ready to merge" deliberately has no entry — merge has a
  // skill (pipelinely-merge) but no staged CTA and no waiting-reason marker:
  // it stays a decision-waiting state, not a pipeline handoff, on purpose
  // (see STAGE_SKILL in taskParser.ts and pipelinely-merge-skill's tech-design.md,
  // decision 2 and "The human gate is preserved").
]

export interface NextStageCta {
  stage: Stage
}

// The marker pipelinely-cr writes for ANY approved verdict, comments or not — so
// the marker alone can't say whether QA is really next; see matchWaitingReason.
export const CR_APPROVED_MARKER = 'CR approved, ready for QA'

// What the CTA/auto-mode decision needs from a task: its STATUS plus the
// review's parsed comments. Both review fields are optional because most
// callers (and every task without a review) have none — absent reads as "no
// comments". A full Task satisfies it, which is how the React callers pass it.
export type NextStageInput = Pick<Task, 'status' | 'waitingReason'> & {
  findings?: readonly unknown[]
  findingsParseMismatch?: readonly string[]
  // Set (to the reason) only when QA is not applicable to this task; see
  // assessQaNeed. Absent/null reads as "QA is needed", the safe default.
  qaSkipReason?: string | null
  // The open PR's merge state (Task.prMergeState); absent reads as "no PR".
  prMergeState?: PrMergeState
  // TIMELINE's stage — only read to recognise a task already at merge.
  stage?: Stage | null
  // Absent reads as a dev task, exactly like a task with no KIND file.
  kind?: PipelineKind
}

// Whether a review lists any comment. A non-empty parse mismatch (a header
// declares comments whose bullets did not parse) counts as having comments:
// the gate must fail closed, because "could not read the review" is not
// evidence that it found nothing.
export function hasReviewComments(
  findings: readonly unknown[] | undefined,
  findingsParseMismatch: readonly string[] | undefined,
): boolean {
  return (findings?.length ?? 0) > 0 || (findingsParseMismatch?.length ?? 0) > 0
}

// The one predicate for "an approved review that still lists comments must not
// advance to QA": waiting on the CR-approved handoff AND the review has
// comments. Any comment (any severity, selected or not) counts — a developer
// who has deselected everything has still not decided, and skipping is what
// records that decision (SKIP_STAGE → "comments addressed, ready for QA").
// Shared by the CTA/auto-mode match below and by parseTask's no-TIMELINE stage
// fallback, so the stage rail and the CTA cannot disagree.
export function isApprovedReviewAwaitingCommentDecision(task: NextStageInput): boolean {
  return (
    task.status === 'waiting' &&
    !!task.waitingReason?.includes(CR_APPROVED_MARKER) &&
    hasReviewComments(task.findings, task.findingsParseMismatch)
  )
}

// The table entry a task's waitingReason matches, or null, before the
// QA-not-applicable gate below (matchWaitingReason applies that gate).
// Exported so computeAutoDispatch can read WHICH marker matched without
// running the search a second time — one search, one meaning.
//
// The CR-approved marker is redirected to comment-fix while comments await a
// decision, so a STATUS already on disk with the old wording behaves correctly
// without being rewritten.
export function matchTableEntry(task: NextStageInput): { marker: string; stage: Stage } | null {
  if (task.status !== 'waiting' || !task.waitingReason) return null
  const waitingReason = task.waitingReason
  const findIn = (table: readonly { marker: string; stage: Stage }[]) => table.find((m) => waitingReason.includes(m.marker))
  const match = (task.kind === 'ds' ? findIn(DS_HANDOFFS) : undefined) ?? findIn(NEXT_STAGE_BY_WAITING_REASON)
  if (match && isApprovedReviewAwaitingCommentDecision(task)) return { marker: match.marker, stage: 'comment-fix' }
  return match ?? null
}

// Waiting at a QA-entry marker for a task whose QA is not applicable. Shared
// by the CTA/auto-mode match below and by the board card's Merge gate, so the
// two cannot disagree about which tasks skip QA.
export function isQaNotApplicable(task: NextStageInput): boolean {
  return matchTableEntry(task)?.stage === 'qa' && !!task.qaSkipReason
}

// Whether the task's open PR conflicts with its base. 'unknown' (GitHub still
// computing, or the read failed) is deliberately not a conflict: it must never
// change what is offered. Gates that refuse regardless of STATUS (the board's
// Merge, the Merge tab) read this directly.
export function hasConflictingPr(task: Pick<NextStageInput, 'prMergeState'>): boolean {
  return task.prMergeState === 'conflicting'
}

// TIMELINE stages that sit off the main pipeline line: entered from wherever
// the task stood and handing back to it, so their lines record that something
// ran, never where the task now is (computeStage skips them, and the stage
// chain has no node for them).
export const OFF_CHAIN_STAGES: readonly Stage[] = ['merge-conflicts']

// The key auto mode would record for a conflicting task — never dispatched
// (decideNextAction makes it a needs-you), named for symmetry with the
// table's markers.
export const MERGE_CONFLICTS_MARKER = 'PR conflicts with its base'

// A conflicting PR comes before whatever would move it forward: a waiting
// hand-off to the next pipeline stage, or the merge hand-off. Only a task that
// is waiting at one of those — a working, done or shelved task, or one waiting
// on an unrelated question, has nothing to replace. A merged ds task waiting
// for adopt is not one of those: its PR is already in, so there is no
// conflict left to fix whatever a stale read says.
export function isBlockedByMergeConflicts(task: NextStageInput): boolean {
  if (!hasConflictingPr(task) || task.status !== 'waiting') return false
  const entry = matchTableEntry(task)
  return (entry !== null && entry.stage !== 'adopt') || isAtMergeHandoff(task)
}

// The stage a task's waiting reason hands off to. A conflicting PR hands off
// to the conflict fix first. A task whose QA is not applicable has no next
// stage: there is nothing to dispatch, and the card offers Merge instead
// (isCardMergeReady).
export function matchWaitingReason(task: NextStageInput): { marker: string; stage: Stage } | null {
  if (isBlockedByMergeConflicts(task)) return { marker: MERGE_CONFLICTS_MARKER, stage: 'merge-conflicts' }
  const entry = matchTableEntry(task)
  if (!isQaNotApplicable(task)) return entry
  // A ds task has no QA to skip past: design QA is still owed.
  return task.kind === 'ds' ? { marker: entry!.marker, stage: 'design-qa' } : null
}

// A card's "Run CR fixes" stages /pipelinely-cr-fixes with no selection of its
// own, so with nothing ticked the worker would just write "comments addressed"
// and silently drop every comment. Cards send the developer to the triage
// checklist instead — the same selected > 0 gate the Fix button there applies.
export function isCrFixSelectionMissing(
  task: { findings?: readonly { selected: boolean }[] },
  stage: Stage,
): boolean {
  return stage === 'comment-fix' && !(task.findings ?? []).some((f) => f.selected)
}

// Unchanged behavior and unchanged return SHAPE. The shape matters: existing
// assertions in taskParser.test.ts are toEqual({ stage: … }) deep equality
// checks that a new field would fail, and the client renders off the same
// { stage } — adding a `marker` field here would break both for no gain, since
// only the auto-mode key ever needs it.
export function computeNextStageCta(task: NextStageInput): NextStageCta | null {
  const match = matchWaitingReason(task)
  return match ? { stage: match.stage } : null
}

// A queued milestone has no dispatched Task of its own yet, so
// computeNextStageCta (which reads a Task's own waitingReason) can't answer
// "is this one ready to start". Plan review is a required gate before ANY
// milestone starts, including a root one with no needs: — a project can't
// reach Dev without it once. Mirrors the "ready" branch already inline in
// computeAttentionStatus (same file) — reuse the same reasoning rather than
// duplicating a second copy of it.
export function isMilestoneReadyForDev(
  m: Pick<MilestoneStatus, 'needs' | 'state'>,
  byId: ReadonlyMap<string, Pick<MilestoneStatus, 'state'>>,
  parentStageHistory: readonly StageEvent[],
): boolean {
  if (m.state !== 'queued') return false
  if (!parentStageHistory.some((e) => e.stage === 'plan-review')) return false
  return m.needs.every((id) => byId.get(id)?.state === 'done')
}

// Marker a research worker writes when its deliverable awaits the developer
// ("waiting: audit ready for developer review", "waiting: design ready for
// developer review", ...). Deliberately not in NEXT_STAGE_BY_WAITING_REASON:
// it hands off to the developer, not to a pipeline stage, so it must never
// become a stage CTA or an auto-mode dispatch.
export const READY_FOR_DEVELOPER_REVIEW_MARKER = 'ready for developer review'

export function isReadyForResultReview(task: Pick<Task, 'status' | 'waitingReason'>): boolean {
  return task.status === 'waiting' && !!task.waitingReason?.includes(READY_FOR_DEVELOPER_REVIEW_MARKER)
}

// The phrase every merge hand-off STATUS ends with ("QA passed, ready to merge", the QA-skipped reason below).
export const READY_TO_MERGE_MARKER = 'ready to merge'

// Whether a STATUS reason is the merge hand-off itself: the marker is the whole
// reason or its last clause ("QA passed, ready to merge"). A substring match
// would also read "not ready to merge: CR blocking" as a hand-off.
export function isReadyToMergeReason(reason: string | undefined): boolean {
  const trimmed = (reason ?? '').trim()
  return trimmed === READY_TO_MERGE_MARKER || trimmed.endsWith(`, ${READY_TO_MERGE_MARKER}`)
}

// Whether a task stands at the merge hand-off — the one question the board
// card's Merge, the conflict check and the Merge tab's gate all ask. A dev task
// is there at stage merge, with QA not applicable, or waiting on a
// ready-to-merge reason. A ds task is there only on the designer's approval:
// its stage reads merge after a merge too (while it waits for adopt, which must
// not offer Merge again), and a skipped or passed QA still owes design QA.
export function isAtMergeHandoff(task: NextStageInput): boolean {
  if (task.kind === 'ds') return task.status === 'waiting' && (task.waitingReason ?? '').trim().endsWith(DESIGN_APPROVED_MARKER)
  return task.stage === 'merge' || isQaNotApplicable(task) || (task.status === 'waiting' && isReadyToMergeReason(task.waitingReason))
}

// STATUS phrase and TIMELINE note a skipped QA leaves behind. The status is
// the same "ready to merge" hand-off a passing QA writes, reworded so the
// developer can tell the two apart; the note's prefix is what computeStage
// reads to put the task at merge instead of at a QA that never ran.
export const QA_SKIPPED_STATUS_REASON = `no QA needed, ${READY_TO_MERGE_MARKER}`
export const QA_SKIPPED_NOTE_PREFIX = 'skipped'

const QA_PASSED_MARKER = 'QA passed, ready to merge'
const DESIGN_QA_DONE_MARKER = 'ready for design approval'
export const DESIGN_CHANGES_REQUESTED_MARKER = 'triage and dispatch design-fixes'
const DESIGN_FIXES_PUSHED_MARKER = 'design fixes pushed, ready to re-run design QA'
// The designer's approval, written by POST /design-approval. For a ds task
// this (and only this) is the merge hand-off; see isAtMergeHandoff.
export const DESIGN_APPROVED_MARKER = 'design approved, ready to merge'

// What a merged ds task waits on: mergeTask writes it as the STATUS reason
// instead of done, and the adopt row below routes it.
export const MERGED_FOR_ADOPT_MARKER = 'merged, ready for adopt'

// The ds pipeline's own hand-offs, consulted before the shared table for a
// ds task (see matchTableEntry). The two QA rows re-map markers the unchanged
// pipelinely-qa skill writes, so design QA follows QA without teaching that skill
// about kinds — the server is the one place that knows the ds order.
export const DS_HANDOFFS: { marker: string; stage: Stage }[] = [
  { marker: QA_PASSED_MARKER, stage: 'design-qa' },
  { marker: QA_SKIPPED_STATUS_REASON, stage: 'design-qa' },
  { marker: DESIGN_QA_DONE_MARKER, stage: 'design-approval' },
  { marker: DESIGN_CHANGES_REQUESTED_MARKER, stage: 'design-fixes' },
  { marker: DESIGN_FIXES_PUSHED_MARKER, stage: 'design-qa' },
  { marker: MERGED_FOR_ADOPT_MARKER, stage: 'adopt' },
]

// Stages whose next step is a person's decision, not a skill: they match a
// hand-off (so the stepper, default tab and auto mode all land on them) but
// have no STAGE_SKILL entry, so a card must open the task instead of staging a
// command that /stage-skill would refuse.
export const HUMAN_GATE_STAGES: readonly Stage[] = ['design-approval']

// What QA would actually run: an e2e/Playwright command in VERIFY, or a spec
// file in the PR's diff. Unit tests and typechecks are not QA's job — dev
// already ran them.
const E2E_VERIFY_RE = /playwright|e2e/i
// VERIFY may also be a URL, "manual QA only", "n/a"... (see orchestrator-prompt.md) —
// free text a denylist can never enumerate, so instead only a first line that
// starts with a known test runner counts as a command QA can skip past.
const RUNNABLE_VERIFY_COMMAND_RE = /^(npm|npx|pnpm|yarn|vitest|jest|tsc|pytest|cargo|make|bash|node|go\s+test)(\s|$)/i
const E2E_SPEC_PATH_RE = /(^|\/)e2e\/|\.spec\.[cm]?[jt]sx?$/

export interface QaNeedInput {
  verifier: string | null
  // null = the PR's diff could not be read, which is not the same as "no files".
  changedFiles: readonly string[] | null
}

export interface QaAssessment {
  needsQa: boolean
  reason: string
}

// The one decision of whether a task has anything for QA to run. Fails closed:
// when VERIFY or the diff is unknown it says QA is needed, because skipping a
// stage on a guess would silently drop the only independent test pass.
export function assessQaNeed({ verifier, changedFiles }: QaNeedInput): QaAssessment {
  if (verifier && E2E_VERIFY_RE.test(verifier)) return { needsQa: true, reason: 'VERIFY names an e2e command' }
  const changedSpec = changedFiles?.find((file) => E2E_SPEC_PATH_RE.test(file))
  if (changedSpec) return { needsQa: true, reason: `the PR changes an e2e spec (${changedSpec})` }
  if (!verifier) return { needsQa: true, reason: 'no VERIFY file to judge from' }
  if (!RUNNABLE_VERIFY_COMMAND_RE.test(verifier)) return { needsQa: true, reason: 'VERIFY is not a test command' }
  if (!changedFiles) return { needsQa: true, reason: 'the PR diff could not be read' }
  return { needsQa: false, reason: 'no e2e command in VERIFY and the PR changes no e2e spec' }
}
