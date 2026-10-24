import type { CreaturePlacement, QaStartPolicy, Settings, Stage } from '../../../src/types'
import type { AnswerDialogReason, AnswerDialogRequestBody, AnswerDialogResponseBody } from '../../../src/answerDialogWire'
import type { Logger } from '../log'

// The typed dashboard actions (focus, mark done, shelve, merge, stage skill,
// …), one function per POST route. Every function here logs a failure
// ([action]-prefixed, matching the [snapshot] convention web/src/data uses)
// as well as surfacing it on the caller's button, so a failure is observable
// rather than only visible while the flash is up.
//
// Confirmation dialogs (markDone/shelveTask's destructive-action confirm())
// and button-level pending/disabled state stay in the calling component —
// this layer is pure fetch + typed result + logging, no DOM.

export interface PostActionOptions {
  fetchImpl: typeof fetch
  log: Logger
}

export interface ActionOutcome {
  ok: boolean
  label: string
}

export async function serverErrorOf(res: Response): Promise<string | undefined> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null
  return data?.error
}

// The 409 every dispatch route answers when the target pane is not ready to
// be typed into (a dialog is open, copy mode, no bracketed paste). The server
// names the cause and what to do; the generic label is only for a body that
// carries none.
const PANE_NOT_READY_LABEL = 'not ready — click again'

export async function paneNotReadyLabel(res: Response): Promise<string> {
  return (await serverErrorOf(res)) ?? PANE_NOT_READY_LABEL
}

function actionUrl(action: string, slug: string): string {
  return `/${action}/${encodeURIComponent(slug)}`
}

// The generic bodyless POST — every action without its own richer response
// shape (focus, browse, vscode, open-pr, handover, …) goes through this one.
export async function postAction(action: string, slug: string, { fetchImpl, log }: PostActionOptions): Promise<ActionOutcome> {
  try {
    const res = await fetchImpl(actionUrl(action, slug), { method: 'POST' })
    if (res.ok) return { ok: true, label: '✓' }
    log(`[action] POST /${action}/${slug} failed`, new Error(`HTTP ${res.status}`))
    return { ok: false, label: res.status === 404 ? 'not found' : 'failed' }
  } catch (err) {
    log(`[action] POST /${action}/${slug} failed`, err)
    return { ok: false, label: 'no server' }
  }
}

export interface MarkDoneOutcome extends ActionOutcome {
  cleanupError: string | null
}

// POST /mark-done/:slug also deletes the task's worktree/branch when it has
// one — a cleanupError there is a soft failure (the task is genuinely done
// either way), surfaced as this outcome's own label rather than overriding
// `ok`.
export async function postMarkDone(slug: string, { fetchImpl, log }: PostActionOptions): Promise<MarkDoneOutcome> {
  try {
    const res = await fetchImpl(actionUrl('mark-done', slug), { method: 'POST' })
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as { cleanupError?: string } | null
      if (data?.cleanupError) {
        log(`[action] mark-done cleanup for ${slug} failed`, new Error(data.cleanupError))
        return { ok: true, label: data.cleanupError, cleanupError: data.cleanupError }
      }
      return { ok: true, label: '✓', cleanupError: null }
    }
    log(`[action] POST /mark-done/${slug} failed`, new Error(`HTTP ${res.status}`))
    return { ok: false, label: res.status === 404 ? 'not found' : 'failed', cleanupError: null }
  } catch (err) {
    log(`[action] POST /mark-done/${slug} failed`, err)
    return { ok: false, label: 'no server', cleanupError: null }
  }
}

// POST /shelve/:slug — same cleanupError-as-soft-failure shape as
// postMarkDone, plus a server-supplied `error` field on an outright failure
// (e.g. already shelved).
export async function postShelve(slug: string, { fetchImpl, log }: PostActionOptions): Promise<MarkDoneOutcome> {
  try {
    const res = await fetchImpl(actionUrl('shelve', slug), { method: 'POST' })
    const data = (await res.json().catch(() => null)) as { cleanupError?: string; error?: string } | null
    if (res.ok) {
      if (data?.cleanupError) {
        log(`[action] shelve cleanup for ${slug} failed`, new Error(data.cleanupError))
        return { ok: true, label: data.cleanupError, cleanupError: data.cleanupError }
      }
      return { ok: true, label: '✓ shelved', cleanupError: null }
    }
    const label = data?.error || (res.status === 404 ? 'not found' : 'failed')
    log(`[action] POST /shelve/${slug} failed`, new Error(label))
    return { ok: false, label, cleanupError: null }
  } catch (err) {
    log(`[action] POST /shelve/${slug} failed`, err)
    return { ok: false, label: 'no server', cleanupError: null }
  }
}

