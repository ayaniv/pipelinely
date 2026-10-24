import {
  isBlockedByMergeConflicts,
  isMilestoneReadyForDev,
  isQaNotApplicable,
  isReadyForResultReview,
  isReadyToMergeReason,
  matchTableEntry,
  type NextStageInput,
} from './nextStageCta.js'
import type { MilestoneStatus, QaStartPolicy, Settings, Stage, StageEvent } from './types.js'

// The one decision under auto mode, the /pipelinely-babysit CLI and the Push
// forward route: for a task's state, is the next step safe to run unattended,
// the developer's, or nothing? It adds no second copy of the stage table (the
// stage always comes from matchTableEntry); it only adds the gate on top. Pure
// and import-light so the web bundle can use it too — pinned by a test.

// Every stage the decision can dispatch is orchestrator-target in STAGE_SKILL;
// the own-session stages (comment-fix, qa-fixes) are always the developer's.
export type DispatchStage = 'plan-review' | 'dev' | 'code-review' | 'qa'

export type NeedsYouReason =
  | 'merge'
  | 'merge-conflicts'
  | 'review-comments'
  | 'qa-findings'
  | 'qa-consent'
  | 'qa-intent-brief'
  | 'review-intent-brief'
  | 'start-milestones'
  | 'result-review'
  | 'design-approval'
  | 'ds-stage'
  | 'question'

export type NextAction =
  | { kind: 'dispatch'; stage: DispatchStage; marker: string }
  | { kind: 'skip-qa'; marker: string; reason: string }
  | { kind: 'needs-you'; reason: NeedsYouReason }
  | { kind: 'idle' }

export type NextActionInput = NextStageInput & {
  repo: string
  verifier: string | null
  stageHistory: readonly StageEvent[]
  milestones?: readonly Pick<MilestoneStatus, 'id' | 'needs' | 'state'>[]
  // Carried so a caller can list a merge by PR; never read as consent.
  prNumber?: string
  autoMode?: boolean
}

export const DEFAULT_QA_START_POLICY: QaStartPolicy = 'ask-every-time'

export function isQaStartPolicy(value: unknown): value is QaStartPolicy {
  return value === 'ask-every-time' || value === 'cockpit-ai-ui-preapproved'
}

// The stages whose dispatch is rendered through the shared stage-brief, so a
// worker always gets the recorded intent. pipelinely-qa still hand-writes its
// TASK.md without one, which is why 'qa' is absent: no QA dispatch until it has
// a brief. Add 'qa' here when pipelinely-qa calls stage-brief.
export const INTENT_BRIEF_STAGES: readonly Stage[] = ['code-review']

export interface DecisionContext {
  qaStartPolicy: QaStartPolicy
  intentBriefStages: readonly Stage[]
}

// What an unreadable setting means: ask every time.
export const DEFAULT_DECISION_CONTEXT: DecisionContext = {
  qaStartPolicy: DEFAULT_QA_START_POLICY,
  intentBriefStages: INTENT_BRIEF_STAGES,
}

// The one mapping from the recorded settings to the decision's context, used
// by auto mode and every other unattended caller so none reads consent from
// anywhere else.
export function decisionContext(settings: Pick<Settings, 'qaStartPolicy'>): DecisionContext {
  return { ...DEFAULT_DECISION_CONTEXT, qaStartPolicy: settings.qaStartPolicy }
}

