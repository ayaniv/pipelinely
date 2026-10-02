import fs from 'node:fs/promises'
import path from 'node:path'
import { assignSessionsToPollableTasks, isApprovalPollable, type ApprovalPrompt } from './approvalPrompt.js'
import { productionApprovalWatchDeps, readSessionDialog } from './approvalWatch.js'
import { getLiveTmuxSessions, resolveActivePaneId, sendKeysToPane } from './focusTab.js'
import type { DialogChoice, DialogFailureReason, DialogRefusalReason } from './answerDialogWire.js'
import { readOrchestratorTmux } from './orchestratorTmux.js'
import type { Task } from './types.js'

// Answers a Claude Code selection dialog that a task's worker is stopped on,
// by typing exactly one key into its tmux pane. This is the only code path
// that writes into a worker's session, so every rule below fails closed:
// the first failed step returns and nothing after it runs. The caller is the
// POST /answer-dialog/:slug handler and nothing else (dialogAnswer.contract.test.ts).

export const CONFIRM_ATTEMPTS = 5
export const CONFIRM_INTERVAL_MS = 200
const TIMED_OUT_SEND_MESSAGE = 'tmux timed out sending the key — it may or may not have been typed, check the terminal'

export type { DialogChoice, DialogFailureReason, DialogRefusalReason }

type OwnedTask = Pick<Task, 'slug' | 'status' | 'tmuxSession'>

export interface DialogAnswerInput {
  slug: string
  session: string
  choice: DialogChoice
  fingerprint: string
  peer: string
  userAgent: string | null
}

// What the server itself is showing for this task right now, and every known
// task (done and shelved included), so ownership is judged exactly as the poll judges it.
export interface DialogAnswerContext {
  publishedPrompt: ApprovalPrompt | null
  tasks: OwnedTask[]
}

export type DialogAnswerResult =
  | { outcome: 'answered' }
  | { outcome: 'unconfirmed' }
  | { outcome: 'refused'; reason: DialogRefusalReason }
  | { outcome: 'failed'; reason: DialogFailureReason; error: string }

export interface DialogAuditEntry {
  at: string
  phase: 'attempt' | 'result'
  slug: string
  session: string
  paneId: string
  choice: DialogChoice
  keys: string[]
  question: string
  fingerprint: string
  peer: string
  userAgent: string | null
  outcome?: DialogAnswerResult['outcome']
  reason?: DialogRefusalReason | DialogFailureReason
}

export interface DialogAnswerDeps {
  listSessions: () => Promise<Set<string> | null>
  readOrchestratorTmux: () => Promise<string | null>
  resolvePane: (session: string) => Promise<string | null>
  capturePane: (target: string) => Promise<string>
  sendKeys: (paneId: string, keys: readonly string[]) => Promise<void>
  appendAudit: (slug: string, entry: DialogAuditEntry) => Promise<void>
  logInfo: (message: string) => void
  logError: (message: string) => void
  waitForPane: (ms: number) => Promise<void>
  now: () => Date
}

// The only place key text is made. A number must be one of the dialog's visible
// options; the client never supplies key text. `-l` makes tmux type the digit
// as text instead of looking it up as a key name. Never Enter.
export function keysForChoice(choice: DialogChoice, prompt: Pick<ApprovalPrompt, 'options'>): string[] | null {
  if (choice === 'cancel') return ['Escape']
  if (!prompt.options.some((option) => option.number === choice)) return null
  return ['-l', String(choice)]
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const refuse = (reason: DialogRefusalReason): DialogAnswerResult => ({ outcome: 'refused', reason })
const fail = (reason: DialogFailureReason, err: unknown): DialogAnswerResult => ({ outcome: 'failed', reason, error: errorMessage(err) })

const sessionsBeingAnswered = new Set<string>()

interface AttemptProgress {
  auditBase: Omit<DialogAuditEntry, 'phase' | 'outcome' | 'reason'> | null
  hasLoggedAttempt: boolean
  hasSentKey: boolean
}

async function isOwnedWorkerSession(task: OwnedTask, session: string, context: DialogAnswerContext, deps: DialogAnswerDeps): Promise<boolean> {
  if (!isApprovalPollable(task)) return false
  const liveSessions = await deps.listSessions()
  if (!liveSessions) return false
  if (assignSessionsToPollableTasks(liveSessions, context.tasks).get(session) !== task.slug) return false
  return session !== (await deps.readOrchestratorTmux())
}

// Polls a bounded number of times: tmux emits no "pane changed" event to wait on.
async function confirmDialogMoved(paneId: string, session: string, before: ApprovalPrompt, deps: DialogAnswerDeps): Promise<DialogAnswerResult> {
  for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt++) {
    await deps.waitForPane(CONFIRM_INTERVAL_MS)
    let after: ApprovalPrompt | null
    try {
      after = await readSessionDialog(paneId, session, deps)
    } catch (err) {
      // A vanished pane is never reported as answered.
      deps.logError(`[answerDialog] could not confirm ${session}: ${errorMessage(err)}`)
      return { outcome: 'unconfirmed' }
    }
    if (!after || after.fingerprint !== before.fingerprint) return { outcome: 'answered' }
  }
  return { outcome: 'unconfirmed' }
}