export interface MergeBanner {
  tone: 'error' | 'warning'
  lines: string[]
}

export interface MergePrOutcome {
  merged: boolean
  cleanupError: string | null
  banner: MergeBanner | null
}

// POST /merge-pr/:slug — no success/failure button flash (a persistent merge
// banner instead, rendered by the caller from `banner`), since the caller's
// own re-render can race a flash on a button that may no longer exist
// afterward.
export async function postMergePr(slug: string, { fetchImpl, log }: PostActionOptions): Promise<MergePrOutcome> {
  try {
    const res = await fetchImpl(actionUrl('merge-pr', slug), { method: 'POST' })
    const data = (await res.json().catch(() => null)) as { prNumber?: string; cleanupError?: string; error?: string } | null
    if (res.ok) {
      if (data?.cleanupError) {
        log(`[action] merge-pr cleanup for ${slug} failed`, new Error(data.cleanupError))
        return {
          merged: true,
          cleanupError: data.cleanupError,
          banner: { tone: 'warning', lines: [`Merged PR #${data.prNumber} and marked done — cleanup needs a hand:`, ...data.cleanupError.split('; ')] },
        }
      }
      return { merged: true, cleanupError: null, banner: null }
    }
    const message = (res.status === 409 && data?.error) || data?.error || `failed (HTTP ${res.status})`
    log(`[action] POST /merge-pr/${slug} failed`, new Error(message))
    const lines = res.status === 409 && data?.error ? data.error.split('\n') : [message]
    return { merged: false, cleanupError: null, banner: { tone: 'error', lines } }
  } catch (err) {
    log(`[action] POST /merge-pr/${slug} failed`, err)
    return { merged: false, cleanupError: null, banner: { tone: 'error', lines: ['no server'] } }
  }
}

// POST /skip-stage/:slug — the one action here with a JSON body (the stage
// to skip).
export async function postSkipStage(slug: string, stage: string, { fetchImpl, log }: PostActionOptions): Promise<ActionOutcome> {
  try {
    const res = await fetchImpl(actionUrl('skip-stage', slug), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage }),
    })
    if (res.ok) return { ok: true, label: '✓ skipped' }
    log(`[action] POST /skip-stage/${slug} failed`, new Error(`HTTP ${res.status}`))
    return { ok: false, label: 'failed' }
  } catch (err) {
    log(`[action] POST /skip-stage/${slug} failed`, err)
    return { ok: false, label: 'no server' }
  }
}

// What the 409 (task left the gate) and 400 (blank notes) refusals mean to the designer.
const DESIGN_APPROVAL_FAILURE_LABEL: Record<number, string> = { 409: 'not at the gate', 400: 'notes required' }

export type DesignApprovalDecision = { decision: 'approve' } | { decision: 'request-changes'; notes: string }

// POST /design-approval/:slug — the designer's decision at the gate. The 409
// (task no longer at the gate) and 400 (blank notes) are told apart from a
// plain failure so the button can say what actually went wrong.
export async function postDesignApproval(slug: string, body: DesignApprovalDecision, { fetchImpl, log }: PostActionOptions): Promise<ActionOutcome> {
  try {
    const res = await fetchImpl(actionUrl('design-approval', slug), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) return { ok: true, label: body.decision === 'approve' ? '✓ approved' : '✓ changes requested' }
    log(`[action] POST /design-approval/${slug} failed`, new Error(`HTTP ${res.status}`))
    return { ok: false, label: DESIGN_APPROVAL_FAILURE_LABEL[res.status] ?? 'failed' }
  } catch (err) {
    log(`[action] POST /design-approval/${slug} failed`, err)
    return { ok: false, label: 'no server' }
  }
}