export function decideNextAction(task: NextActionInput, ctx: Partial<DecisionContext> = {}): NextAction {
  const { qaStartPolicy, intentBriefStages } = { ...DEFAULT_DECISION_CONTEXT, ...ctx }
  if (task.status !== 'waiting') return { kind: 'idle' }
  if (isBlockedByMergeConflicts(task)) return { kind: 'needs-you', reason: 'merge-conflicts' }

  const entry = matchTableEntry(task)
  if (isQaNotApplicable(task)) return { kind: 'skip-qa', marker: entry!.marker, reason: task.qaSkipReason! }

  if (!entry) {
    if (isReadyToMergeReason(task.waitingReason)) return { kind: 'needs-you', reason: 'merge' }
    if (isReadyForResultReview(task)) return { kind: 'needs-you', reason: 'result-review' }
    return { kind: 'needs-you', reason: 'question' }
  }

  switch (entry.stage) {
    case 'plan-review':
      return { kind: 'dispatch', stage: 'plan-review', marker: entry.marker }
    case 'dev':
      return decideDev(task, entry.marker)
    case 'code-review':
      if (!intentBriefStages.includes('code-review')) return { kind: 'needs-you', reason: 'review-intent-brief' }
      return { kind: 'dispatch', stage: 'code-review', marker: entry.marker }
    case 'qa':
      if (!isQaPreApproved(task, qaStartPolicy)) return { kind: 'needs-you', reason: 'qa-consent' }
      if (!intentBriefStages.includes('qa')) return { kind: 'needs-you', reason: 'qa-intent-brief' }
      return { kind: 'dispatch', stage: 'qa', marker: entry.marker }
    case 'comment-fix':
      return { kind: 'needs-you', reason: 'review-comments' }
    case 'qa-fixes':
      return { kind: 'needs-you', reason: 'qa-findings' }
    case 'design-approval':
      return { kind: 'needs-you', reason: 'design-approval' }
    // Auto-dispatching ds stages is out of scope for v1: it would widen
    // DispatchStage while the babysit work is changing it.
    case 'design-qa':
    case 'design-fixes':
    case 'adopt':
      return { kind: 'needs-you', reason: 'ds-stage' }
    default:
      return { kind: 'needs-you', reason: 'question' }
  }
}

// `/pipelinely-dev <parent>` treats a milestone parent as a flat task, and
// starting several paid dev sessions is the developer's call. Once every
// milestone is dispatched or done the parent keeps its STATUS, but its
// children carry their own state, so listing it again would be stale.
function decideDev(task: NextActionInput, marker: string): NextAction {
  const milestones = task.milestones ?? []
  if (milestones.length === 0) return { kind: 'dispatch', stage: 'dev', marker }
  const byId = new Map(milestones.map((milestone) => [milestone.id, milestone]))
  const isAnyReady = milestones.some((milestone) => isMilestoneReadyForDev(milestone, byId, task.stageHistory))
  return isAnyReady ? { kind: 'needs-you', reason: 'start-milestones' } : { kind: 'idle' }
}

// ---------------------------------------------------------------------------
// QA consent
// ---------------------------------------------------------------------------

// The consent is an allowlist: a VERIFY line is covered only when every
// command in it is one of these exact shapes. Anything unlisted (quotes, `$`,
// redirections, globs, wrappers, env prefixes, other runners or configs) is
// refused, so syntax nobody anticipated fails closed instead of slipping past
// a deny-list. Commands are joined by exactly ` && `, nothing else.
const COMMAND_JOINER = ' && '
// A plain relative path: no leading dash (a flag), no quote, glob or `..`.
const PLAIN_PATH = String.raw`(?!\S*\.\.)\w[\w./-]*`
const COUNT = String.raw`\d{1,3}`
const SAFE_COMMANDS: readonly RegExp[] = [
  new RegExp(String.raw`^npx tsc --noEmit(?: -p ${PLAIN_PATH})?$`),
  new RegExp(String.raw`^npx vitest run(?: ${PLAIN_PATH})*$`),
  // Exactly one `--project=ui`; a wildcard or second project would run the rest.
  new RegExp(String.raw`^npx playwright test --project=ui(?: --workers=${COUNT})?(?: --retries=${COUNT})?(?: --grep-invert @?\w+)?(?: ${PLAIN_PATH})*$`),
  /^npm run test:e2e$/,
]
// What makes a VERIFY an e2e run at all; unit-only checks never pre-approve QA.
const E2E_COMMAND_RE = /^(npx playwright test|npm run test:e2e)(\s|$)/
// A token naming a project the setting never covers. `integration` also hits
// paths (e2e/integration), which no plain ui run should name either.
const UNCOVERED_PROJECT_RE = /integration|(^|[^a-z])vm([^a-z]|$)/i