async function sendOnce(paneId: string, keys: string[], deps: DialogAnswerDeps): Promise<DialogAnswerResult | null> {
  try {
    await deps.sendKeys(paneId, keys)
    return null
  } catch (err) {
    const timedOut = err instanceof Error && 'timedOut' in err && err.timedOut === true
    return timedOut ? { outcome: 'failed', reason: 'send-failed', error: TIMED_OUT_SEND_MESSAGE } : fail('send-failed', err)
  }
}

async function runSteps(
  task: OwnedTask,
  input: DialogAnswerInput,
  context: DialogAnswerContext,
  deps: DialogAnswerDeps,
  progress: AttemptProgress,
): Promise<DialogAnswerResult> {
  const { session, choice, fingerprint } = input
  const shown = context.publishedPrompt
  if (!shown) return refuse('no-dialog')
  if (shown.session !== session || shown.fingerprint !== fingerprint) return refuse('dialog-changed')
  const attemptKeys = keysForChoice(choice, shown)
  if (!attemptKeys) return refuse('unknown-option')

  try {
    if (!(await isOwnedWorkerSession(task, session, context, deps))) return refuse('session-not-owned')
  } catch (err) {
    return fail('capture-failed', err)
  }

  if (sessionsBeingAnswered.has(session)) return refuse('busy')
  sessionsBeingAnswered.add(session)
  try {
    const paneId = await deps.resolvePane(session)
    if (!paneId) return refuse('no-dialog')

    progress.auditBase = {
      at: deps.now().toISOString(), slug: input.slug, session, paneId, choice, keys: attemptKeys,
      question: shown.question, fingerprint, peer: input.peer, userAgent: input.userAgent,
    }
    // Durable before anything is typed: if this fails, nothing is sent.
    try {
      await deps.appendAudit(input.slug, { ...progress.auditBase, phase: 'attempt' })
    } catch (err) {
      return fail('audit-failed', err)
    }
    progress.hasLoggedAttempt = true

    let fresh: ApprovalPrompt | null
    try {
      fresh = await readSessionDialog(paneId, session, deps)
    } catch (err) {
      return fail('capture-failed', err)
    }
    if (!fresh) return refuse('no-dialog')
    if (fresh.fingerprint !== fingerprint) return refuse('dialog-changed')

    const keys = keysForChoice(choice, fresh)
    if (!keys) return refuse('unknown-option')
    const sendFailure = await sendOnce(paneId, keys, deps)
    if (sendFailure) return sendFailure
    progress.hasSentKey = true
    return await confirmDialogMoved(paneId, session, fresh, deps)
  } catch (err) {
    if (!progress.hasSentKey) return fail('capture-failed', err)
    // capture-failed would tell the user nothing was sent, and a key was.
    deps.logError(`[answerDialog] could not confirm ${session} after sending: ${errorMessage(err)}`)
    return { outcome: 'unconfirmed' }
  } finally {
    sessionsBeingAnswered.delete(session)
  }
}

function describeOutcome(result: DialogAnswerResult): string {
  switch (result.outcome) {
    case 'refused': return `refused (${result.reason})`
    case 'failed': return `failed (${result.reason}): ${result.error}`
    default: return result.outcome
  }
}

export async function answerDialog(
  task: OwnedTask,
  input: DialogAnswerInput,
  context: DialogAnswerContext,
  deps: DialogAnswerDeps,
): Promise<DialogAnswerResult> {
  const progress: AttemptProgress = { auditBase: null, hasLoggedAttempt: false, hasSentKey: false }
  const result = await runSteps(task, input, context, deps, progress)

  if (progress.hasLoggedAttempt && progress.auditBase) {
    const reason = result.outcome === 'refused' || result.outcome === 'failed' ? result.reason : undefined
    try {
      await deps.appendAudit(input.slug, {
        ...progress.auditBase, at: deps.now().toISOString(), phase: 'result', outcome: result.outcome, ...(reason ? { reason } : {}),
      })
    } catch (err) {
      // The attempt entry already records the request, so the real outcome stands.
      deps.logError(`[answerDialog] could not write the result entry for ${input.slug}: ${errorMessage(err)}`)
    }
  }

  const line = `[answerDialog] ${input.slug} ${input.session} choice=${input.choice} peer=${input.peer}: ${describeOutcome(result)}`
  if (result.outcome === 'failed') deps.logError(line)
  else deps.logInfo(line)
  return result
}

const AUDIT_FILE = 'DIALOG_ANSWERS.jsonl'

// Not TIMELINE: computeStage parses TIMELINE and must not see these lines.
export function productionDialogAnswerDeps(tasksDir: string): DialogAnswerDeps {
  return {
    listSessions: () => getLiveTmuxSessions({ timeoutMs: 2000 }),
    readOrchestratorTmux: () => readOrchestratorTmux(tasksDir),
    resolvePane: (session) => resolveActivePaneId(session),
    capturePane: (target) => productionApprovalWatchDeps.capturePane(target),
    sendKeys: (paneId, keys) => sendKeysToPane(paneId, keys),
    appendAudit: (slug, entry) => fs.appendFile(path.join(tasksDir, slug, AUDIT_FILE), `${JSON.stringify(entry)}\n`),
    logInfo: (message) => console.log(message),
    logError: (message) => console.error(message),
    waitForPane: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
  }
}