// FocusButton's own dispatch — the one action whose status codes each mean
// something distinct (a live reattach vs. an orchestrator-mediated resume
// vs. a pane that is not ready vs. no orchestrator vs. a read-only
// instance). postAction's generic 404/"failed"
// split would flatten all of that into one useless label.
export async function postFocus(slug: string, { fetchImpl, log }: PostActionOptions): Promise<ActionOutcome> {
  try {
    const res = await fetchImpl(actionUrl('focus', slug), { method: 'POST' })
    if (res.status === 200) return { ok: true, label: '✓' }
    if (res.status === 202) return { ok: true, label: '↻ resuming via orchestrator' }
    const label =
      res.status === 409 ? await paneNotReadyLabel(res)
      : res.status === 503 ? 'no orchestrator'
      : res.status === 403 ? 'read-only instance'
      : res.status === 404 ? 'not found'
      : 'failed'
    log(`[action] POST /focus/${slug} failed`, new Error(`HTTP ${res.status}`))
    return { ok: false, label }
  } catch (err) {
    log(`[action] POST /focus/${slug} failed`, err)
    return { ok: false, label: 'no server' }
  }
}

export interface StagingRequest extends PostActionOptions {
  url: string
  body?: Record<string, unknown>
}

// The staging POSTs (handover, help feedback) share one outcome mapping,
// "✓ sent" only when the server
// really submitted (it has the last word — a non-remote request stages
// anyway), and a failure surfaces the server's own message (a 409 is the
// pane not being ready, which the message explains). `body` is only sent (with its
// Content-Type) when given, since stageHandover's route takes none.
async function postStaging({ url, body, fetchImpl, log }: StagingRequest): Promise<ActionOutcome> {
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    })
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as { submitted?: boolean } | null
      return { ok: true, label: data?.submitted ? '✓ sent' : '✓ staged' }
    }
    const serverError = await serverErrorOf(res)
    const label = serverError
      || (res.status === 409 ? PANE_NOT_READY_LABEL : res.status === 404 ? 'not found' : 'failed')
    log(`[action] POST ${url} failed`, new Error(label))
    return { ok: false, label }
  } catch (err) {
    log(`[action] POST ${url} failed`, err)
    return { ok: false, label: 'no server' }
  }
}

// HandoverPill's task-level dispatch — a bodyless staging POST.
export function postHandover(slug: string, options: PostActionOptions): Promise<ActionOutcome> {
  return postStaging({ url: actionUrl('pipelinely-handover', slug), ...options })
}

// A stage panel's CTA: stages (or, when autoSubmit is on and the server
// agrees the request is remote, submits) the stage's skill command.
export function postStageSkill(slug: string, stage: Stage, autoSubmit: boolean, options: PostActionOptions): Promise<ActionOutcome> {
  return postStaging({ url: actionUrl('stage-skill', slug), body: { stage, autoSubmit }, ...options })
}

// POST /weekly-focus — the board's banner text. The caller
// reverts its optimistic text on a failure (showing text that was never
// persisted would read as saved), and the failure is observable.
export async function postWeeklyFocus(text: string, { fetchImpl, log }: PostActionOptions): Promise<ActionOutcome> {
  try {
    const res = await fetchImpl('/weekly-focus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (res.ok) return { ok: true, label: '✓' }
    log('[action] POST /weekly-focus failed', new Error(`HTTP ${res.status}`))
    return { ok: false, label: 'failed' }
  } catch (err) {
    log('[action] POST /weekly-focus failed', err)
    return { ok: false, label: 'no server' }
  }
}

export type TriageEndpoint = 'triage' | 'qa-triage'

// A findings/QA-failure checkbox toggle, persisted as the full selected-index
// set. A failure is logged
// and reported so the caller can put the checkbox back.
export async function postTriage(endpoint: TriageEndpoint, slug: string, selected: number[], { fetchImpl, log }: PostActionOptions): Promise<ActionOutcome> {
  try {
    const res = await fetchImpl(actionUrl(endpoint, slug), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selected }),
    })
    if (res.ok) return { ok: true, label: '✓' }
    log(`[triage] POST /${endpoint}/${slug} failed`, new Error(`HTTP ${res.status}`))
    return { ok: false, label: 'failed' }
  } catch (err) {
    log(`[triage] POST /${endpoint}/${slug} failed`, err)
    return { ok: false, label: 'no server' }
  }
}