const PRE_APPROVED_REPO = 'cockpit-ai'

// Whether the recorded qaStartPolicy covers this task's QA. The policy is the
// only input that counts as consent: not the task's auto-mode toggle, not a
// TIMELINE note. Fails closed on anything it cannot read as ui-only.
export function isQaPreApproved(task: Pick<NextActionInput, 'repo' | 'verifier'>, policy: QaStartPolicy): boolean {
  if (policy !== 'cockpit-ai-ui-preapproved') return false
  if (task.repo !== PRE_APPROVED_REPO || !task.verifier) return false
  if (UNCOVERED_PROJECT_RE.test(task.verifier)) return false

  const commands = task.verifier.split(COMMAND_JOINER)
  if (!commands.every((command) => SAFE_COMMANDS.some((safe) => safe.test(command)))) return false
  return commands.some((command) => E2E_COMMAND_RE.test(command))
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

export const LOAD_AVERAGE_CEILING = 10

// An unreadable load average (NaN) holds the sweep: starting sessions on a
// machine whose load is unknown is the unsafe direction.
export function isLoadTooHigh(load1: number): boolean {
  return !(load1 <= LOAD_AVERAGE_CEILING)
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

export type SweepTask = NextActionInput & { slug: string }

export type SweepAction = { slug: string } & Extract<NextAction, { kind: 'dispatch' | 'skip-qa' }>
export interface NeedsYouItem {
  slug: string
  reason: NeedsYouReason
}
export type DeferredReason = 'load' | 'one-qa-per-sweep' | 'qa-in-flight' | 'dispatch-in-flight'
export interface DeferredItem {
  slug: string
  why: DeferredReason
}
export interface SweepPlan {
  actions: SweepAction[]
  needsYou: NeedsYouItem[]
  deferred: DeferredItem[]
  isLoadTooHigh: boolean
}

// The TIMELINE note an unattended dispatch leaves. One shape for auto mode and
// the sweep so whatever skips auto-dispatch lines skips both. Never a PR
// number: the dashboard takes the first #N of a dev note as the task's PR.
export const AUTO_DISPATCHED_NOTE_PREFIX = 'auto-dispatched'
export type UnattendedDispatcher = 'auto mode' | 'babysit'

export function dispatchTimelineNote(dispatcher: UnattendedDispatcher): string {
  return `${AUTO_DISPATCHED_NOTE_PREFIX} — ${dispatcher}`
}

// Furthest along the pipeline first: finishing work frees the board sooner
// than starting more of it.
const DISPATCH_PRIORITY: Record<DispatchStage | 'skip-qa', number> = {
  'skip-qa': 0,
  qa: 0,
  'code-review': 1,
  dev: 2,
  'plan-review': 3,
}

// A successful dispatch note on the newest TIMELINE line, for the stage about
// to be dispatched again, means the worker has not yet written `working`. A
// failed-dispatch note does not hold the task, so the next sweep retries it.
function isDispatchInFlight(task: SweepTask, stage: DispatchStage): boolean {
  const newest = task.stageHistory.at(-1)
  return newest?.stage === stage && !!newest.note?.startsWith(AUTO_DISPATCHED_NOTE_PREFIX)
}

// A QA just dispatched (its note is the newest TIMELINE line) counts as
// running even though the task has not yet read `working` on stage `qa`: a
// re-QA after qa-fixes reads as stage `qa-fixes`, so without this the slot
// looks free and a second e2e run could start in the same sweep.
function isQaRunning(tasks: readonly SweepTask[]): boolean {
  return tasks.some((task) => (task.status === 'working' && task.stage === 'qa') || isDispatchInFlight(task, 'qa'))
}

function compareOldestPrFirst(a: NeedsYouItem & { prNumber?: string }, b: NeedsYouItem & { prNumber?: string }): number {
  const aNumber = a.prNumber ? Number(a.prNumber) : Number.POSITIVE_INFINITY
  const bNumber = b.prNumber ? Number(b.prNumber) : Number.POSITIVE_INFINITY
  return aNumber === bNumber ? 0 : aNumber < bNumber ? -1 : 1
}

function orderNeedsYou(entries: readonly (NeedsYouItem & { prNumber?: string })[]): NeedsYouItem[] {
  const merges = entries.filter((entry) => entry.reason === 'merge').sort(compareOldestPrFirst)
  const rest = entries.filter((entry) => entry.reason !== 'merge')
  return [...merges, ...rest].map(({ slug, reason }) => ({ slug, reason }))
}

export function planSweep(
  tasks: readonly SweepTask[],
  { load1, isQaSessionLive = false }: { load1: number; isQaSessionLive?: boolean },
  ctx: Partial<DecisionContext> = {},
): SweepPlan {
  const isHeld = isLoadTooHigh(load1)
  // A live QA tmux session is a second guard for the one-QA rule: a fresh
  // dispatch writes `working` but no `qa` TIMELINE line, so if the dispatch
  // note was never written the task alone does not show a QA is running.
  const qaRunning = isQaSessionLive || isQaRunning(tasks)
  const candidates: SweepAction[] = []
  const needsYou: (NeedsYouItem & { prNumber?: string })[] = []
  const deferred: DeferredItem[] = []

  for (const task of tasks) {
    const action = decideNextAction(task, ctx)
    if (action.kind === 'needs-you') needsYou.push({ slug: task.slug, reason: action.reason, prNumber: task.prNumber })
    else if (action.kind === 'skip-qa') candidates.push({ slug: task.slug, ...action })
    else if (action.kind === 'dispatch') {
      if (isDispatchInFlight(task, action.stage)) deferred.push({ slug: task.slug, why: 'dispatch-in-flight' })
      else candidates.push({ slug: task.slug, ...action })
    }
  }

  const actions: SweepAction[] = []
  const ranked = [...candidates].sort((a, b) => priorityOf(a) - priorityOf(b))
  let hasQaDispatch = false
  for (const candidate of ranked) {
    if (isHeld) deferred.push({ slug: candidate.slug, why: 'load' })
    else if (candidate.kind === 'dispatch' && candidate.stage === 'qa' && qaRunning) deferred.push({ slug: candidate.slug, why: 'qa-in-flight' })
    else if (candidate.kind === 'dispatch' && candidate.stage === 'qa' && hasQaDispatch) deferred.push({ slug: candidate.slug, why: 'one-qa-per-sweep' })
    else {
      if (candidate.kind === 'dispatch' && candidate.stage === 'qa') hasQaDispatch = true
      actions.push(candidate)
    }
  }

  return { actions, needsYou: orderNeedsYou(needsYou), deferred: orderLikeBoard(deferred, tasks), isLoadTooHigh: isHeld }
}

function priorityOf(action: SweepAction): number {
  return DISPATCH_PRIORITY[action.kind === 'skip-qa' ? 'skip-qa' : action.stage]
}

function orderLikeBoard(items: DeferredItem[], tasks: readonly SweepTask[]): DeferredItem[] {
  const position = new Map(tasks.map((task, index) => [task.slug, index]))
  return [...items].sort((a, b) => position.get(a.slug)! - position.get(b.slug)!)
}

// The needs-you list alone, for callers that have no load reading (the panel).
export function collectNeedsYou(tasks: readonly SweepTask[], ctx: Partial<DecisionContext> = {}): NeedsYouItem[] {
  return planSweep(tasks, { load1: 0 }, ctx).needsYou
}

// ---------------------------------------------------------------------------
// tmux names
// ---------------------------------------------------------------------------

// A finished session's name is never reused by killing it: take the next free
// number instead (`-cr`, `-cr2`, `-cr3`).
export function freshTmuxName(base: string, liveNames: ReadonlySet<string>): string {
  if (!liveNames.has(base)) return base
  let suffix = 2
  while (liveNames.has(`${base}${suffix}`)) suffix++
  return `${base}${suffix}`
}
