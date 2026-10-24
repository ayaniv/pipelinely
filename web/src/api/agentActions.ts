import type { Logger } from '../log'
import type { ActionOutcome, PostActionOptions } from './actions'

// The toolbar's two agent actions. Push forward is real (POST /babysit); New
// task is still a stub (REQUEST-v3-full.md §1): it has no backend yet. Both
// return the same ActionOutcome shape as api/actions.ts and report a failure
// the same way (logged, `[…]`-prefixed), so a real endpoint can replace the
// stub's body later without touching a caller.

export interface AgentActionOptions {
  log: Logger
}

export type PushForwardOptions = PostActionOptions

// What the server said happened to one click. `ok` is true only for `sent`:
// no path here reports a sweep the server did not confirm it submitted.
export type PushForwardOutcome = ActionOutcome & (
  | { result: 'sent'; planned: number }
  | { result: 'nothing' }
  | { result: 'deferred'; load1: number }
  | { result: 'failed' }
)

const PUSH_FORWARD_FAILED = 'failed'

type PushForwardResponse =
  | { outcome: 'sent'; planned: number }
  | { outcome: 'nothing' }
  | { outcome: 'load-too-high'; load1: number }

function isPushForwardResponse(body: unknown): body is PushForwardResponse {
  if (typeof body !== 'object' || body === null) return false
  const candidate = body as Record<string, unknown>
  if (candidate.outcome === 'nothing') return true
  if (candidate.outcome === 'sent') return typeof candidate.planned === 'number'
  return candidate.outcome === 'load-too-high' && typeof candidate.load1 === 'number'
}

function pushForwardFailure(label: string): PushForwardOutcome {
  return { ok: false, result: 'failed', label }
}

// POST /babysit — asks the server to run one /pipelinely-babysit sweep. The
// server plans it first and writes nothing when the load is too high or there
// is nothing to push, so each of those is its own outcome rather than a success.
export async function pushForward({ fetchImpl, log }: PushForwardOptions): Promise<PushForwardOutcome> {
  try {
    const res = await fetchImpl('/babysit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      const reason = typeof (body as { error?: unknown } | null)?.error === 'string' ? (body as { error: string }).error : `HTTP ${res.status}`
      log('[agent-action] pushForward failed', new Error(reason))
      return pushForwardFailure(reason)
    }
    if (!isPushForwardResponse(body)) {
      log('[agent-action] pushForward failed', new Error('unrecognised /babysit response'))
      return pushForwardFailure(PUSH_FORWARD_FAILED)
    }
    switch (body.outcome) {
      case 'sent':
        return { ok: true, result: 'sent', planned: body.planned, label: '✓' }
      case 'nothing':
        return { ok: false, result: 'nothing', label: 'nothing' }
      case 'load-too-high':
        return { ok: false, result: 'deferred', load1: body.load1, label: 'deferred' }
    }
  } catch (err) {
    log('[agent-action] pushForward failed', err)
    return pushForwardFailure(PUSH_FORWARD_FAILED)
  }
}

export interface NewTaskRequest {
  prompt: string
  // null when the board has no project to offer.
  project: string | null
}

// TODO: dispatch a Planning session for real (e.g. through the existing
// /backlog/dispatch path) — QUESTIONS #4. The blank-prompt check stays: it is
// the one failure a stub can have, and the modal already gates on it.
export async function startTaskInClaude({ prompt }: NewTaskRequest, { log }: AgentActionOptions): Promise<ActionOutcome> {
  if (prompt.trim() === '') {
    log('[agent-action] startTaskInClaude failed', new Error('empty prompt'))
    return { ok: false, label: 'empty prompt' }
  }
  // The modal closes on success, so say why nothing follows it.
  log('[agent-action] startTaskInClaude is not wired yet: nothing was started')
  return { ok: true, label: '✓' }
}