// The header's own Handover segment: the orchestrator's session rather than
// a task's, but the identical staging contract.
export function postOrchestratorHandover(options: PostActionOptions): Promise<ActionOutcome> {
  return postStaging({ url: '/orchestrator/pipelinely-handover', ...options })
}

// The Help page's Send — stages `/pipelinely-feedback <message>` into the
// orchestrator's session, never submits it.
export function postHelpFeedback(message: string, options: PostActionOptions): Promise<ActionOutcome> {
  return postStaging({ url: '/help/pipelinely-feedback', body: { message }, ...options })
}

// POST /orchestrator/tab — the header's "bring back the orchestrator tab"
// control. Bodyless and slug-less (nothing to dispatch, just the tab), so it
// isn't postAction's `/${action}/${slug}` shape. Every non-2xx surfaces the
// server's own message (it knows whether the tab is gone, tmux is dead, or
// this is a read-only instance).
export async function postOrchestratorTab({ fetchImpl, log }: PostActionOptions): Promise<ActionOutcome> {
  try {
    const res = await fetchImpl('/orchestrator/tab', { method: 'POST' })
    if (res.ok) return { ok: true, label: '✓' }
    const data = (await res.json().catch(() => null)) as { error?: string } | null
    const label = data?.error || 'failed'
    log('[action] POST /orchestrator/tab failed', new Error(label))
    return { ok: false, label }
  } catch (err) {
    log('[action] POST /orchestrator/tab failed', err)
    return { ok: false, label: 'no server' }
  }
}

// POST /settings — the Settings page's switches, the only controls that write
// these global settings. The server merges whichever fields the patch carries.
// Returns whether the write took, so the caller can revert its optimistic
// state; the reason is logged here.
async function postSettingsPatch(patch: Partial<Settings>, { fetchImpl, log }: PostActionOptions): Promise<boolean> {
  try {
    const res = await fetchImpl('/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (res.ok) return true
    log('[settings] POST /settings failed', new Error(`HTTP ${res.status}`))
    return false
  } catch (err) {
    log('[settings] POST /settings failed', err)
    return false
  }
}

export function postAutoMode(autoMode: boolean, options: PostActionOptions): Promise<boolean> {
  return postSettingsPatch({ autoMode }, options)
}

export function postCreaturePlacement(creaturePlacement: CreaturePlacement, options: PostActionOptions): Promise<boolean> {
  return postSettingsPatch({ creaturePlacement }, options)
}

export function postWeeklyFocusEnabled(weeklyFocusEnabled: boolean, options: PostActionOptions): Promise<boolean> {
  return postSettingsPatch({ weeklyFocusEnabled }, options)
}

export function postQaStartPolicy(qaStartPolicy: QaStartPolicy, options: PostActionOptions): Promise<boolean> {
  return postSettingsPatch({ qaStartPolicy }, options)
}

// POST /task-auto-mode/:slug — one task's own auto-mode override ('auto',
// 'manual' or 'inherit' the global switch). Returns whether the write took;
// the reason is logged here.
export async function postTaskAutoMode(slug: string, override: string, { fetchImpl, log }: PostActionOptions): Promise<boolean> {
  try {
    const res = await fetchImpl(actionUrl('task-auto-mode', slug), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ override }),
    })
    if (res.ok) return true
    log(`[action] POST /task-auto-mode/${slug} failed`, new Error(`HTTP ${res.status}`))
    return false
  } catch (err) {
    log(`[action] POST /task-auto-mode/${slug} failed`, err)
    return false
  }
}

// `answered` and `unconfirmed` mean a key was sent; `no-server` and `failed`
// mean it is unknown whether one was (no response, or one this route never
// sends); every other value is the server's own refusal `reason`.
export interface AnswerDialogOutcome {
  outcome: 'answered' | 'unconfirmed' | 'no-server' | 'failed' | AnswerDialogReason
  message: string
}

