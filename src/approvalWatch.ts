import { createHash } from 'node:crypto'
import { execa } from 'execa'
import { getLiveTmuxSessions } from './focusTab.js'
import { assignSessionsToPollableTasks, detectApprovalPrompt, isApprovalPollable, type ApprovalPrompt, type DetectedDialog } from './approvalPrompt.js'
import type { Task } from './types.js'

// A hung tmux call must not keep a poll tick "in flight" forever — every
// later tick would be skipped and the feature would silently stop.
export const TMUX_READ_TIMEOUT_MS = 2000
const CAPTURE_MAX_BUFFER_BYTES = 256 * 1024

export interface ApprovalWatchDeps {
  // null = no tmux server; rejects when `tmux ls` itself fails (e.g. times out)
  listSessions: () => Promise<Set<string> | null>
  // `target` is a ready tmux target: `=<session>:` for the poll, a pinned `%N` for an answer.
  capturePane: (target: string) => Promise<string>
  logError: (message: string) => void
}

// Read-only by construction: `tmux ls` and `capture-pane -p` only, never
// send-keys or anything else that could write to a worker's session. Without
// -S, capture-pane returns just the visible screen.
export const productionApprovalWatchDeps: ApprovalWatchDeps = {
  listSessions: () => getLiveTmuxSessions({ timeoutMs: TMUX_READ_TIMEOUT_MS }),
  capturePane: async (target) => {
    const { stdout } = await execa('tmux', ['capture-pane', '-p', '-J', '-t', target], {
      timeout: TMUX_READ_TIMEOUT_MS,
      maxBuffer: CAPTURE_MAX_BUFFER_BYTES,
    })
    return stdout
  },
  logError: (message) => console.error(message),
}

const FINGERPRINT_HEX_CHARS = 16

// Identity of one dialog instance. The `❯` position is deliberately not part
// of it: moving the pointer is not answering, so a key that only moved focus
// leaves the fingerprint unchanged and the confirm step says so.
export function fingerprintPrompt(session: string, dialog: DetectedDialog): string {
  const { question, summary, options, context } = dialog
  return createHash('sha256').update(JSON.stringify([session, question, summary, options, context])).digest('hex').slice(0, FINGERPRINT_HEX_CHARS)
}

// The one capture-then-detect path, shared by the poll and the answer route so
// the fingerprint a card was shown is the one a click is re-checked against.
export async function readSessionDialog(
  target: string,
  session: string,
  deps: Pick<ApprovalWatchDeps, 'capturePane'>,
): Promise<ApprovalPrompt | null> {
  const detected = await deps.capturePane(target).then(detectApprovalPrompt)
  if (!detected) return null
  const { context: _context, ...published } = detected
  return { session, ...published, fingerprint: fingerprintPrompt(session, detected) }
}

export function sessionTarget(session: string): string {
  return `=${session}:`
}

function sessionsInPriorityOrder(sessions: string[], primarySession: string | null): string[] {
  return [...sessions].sort((a, b) => {
    if (a === primarySession) return -1
    if (b === primarySession) return 1
    return a.localeCompare(b)
  })
}

// Owned by the caller and survives across ticks. `failures` makes a
// persistently broken call log once per distinct message, not every poll;
// `lastPrompts` lets a transient failure keep a callout instead of flickering.
export interface ApprovalPollState {
  failures: Map<string, string>
  lastPrompts: Map<string, ApprovalPrompt>
}

export function createApprovalPollState(): ApprovalPollState {
  return { failures: new Map(), lastPrompts: new Map() }
}

// `failures` key for `tmux ls` itself; real session names can't contain a space.
const LIST_FAILURE_KEY = 'tmux ls'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function logFailureOnce(state: ApprovalPollState, key: string, message: string, logLine: string, deps: ApprovalWatchDeps): void {
  if (state.failures.get(key) === message) return
  state.failures.set(key, message)
  deps.logError(logLine)
}

