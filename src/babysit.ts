import fs from 'node:fs/promises'
import { resolveTaskDirArg, SAFE_TOKEN } from './batchDispatch.js'
import {
  decideNextAction,
  decisionContext,
  dispatchTimelineNote,
  freshTmuxName,
  planSweep,
  type DecisionContext,
  type DeferredReason,
  type DispatchStage,
  type NeedsYouReason,
  type SweepAction,
  type SweepPlan,
  type SweepTask,
} from './nextAction.js'
import { appendTimelineLine, composeStageCommand, recordQaSkipped, STAGE_SKILL } from './taskParser.js'
import type { Settings, Stage } from './types.js'

// The `/pipelinely-babysit` CLI. It PRINTS the actions one sweep would take and
// does the two writes that are the CLI's alone (a recognised QA skip, a
// dispatch note); the skill executes the dispatches with the existing
// skills. Every rule is the shared decision in nextAction.ts, never a copy.

export const EXIT_OK = 0
export const EXIT_ERROR = 1
// skip-qa only: the decision for that task is not a skip, so nothing was written.
export const EXIT_REFUSED = 2
export const EXIT_NOTHING_TO_DO = 3
export const EXIT_HELD_BY_LOAD = 4

const USAGE = [
  'usage: babysit next [--done a,b] [--except a b] [--only <slug>]',
  '       babysit skip-qa <slug>',
  '       babysit note <slug> <stage> [--failed <reason>]',
  '       babysit report [--done a,b] [--failed slug=reason ...] [--asked slug=question ...] [--except a b] [--only <slug>]',
  '       babysit tmux-name <base>',
].join('\n')

const DISPATCH_STAGES: readonly DispatchStage[] = ['plan-review', 'dev', 'code-review', 'qa']

export interface BabysitDeps {
  tasksDir: string
  readSettings: (tasksDir: string) => Promise<Settings>
  loadTasks: (tasksDir: string, settings: Settings) => Promise<SweepTask[]>
  loadavg: () => number
  listTmuxSessions: () => Promise<string[]>
  // Overrides the stages that have a stage-brief, to test the path where
  // pipelinely-qa has one; production leaves it unset and takes INTENT_BRIEF_STAGES.
  intentBriefStages?: readonly Stage[]
}

export interface BabysitResult {
  exitCode: number
  stdout: string[]
  stderr: string[]
}

// The env-leak guard (stale e2e-fixture TASKS_DIR in an iTerm2 tab): the CLI
// prints this line before anything else can log, so it is a function the
// entry point calls first rather than part of the buffered result.
export function tasksDirLine(tasksDir: string): string {
  return `tasks dir: ${tasksDir}`
}

// SAFE_TOKEN plus: not led by `-` (an argv would read it as a flag) or `.`
// (`.`/`..`/hidden dirs are not tasks).
function isPlainSlug(slug: string): boolean {
  return SAFE_TOKEN.test(slug) && !/^[-.]/.test(slug)
}