// Whether each reason the route sends proves no key went out. A Record, so a
// reason added to the wire union fails to compile until it is classified here.
// send-failed can be a timeout after tmux typed the key, and internal can be
// thrown after the send, so neither proves anything.
const REASON_PROVES_NOTHING_SENT: Record<AnswerDialogReason, boolean> = {
  'not-json': true,
  remote: true,
  'bad-host': true,
  'cross-site': true,
  'not-canonical': true,
  'bad-request': true,
  'unknown-task': true,
  'session-not-owned': true,
  'no-dialog': true,
  'dialog-changed': true,
  'unknown-option': true,
  busy: true,
  'capture-failed': true,
  'audit-failed': true,
  'send-failed': false,
  internal: false,
}

function isAnswerDialogReason(value: unknown): value is AnswerDialogReason {
  return typeof value === 'string' && Object.hasOwn(REASON_PROVES_NOTHING_SENT, value)
}

// Only a refusal that proves no key went out may let the same dialog be
// answered again; anything else could make a second click type a second key.
export function isNothingSent(outcome: AnswerDialogOutcome['outcome']): boolean {
  return isAnswerDialogReason(outcome) && REASON_PROVES_NOTHING_SENT[outcome]
}

const ANSWERED_MESSAGE = 'Answered — the dialog moved on.'
const UNCONFIRMED_FALLBACK_MESSAGE = 'The key was sent, but the dialog is still showing. Check the terminal.'
const NO_SERVER_MESSAGE = 'No answer from the dashboard server, so it is unknown whether the key was sent. Check the terminal.'

function unreadableReplyMessage(status: number): string {
  return `The server's reply (HTTP ${status}) could not be read, so it is unknown whether the key was sent. Check the terminal.`
}

// POST /answer-dialog/:slug — types one key into a blocked worker's session.
// Unlike its siblings the message is the product: the card shows it as-is, so
// each branch says only what is known about whether a key went out.
export async function postAnswerDialog(slug: string, request: AnswerDialogRequestBody, { fetchImpl, log }: PostActionOptions): Promise<AnswerDialogOutcome> {
  const route = `[action] POST /answer-dialog/${slug}`
  try {
    const res = await fetchImpl(actionUrl('answer-dialog', slug), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: request.session, option: request.option, fingerprint: request.fingerprint }),
    })
    const data = (await res.json().catch(() => null)) as AnswerDialogResponseBody | null
    // A 200 from anything but this route (a proxy, an SPA fallback) carries
    // no `answered` body, and must not read as a key that landed.
    if (res.status === 200) {
      if (data?.outcome === 'answered') return { outcome: 'answered', message: ANSWERED_MESSAGE }
      log(`${route} failed`, new Error(`HTTP 200 without an answered outcome: ${JSON.stringify(data)}`))
      return { outcome: 'failed', message: unreadableReplyMessage(res.status) }
    }
    if (res.status === 202) {
      const message = data?.error || UNCONFIRMED_FALLBACK_MESSAGE
      log(`${route} unconfirmed`, new Error(message))
      return { outcome: 'unconfirmed', message }
    }
    const reason = data?.reason
    const message = data?.error
    if (!isAnswerDialogReason(reason) || !message) {
      log(`${route} failed`, new Error(`HTTP ${res.status} without a known refusal: ${JSON.stringify(data)}`))
      return { outcome: 'failed', message: unreadableReplyMessage(res.status) }
    }
    log(`${route} failed`, new Error(`${reason}: ${message}`))
    return { outcome: reason, message }
  } catch (err) {
    log(`${route} failed`, err)
    return { outcome: 'no-server', message: NO_SERVER_MESSAGE }
  }
}

// DELETE /api/bookmarks/:id — removes the bookmark's file. A bookmark that is
// already gone (404) is what the caller wanted, so it counts as done. The log
// carries the id only, never the bookmark's content. `keepalive` lets the
// request outlive a page that is closing, which is when a pending delete is
// flushed.
export async function requestBookmarkDelete(id: string, { fetchImpl, log }: PostActionOptions): Promise<ActionOutcome> {
  const url = `/api/bookmarks/${encodeURIComponent(id)}`
  try {
    const res = await fetchImpl(url, { method: 'DELETE', keepalive: true })
    if (res.ok || res.status === 404) return { ok: true, label: '✓' }
    log(`[action] DELETE ${url} failed`, new Error(`HTTP ${res.status}`))
    return { ok: false, label: 'failed' }
  } catch (err) {
    log(`[action] DELETE ${url} failed`, err)
    return { ok: false, label: 'no server' }
  }
}
