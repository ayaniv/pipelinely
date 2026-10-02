import type { BacklogItem } from '../../../src/types'
import type { ActionOutcome, PostActionOptions } from './actions'

// The backlog panel's typed fetches (dispatch, resume, dismiss, edit, batch
// dispatch) — pure fetch + typed outcome + logging, no DOM, same contract as
// actions.ts. Every failure is surfaced on the button and also logged with the
// [action] prefix.
//
// The item posted back as `original` is the server's concurrency guard: it
// rewrites BACKLOG.md by line index, so it must refuse when the line at
// that index is no longer the item the developer was looking at (a 409).

// What /backlog/dispatch and /batch-dispatch both take per item — the one
// projection, so the single Run and the batch Run can't drift apart.
export interface BacklogDispatchItem {
  description: string
  context: string | null
  project: string | null
}

export function backlogDispatchPayload(item: BacklogItem): BacklogDispatchItem {
  return { description: item.description, context: item.context, project: item.project }
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

function postJson(fetchImpl: typeof fetch, url: string, body: unknown): Promise<Response> {
  return fetchImpl(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) })
}

async function serverErrorOf(res: Response): Promise<string | undefined> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null
  return data?.error
}

// Pastes the item into the orchestrator session as "let's do this". Each
// status means something distinct (a reattach race vs. no orchestrator vs. a
// read-only instance) — a generic "failed" would flatten it.
export async function postBacklogDispatch(item: BacklogItem, { fetchImpl, log }: PostActionOptions): Promise<ActionOutcome> {
  try {
    const res = await postJson(fetchImpl, '/backlog/dispatch', backlogDispatchPayload(item))
    if (res.ok) return { ok: true, label: '✓ sent' }
    log('[action] POST /backlog/dispatch failed', new Error(`HTTP ${res.status}`))
    const label =
      res.status === 409 ? 'reattached — click again'
      : res.status === 503 ? 'no orchestrator'
      : res.status === 403 ? 'read-only instance'
      : 'failed'
    return { ok: false, label }
  } catch (err) {
    log('[action] POST /backlog/dispatch failed', err)
    return { ok: false, label: 'no server' }
  }
}

// Puts a shelved entry back on the board (never touches the orchestrator).
// The server's own message is kept verbatim — "that task directory is gone"
// is worth reading in full.
export async function postBacklogResume(index: number, item: BacklogItem, { fetchImpl, log }: PostActionOptions): Promise<ActionOutcome> {
  const url = `/backlog/resume/${index}`
  try {
    const res = await postJson(fetchImpl, url, { original: item })
    if (res.ok) return { ok: true, label: '✓ resumed' }
    const label = (await serverErrorOf(res)) || 'failed'
    log(`[action] POST ${url} failed`, new Error(label))
    return { ok: false, label }
  } catch (err) {
    log(`[action] POST ${url} failed`, err)
    return { ok: false, label: 'no server' }
  }
}

export async function postBacklogDismiss(index: number, item: BacklogItem, { fetchImpl, log }: PostActionOptions): Promise<ActionOutcome> {
  const url = `/backlog/dismiss/${index}`
  try {
    const res = await postJson(fetchImpl, url, { original: item })
    if (res.ok) return { ok: true, label: '✓ removed' }
    log(`[action] POST ${url} failed`, new Error(`HTTP ${res.status}`))
    return { ok: false, label: res.status === 409 ? 'changed elsewhere — refresh' : 'failed' }
  } catch (err) {
    log(`[action] POST ${url} failed`, err)
    return { ok: false, label: 'no server' }
  }
}

export interface BacklogEdit {
  description: string
  date: string | null
  context: string | null
  project: string | null
  original: BacklogItem
}

export type BacklogEditOutcome = { ok: true } | { ok: false; message: string }

export const BACKLOG_EDIT_FALLBACK_MESSAGE = 'Save failed — see server logs.'

// Keyed by the server's `{ error }` body from POST /backlog/edit/:index — see
// formatBacklogItemLine's two refusals in src/taskParser.ts. Any other (or
// missing) code falls back to the generic message.
const BACKLOG_EDIT_400_MESSAGES: Record<string, string> = {
  'invalid-project': 'Project must be a single word (letters, digits, -, _, .).',
  'project-collision': "An untagged description can't start with a bracketed word. Set it as the project instead.",
}

export async function postBacklogEdit(index: number, edit: BacklogEdit, { fetchImpl, log }: PostActionOptions): Promise<BacklogEditOutcome> {
  const url = `/backlog/edit/${index}`
  try {
    const res = await postJson(fetchImpl, url, edit)
    if (res.ok) return { ok: true }
    log(`[action] POST ${url} failed`, new Error(`HTTP ${res.status}`))
    if (res.status === 409) return { ok: false, message: 'This item changed elsewhere — refresh and try again.' }
    if (res.status === 400) {
      const code = await serverErrorOf(res)
      return { ok: false, message: (code && BACKLOG_EDIT_400_MESSAGES[code]) || BACKLOG_EDIT_FALLBACK_MESSAGE }
    }
    return { ok: false, message: BACKLOG_EDIT_FALLBACK_MESSAGE }
  } catch (err) {
    log(`[action] POST ${url} failed`, err)
    return { ok: false, message: 'Save failed — no response from server.' }
  }
}

export interface BatchDispatchOutcome extends ActionOutcome {
  // The server's own explanation for a 409/503, shown as the button's tooltip.
  detail?: string
}

// A batch is either backlog items or one milestone wave's child slugs.
export type BatchDispatchBody =
  | { kind: 'backlog'; items: BacklogDispatchItem[] }
  | { kind: 'wave'; slugs: string[] }

// The one path both batches take (the backlog's batch Run and a wave's Run
// wave). Stages — never submits: what lands in the orchestrator is an unsent
// command the developer reads and sends themselves. Every failure maps onto
// the same label set the single Run uses.
export async function postBatchDispatch(body: BatchDispatchBody, { fetchImpl, log }: PostActionOptions): Promise<BatchDispatchOutcome> {
  try {
    const res = await postJson(fetchImpl, '/batch-dispatch', body)
    if (res.ok) return { ok: true, label: 'staged' }
    log('[action] POST /batch-dispatch failed', new Error(`HTTP ${res.status}`))
    if (res.status === 409) return { ok: false, label: 'reattached — retry', detail: await serverErrorOf(res) }
    if (res.status === 503) return { ok: false, label: 'no orchestrator', detail: await serverErrorOf(res) }
    return { ok: false, label: 'failed' }
  } catch (err) {
    log('[action] POST /batch-dispatch failed', err)
    return { ok: false, label: 'no server' }
  }
}