// A hung or failed `tmux ls` says nothing new about the panes, so the previous
// callouts stand rather than all vanishing for a tick.
function previousPromptsBySlug(state: ApprovalPollState, slugBySession: Map<string, string>): Map<string, ApprovalPrompt> {
  const prompts = new Map<string, ApprovalPrompt>()
  for (const [session, prompt] of state.lastPrompts) {
    const slug = slugBySession.get(session)
    if (slug && !prompts.has(slug)) prompts.set(slug, prompt)
  }
  return prompts
}

// Returns slug -> the dialog its live tmux session is stopped on.
export async function pollApprovalPrompts(
  tasks: Pick<Task, 'slug' | 'status' | 'tmuxSession'>[],
  deps: ApprovalWatchDeps,
  state: ApprovalPollState,
): Promise<Map<string, ApprovalPrompt>> {
  const { failures, lastPrompts } = state
  let liveSessions: Set<string> | null
  try {
    liveSessions = await deps.listSessions()
  } catch (err) {
    const message = errorMessage(err)
    logFailureOnce(state, LIST_FAILURE_KEY, message, `[approvalWatch] tmux ls failed: ${message}`, deps)
    return previousPromptsBySlug(state, assignSessionsToPollableTasks(lastPrompts.keys(), tasks))
  }
  failures.delete(LIST_FAILURE_KEY)
  // No tmux server (or no tmux) is an expected steady state, not an error.
  if (!liveSessions) {
    failures.clear()
    lastPrompts.clear()
    return new Map()
  }

  const slugBySession = assignSessionsToPollableTasks(liveSessions, tasks)
  for (const session of [...failures.keys(), ...lastPrompts.keys()]) {
    if (session !== LIST_FAILURE_KEY && !slugBySession.has(session)) {
      failures.delete(session)
      lastPrompts.delete(session)
    }
  }

  const prompts = new Map<string, ApprovalPrompt>()
  for (const task of tasks.filter(isApprovalPollable)) {
    const taskSessions = [...slugBySession].filter(([, slug]) => slug === task.slug).map(([session]) => session)
    for (const session of sessionsInPriorityOrder(taskSessions, task.tmuxSession)) {
      let prompt: ApprovalPrompt | null
      try {
        prompt = await readSessionDialog(sessionTarget(session), session, deps)
      } catch (err) {
        const message = errorMessage(err)
        logFailureOnce(state, session, message, `[approvalWatch] capture-pane failed for ${session}: ${message}`, deps)
        const previous = lastPrompts.get(session)
        if (previous) {
          prompts.set(task.slug, previous)
          break
        }
        continue
      }
      failures.delete(session)
      if (!prompt) {
        lastPrompts.delete(session)
        continue
      }
      lastPrompts.set(session, prompt)
      prompts.set(task.slug, prompt)
      break
    }
  }
  return prompts
}

export interface ApprovalTickerOptions {
  poll: () => Promise<Map<string, ApprovalPrompt>>
  onChange: (prompts: Map<string, ApprovalPrompt>) => Promise<void>
  logError: (message: string) => void
}

// One poll tick. Skipped while the previous one is still in flight, calls
// `onChange` only when the set of prompts actually changed (so an unchanged
// board costs nothing beyond the captures), and logs a failing tick once per
// distinct message rather than every interval.
export function createApprovalTicker({ poll, onChange, logError }: ApprovalTickerOptions): () => Promise<void> {
  let isInFlight = false
  let lastPromptsJson = '[]'
  let lastTickError: string | null = null
  return async () => {
    if (isInFlight) return
    isInFlight = true
    try {
      const prompts = await poll()
      lastTickError = null
      const promptsJson = JSON.stringify([...prompts].sort(([a], [b]) => a.localeCompare(b)))
      if (promptsJson === lastPromptsJson) return
      await onChange(prompts)
      // After onChange so a failed refresh is retried on the next tick.
      lastPromptsJson = promptsJson
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message !== lastTickError) {
        lastTickError = message
        logError(`[approvalWatch] tick failed: ${message}`)
      }
    } finally {
      isInFlight = false
    }
  }
}