// JSON.stringify leaves invisible format characters (a bidi override) and
// line separators raw, and those spoof or reorder what the terminal shows.
function escapeForLog(text: string): string {
  return JSON.stringify(text).replace(/[\p{Cf}\p{Cc}\u2028\u2029]/gu, (char) => `\\u${char.codePointAt(0)!.toString(16).padStart(4, '0')}`)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const LIST_FLAGS = ['--done', '--except', '--only', '--failed', '--asked'] as const
type ListFlag = (typeof LIST_FLAGS)[number]

interface ParsedArgs {
  positional: string[]
  flags: Record<ListFlag, string[]>
  // A bare `--failed` (no reason) is still a failure.
  present: Set<ListFlag>
}

// A flag takes every token up to the next `--flag`, and a repeated flag adds
// to the earlier one, so `--except a b --except c` excludes all three.
function parseArgs(args: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { positional: [], flags: { '--done': [], '--except': [], '--only': [], '--failed': [], '--asked': [] }, present: new Set() }
  let current: ListFlag | null = null
  for (const arg of args) {
    // A failure reason or a question is free text and may start with dashes;
    // only a known flag ends it.
    const isKnownFlag = (LIST_FLAGS as readonly string[]).includes(arg)
    const isFreeText = current === '--failed' || current === '--asked'
    if (arg.startsWith('--') && (isKnownFlag || !isFreeText)) {
      if (!isKnownFlag) throw new Error(`unknown flag ${arg}`)
      current = arg as ListFlag
      parsed.present.add(current)
    } else if (current) parsed.flags[current].push(arg)
    else parsed.positional.push(arg)
  }
  return parsed
}

// Every slug the skill passes back was printed by `next`, so anything that is
// not a plain slug is a broken command line, never a task: refusing it loudly
// is what keeps a mangled `--done` from handing out the same action forever.
// Escaped in the message, so a hostile value is never echoed raw.
function checkedSlug(flag: ListFlag, slug: string): string {
  if (!isPlainSlug(slug)) throw new Error(`${flag}: ${escapeForLog(slug)} is not a task slug`)
  return slug
}

// Empty segments are allowed: the first `next` of a sweep has an empty --done.
function slugList(parsed: ParsedArgs, flag: ListFlag): string[] {
  return parsed.flags[flag]
    .flatMap((value) => value.split(','))
    .map((slug) => slug.trim())
    .filter(Boolean)
    .map((slug) => checkedSlug(flag, slug))
}

// `--failed slug=reason` / `--asked slug=question`. A token with no `=`
// continues the previous text, so an unquoted multi-word reason is not lost.
// The text is reduced to one clean line, since the report prints it verbatim.
function slugTexts(parsed: ParsedArgs, flag: '--failed' | '--asked'): Map<string, string> {
  const texts = new Map<string, string>()
  let lastSlug: string | null = null
  for (const token of parsed.flags[flag]) {
    const separator = token.indexOf('=')
    if (separator > 0) {
      lastSlug = checkedSlug(flag, token.slice(0, separator))
      texts.set(lastSlug, token.slice(separator + 1))
    } else if (lastSlug) texts.set(lastSlug, `${texts.get(lastSlug)} ${token}`)
  }
  return new Map([...texts].map(([slug, text]) => [slug, safeNoteText(text) || 'unknown']))
}

// ---------------------------------------------------------------------------
// The sweep, as this CLI sees it
// ---------------------------------------------------------------------------

interface Scope {
  // Every slug the developer named in --only / --except.
  named: string[]
  isInScope: (slug: string) => boolean
  done: ReadonlySet<string>
}

function scopeFrom(parsed: ParsedArgs): Scope {
  const only = slugList(parsed, '--only')
  const except = new Set(slugList(parsed, '--except'))
  const failed = [...slugTexts(parsed, '--failed').keys()]
  const asked = [...slugTexts(parsed, '--asked').keys()]
  return {
    named: [...only, ...except],
    isInScope: (slug) => (only.length === 0 || only.includes(slug)) && !except.has(slug),
    done: new Set([...slugList(parsed, '--done'), ...failed, ...asked]),
  }
}

interface SweepView {
  settings: Settings
  plan: SweepPlan
  tasks: SweepTask[]
  ctx: DecisionContext
  load1: number
  unsafeCount: number
}

const QA_SESSION_RE = /^worker-(.+)-qa\d*$/

// QA tabs live until someone closes them, so an open QA session only counts
// while its task is still working; a finished or off-board one is not a run.
// An unreadable tmux holds QA: starting an e2e run when it is unknown whether
// one is already live is the unsafe direction.
async function isQaSessionRunning(deps: BabysitDeps, tasks: readonly SweepTask[], stderr: string[]): Promise<boolean> {
  const workingSlugs = new Set(tasks.filter((task) => task.status === 'working').map((task) => task.slug))
  try {
    return (await deps.listTmuxSessions()).some((name) => workingSlugs.has(QA_SESSION_RE.exec(name)?.[1] ?? ''))
  } catch (err) {
    stderr.push(`babysit: could not list tmux sessions, holding QA: ${errorMessage(err)}`)
    return true
  }
}

// Everything is read fresh on every call: a merge or a finished dispatch since
// the last call changes what is safe to do next.
async function readSweep(deps: BabysitDeps, stderr: string[]): Promise<SweepView> {
  const settings = await deps.readSettings(deps.tasksDir)
  const allTasks = await deps.loadTasks(deps.tasksDir, settings)
  // The printed slug is pasted into shell commands by the skill, so a task dir
  // whose name is not a plain token is never planned (SAFE_TOKEN also excludes
  // the comma that `--done` splits on). Logged escaped, never echoed raw.
  const tasks = allTasks.filter((task) => isPlainSlug(task.slug))
  const unsafeCount = allTasks.length - tasks.length
  if (unsafeCount > 0) {
    const names = allTasks.filter((task) => !isPlainSlug(task.slug)).map((task) => escapeForLog(task.slug))
    stderr.push(`babysit: ignoring ${unsafeCount} task dir(s) with unsafe names: ${names.join(', ')}`)
  }
  const load1 = deps.loadavg()
  const isQaSessionLive = await isQaSessionRunning(deps, tasks, stderr)
  const ctx: DecisionContext = {
    ...decisionContext(settings),
    ...(deps.intentBriefStages ? { intentBriefStages: deps.intentBriefStages } : {}),
  }
  return { settings, tasks, ctx, load1, unsafeCount, plan: planSweep(tasks, { load1, isQaSessionLive }, ctx) }
}

// A mistyped exclusion silently ignored would sweep the very task the developer
// meant to leave alone, so a slug that names no task is refused, not skipped.
function assertScopeNamesTasks(scope: Scope, tasks: readonly SweepTask[]): void {
  const known = new Set(tasks.map((task) => task.slug))
  const unknown = [...new Set(scope.named)].filter((slug) => !known.has(slug))
  if (unknown.length > 0) throw new Error(`--only/--except names no task in the tasks dir: ${unknown.map(escapeForLog).join(', ')}`)
}

function formatLoad(load1: number): string {
  return Number.isFinite(load1) ? load1.toFixed(1) : 'unreadable'
}

function commandFor(action: SweepAction): string | null {
  if (action.kind !== 'dispatch') return null
  return composeStageCommand(STAGE_SKILL[action.stage]!.skillName, action.slug)
}

function describeAction(action: SweepAction): string {
  return JSON.stringify({
    slug: action.slug,
    kind: action.kind,
    stage: action.kind === 'dispatch' ? action.stage : 'qa',
    command: commandFor(action),
    ...(action.kind === 'skip-qa' ? { reason: action.reason } : {}),
  })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function next(parsed: ParsedArgs, deps: BabysitDeps, result: BabysitResult): Promise<void> {
  const scope = scopeFrom(parsed)
  const { plan, load1, tasks } = await readSweep(deps, result.stderr)
  assertScopeNamesTasks(scope, tasks)
  const action = plan.actions.find((candidate) => scope.isInScope(candidate.slug) && !scope.done.has(candidate.slug))
  if (action) {
    result.stdout.push(describeAction(action))
    return
  }
  const isHeld = plan.deferred.some((item) => item.why === 'load' && scope.isInScope(item.slug) && !scope.done.has(item.slug))
  result.exitCode = isHeld ? EXIT_HELD_BY_LOAD : EXIT_NOTHING_TO_DO
  if (isHeld) result.stdout.push(`held: load ${formatLoad(load1)}`)
}

async function skipQa(slug: string | undefined, deps: BabysitDeps, result: BabysitResult): Promise<void> {
  if (!slug) throw new UsageError('skip-qa needs a <slug>')
  const { tasks, ctx } = await readSweep(deps, result.stderr)
  const task = tasks.find((candidate) => candidate.slug === slug)
  if (!task) throw new Error(`No task '${slug}' in ${deps.tasksDir}`)
  const action = decideNextAction(task, ctx)
  if (action.kind !== 'skip-qa') {
    result.exitCode = EXIT_REFUSED
    result.stderr.push(`babysit: refusing to skip QA for ${slug}: the decision is ${action.kind}, not skip-qa`)
    return
  }
  try {
    await recordQaSkipped(deps.tasksDir, slug, action.reason)
  } catch (err) {
    throw new Error(`failed to record the QA skip for ${slug}: ${errorMessage(err)}`)
  }
  result.stdout.push(`${slug}: QA skipped — ${action.reason}`)
}

// The dashboard takes the first `#N` of the newest `dev` note as the task's PR
// number, so a reason quoted from anywhere must never carry one. Also one line:
// TIMELINE is line-oriented.
function safeNoteText(text: string): string {
  return text.replace(/#(?=\d)/g, '').replace(/\s+/g, ' ').replace(/[\p{Cf}\p{Cc}]/gu, '').trim()
}

async function note(parsed: ParsedArgs, deps: BabysitDeps, result: BabysitResult): Promise<void> {
  const [slug, stage] = parsed.positional
  if (!slug || !stage) throw new UsageError('note needs <slug> <stage>')
  if (!(DISPATCH_STAGES as readonly string[]).includes(stage)) {
    throw new Error(`'${stage}' is not a dispatchable stage (${DISPATCH_STAGES.join(', ')})`)
  }
  const taskDir = resolveTaskDirArg(deps.tasksDir, slug)
  try {
    await fs.access(taskDir)
  } catch {
    throw new Error(`No task '${slug}' in ${deps.tasksDir}`)
  }
  const isFailure = parsed.present.has('--failed')
  const reason = safeNoteText(parsed.flags['--failed'].join(' ')) || 'unknown'
  const line = isFailure ? `auto-dispatch failed — babysit: ${reason}` : dispatchTimelineNote('babysit')
  try {
    await appendTimelineLine(taskDir, stage as Stage, line)
  } catch (err) {
    throw new Error(`failed to append the TIMELINE note for ${slug}: ${errorMessage(err)}`)
  }
  result.stdout.push(`${slug}: ${line}`)
}

const NEEDS_YOU_HINTS: Record<NeedsYouReason, string> = {
  merge: 'ready to merge — your click',
  'merge-conflicts': 'conflicts with its base — use Fix conflicts',
  'review-comments': 'review comments need your decision',
  'qa-findings': 'QA findings need your triage',
  'qa-consent': 'QA needs your yes (qaStartPolicy)',
  'qa-intent-brief': 'QA is approved but pipelinely-qa has no intent brief yet',
  'review-intent-brief': 'code review has no intent brief yet',
  'start-milestones': 'pick which milestone to start',
  'result-review': 'ready for your review',
  'design-approval': 'design QA needs your approval',
  'ds-stage': 'a design-system stage — dispatch it yourself',
  question: 'a worker is asking something',
}

const DEFERRED_HINTS: Record<DeferredReason, string> = {
  load: 'machine load above the ceiling',
  'one-qa-per-sweep': 'another QA was sent in this sweep',
  'qa-in-flight': 'another task is running its QA',
  'dispatch-in-flight': 'the hand-off was already sent; waiting for the worker',
}

async function report(parsed: ParsedArgs, deps: BabysitDeps, result: BabysitResult): Promise<void> {
  const scope = scopeFrom(parsed)
  const failed = slugTexts(parsed, '--failed')
  const asked = slugTexts(parsed, '--asked')
  const { settings, plan, load1, unsafeCount, tasks } = await readSweep(deps, result.stderr)
  assertScopeNamesTasks(scope, tasks)
  const moved = slugList(parsed, '--done').filter((slug) => !failed.has(slug) && !asked.has(slug) && scope.isInScope(slug))
  const notRun = plan.actions.filter((action) => scope.isInScope(action.slug) && !scope.done.has(action.slug))
  const lines: string[] = [
    '# Babysit report',
    '',
    `qaStartPolicy: ${settings.qaStartPolicy} · load: ${formatLoad(load1)}${plan.isLoadTooHigh ? ' (held)' : ''}`,
    '',
    `**moved:** ${moved.length ? moved.join(', ') : 'nothing'}`,
  ]
  if (failed.size > 0) {
    lines.push('', '**failed:**', ...[...failed].map(([slug, reason]) => `- ${slug} — ${reason}`))
  }
  // A dispatched skill that asked the developer something was stopped, never
  // answered (see SKILL.md), so the question is theirs.
  const needsYou = [
    ...plan.needsYou.filter((item) => scope.isInScope(item.slug)).map((item) => `- ${item.slug} — ${item.reason} (${NEEDS_YOU_HINTS[item.reason]})`),
    ...[...asked].filter(([slug]) => scope.isInScope(slug)).map(([slug, question]) => `- ${slug} — asked (${question})`),
  ]
  lines.push('', '**needs you:**', ...(needsYou.length ? needsYou : ['- nothing']))
  const deferred = plan.deferred.filter((item) => scope.isInScope(item.slug))
  if (deferred.length > 0 || notRun.length > 0) {
    lines.push('', '**deferred:**')
    for (const item of deferred) lines.push(`- ${item.slug} — ${item.why} (${DEFERRED_HINTS[item.why]})`)
    for (const action of notRun) lines.push(`- ${action.slug} — not run this sweep`)
  }
  if (unsafeCount > 0) lines.push('', `**ignored:** ${unsafeCount} task dir(s) with unsafe names (see stderr)`)
  result.stdout.push(...lines)
}

async function tmuxName(base: string | undefined, deps: BabysitDeps, result: BabysitResult): Promise<void> {
  if (!base) throw new UsageError('tmux-name needs a <base>')
  let live: string[]
  try {
    live = await deps.listTmuxSessions()
  } catch (err) {
    throw new Error(`could not list tmux sessions: ${errorMessage(err)}`)
  }
  result.stdout.push(freshTmuxName(base, new Set(live)))
}

class UsageError extends Error {}

export async function runBabysit(argv: readonly string[], deps: BabysitDeps): Promise<BabysitResult> {
  const result: BabysitResult = { exitCode: EXIT_OK, stdout: [], stderr: [] }
  const [command, ...rest] = argv
  try {
    const parsed = parseArgs(rest)
    switch (command) {
      case 'next':
        await next(parsed, deps, result)
        break
      case 'skip-qa':
        await skipQa(parsed.positional[0], deps, result)
        break
      case 'note':
        await note(parsed, deps, result)
        break
      case 'report':
        await report(parsed, deps, result)
        break
      case 'tmux-name':
        await tmuxName(parsed.positional[0], deps, result)
        break
      default:
        throw new UsageError(command ? `unknown command '${command}'` : 'missing command')
    }
  } catch (err) {
    result.exitCode = EXIT_ERROR
    result.stdout.length = 0
    result.stderr.push(`babysit: ${errorMessage(err)}`)
    if (err instanceof UsageError) result.stderr.push(USAGE)
  }
  return result
}
