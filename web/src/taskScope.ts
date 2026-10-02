import type { MilestoneStatus, Task } from '../../src/types'
import { parsePrNumberFromReviewRef } from '../../src/prNumber'
import { computeCost, costIsPriced, formatTokens, modelShort } from './format'
import { STAGE_CHAIN_GROUPS, STAGE_TO_CHAIN_ID } from './pipelineStages'

// Pure derivations off already-typed Task data: a task's scope (which
// sessions a stat grid sums), its detail-header meta pairs and status line,
// and the mini stage rail. Anything that reads or writes shared mutable
// client state (off-focus, merge state, …) is NOT here — it lives in
// data/clientState.ts.

export function isFanoutParent(task: Task): boolean {
  return Array.isArray(task.milestones) && task.milestones.length > 0
}

// The PR number the client acts on: reviewRef (an explicit PR URL or number), then task.prNumber.
// The server already folds the branch-derived PR and a strict TIMELINE-note
// match into task.prNumber (attachResolvedPrNumbers), so this deliberately
// does NOT scan free-text notes itself — that scan is what let a note
// mentioning a merged upstream PR hijack the card.
export function findPrNumber(task: Task): string | null {
  return parsePrNumberFromReviewRef(task.reviewRef) ?? (task.prNumber || null)
}

export interface ScopeRow {
  s: Task['sessions'][number]
  slug: string
  // Which milestone the row came from, in a roll-up; null everywhere else.
  prefix: string | null
  model: string | undefined
}

export interface Scope {
  rows: ScopeRow[]
  ctx: number | null
  ctxLive: boolean
  model: string | undefined
  // The CTX tile's sub-label naming the hottest session; roll-up scopes only.
  ctxSub: string | null
}

// Each row pairs a session with where it came from, so the CTX sub-label and
// the breakdown rows can say which milestone is hot. The model rides along
// per row: a roll-up spans sessions that may have run on different models,
// and costing all of them at the parent's rate would be a lie.
function scopeRows(task: Task, prefix: string | null): ScopeRow[] {
  return task.sessions.map((s) => ({ s, slug: task.slug, prefix, model: task.model }))
}

// A single task's own scope must show task.contextPct (server-computed from
// the newest session), not the highest contextPct ever recorded across its
// history: a handover that ended at 90% followed by a short session that
// wrapped up at 15% must read 15%. `current` is set on at most one session,
// the headline one, so "some row is current" is exactly "the headline
// session is live".
export function taskScope(task: Task): Scope {
  const rows = scopeRows(task, null)
  return { rows, ctx: task.contextPct ?? null, ctxLive: rows.some((r) => r.s.current), model: task.model, ctxSub: null }
}

// Same "newest, not hottest" rule as taskScope, off the milestone child's own
// already-computed contextPct.
export function milestoneScope(milestone: MilestoneStatus): Scope {
  if (!milestone.task) return { rows: [], ctx: null, ctxLive: false, model: undefined, ctxSub: null }
  return taskScope(milestone.task)
}

// "qa" beats "#3": the stage a session ran is what the reader is looking for.
// Falls back to the handover index for sessions that have no stage recorded.
export function rowLabel(row: ScopeRow): string {
  const name = row.s.stage ? row.s.stage.replace(/-/g, ' ') : `#${row.s.n}`
  return row.prefix ? `${row.prefix} · ${name}` : name
}

// The session closest to the context wall, across a whole scope. Live
// sessions win outright — an idle session at 92% needs nothing, a live one at
// 80% needs a handover. With no live session anywhere, fall back to the
// hottest known one and say so. Used by the roll-up only: a task's own scope
// intentionally does NOT use this (see taskScope).
function hottestRow(rows: ScopeRow[]): { row: ScopeRow; isLive: boolean } | null {
  const withCtx = rows.filter((r) => r.s.contextPct !== null && r.s.contextPct !== undefined)
  const live = withCtx.filter((r) => r.s.current)
  const pool = live.length ? live : withCtx
  if (!pool.length) return null
  return { row: pool.reduce((a, b) => ((b.s.contextPct ?? 0) > (a.s.contextPct ?? 0) ? b : a)), isLive: live.length > 0 }
}

// The wave overview's project-wide total — a parent's own sessions plus every
// dispatched milestone's. The ONE place a roll-up is appropriate: every card,
// including the fan-out parent's own, uses taskScope/milestoneScope only.
// Unlike those two, a roll-up's CTX wants "hottest session anywhere in the
// scope", since no single task.contextPct answers that for a whole wave.
export function rollupScope(task: Task): Scope {
  const rows = scopeRows(task, null)
  for (const milestone of task.milestones ?? []) {
    if (milestone.task) rows.push(...scopeRows(milestone.task, milestone.id))
  }
  const hottest = hottestRow(rows)
  return {
    rows,
    ctx: hottest ? hottest.row.s.contextPct : null,
    ctxLive: hottest ? hottest.isLive : false,
    // The newest session's model is the most useful single answer here.
    model: (rows.filter((r) => r.s.current).slice(-1)[0] ?? rows.slice(-1)[0])?.model ?? task.model,
    ctxSub: hottest ? `${hottest.isLive ? 'hottest live' : 'last known'} · ${rowLabel(hottest.row)}` : null,
  }
}

// Cost is summed per row at that row's own model rate, never one blended
// rate. Null when no row has a model we have rates for, which renders "—".
export function scopeCost(rows: ScopeRow[]): number | null {
  let cost = 0
  let isPriced = false
  for (const r of rows) {
    if (r.model && costIsPriced(r.model)) {
      cost += computeCost(r.s.inputTokens || 0, r.s.outputTokens || 0, r.model)
      isPriced = true
    }
  }
  return isPriced ? cost : null
}

export interface ScopeTotals {
  rows: ScopeRow[]
  inp: number
  out: number
  cost: number | null
  costStr: string
}

// The one place that reduces tokens across scope.rows and formats the dollar
// figure, so every stat grid agrees on what "this scope's cost" means.
export function scopeTotals(scope: Scope): ScopeTotals {
  const rows = scope.rows
  const inp = rows.reduce((sum, r) => sum + (r.s.inputTokens || 0), 0)
  const out = rows.reduce((sum, r) => sum + (r.s.outputTokens || 0), 0)
  const cost = scopeCost(rows)
  return { rows, inp, out, cost, costStr: cost === null ? '—' : `$${cost.toFixed(2)}` }
}

// The four labeled mono pairs the detail head's meta row renders — wraps
// taskScope+scopeTotals.
export function detailMetaPairs(task: Task): [string, string][] {
  const scope = taskScope(task)
  const { rows, inp, out, costStr } = scopeTotals(scope)
  return [
    ['tok', formatTokens(inp + out)],
    ['cost', costStr],
    ['sessions', String(rows.length || 1)],
    ['model', modelShort(scope.model)],
  ]
}

export type PillStatusKey = 'working' | 'needs-you' | 'paused' | 'idle' | 'waiting' | 'done'

export interface StatusMeta {
  label: string
  dot: string
  fg: string
  bg: string
}

// The design's own header status pill palette — used by the session card,
// the dev/milestone card and the detail header alike.
export const CARD_STATUS_META: Record<PillStatusKey, StatusMeta> = {
  working: { label: 'Working', dot: 'var(--accent)', fg: 'var(--accentInk)', bg: 'var(--accentSoft)' },
  'needs-you': { label: 'Needs you', dot: 'var(--amber)', fg: 'var(--amberInk)', bg: 'var(--amberSoft)' },
  paused: { label: 'Paused', dot: 'var(--text3)', fg: 'var(--text2)', bg: 'var(--surface2)' },
  idle: { label: 'Idle', dot: 'var(--text3)', fg: 'var(--text2)', bg: 'var(--surface2)' },
  waiting: { label: 'Orphaned?', dot: 'var(--amber)', fg: 'var(--amberInk)', bg: 'var(--amberSoft)' },
  done: { label: 'Done', dot: 'var(--sage)', fg: 'var(--sageInk)', bg: 'var(--sageSoft)' },
}

// Orphaned still overrides attentionStatus, same as before: cockpit-ai
// can't know whether the work finished or was abandoned.
export function pillStatusFor(task: Task): PillStatusKey {
  if (task.status === 'done') return 'done'
  if (task.orphaned) return 'waiting'
  return task.attentionStatus
}

export interface DetailStatusTag {
  label: string
  bg: string
  fg: string
}

export interface DetailStatusInfo {
  key: PillStatusKey
  meta: StatusMeta
  isWorking: boolean
  tag: DetailStatusTag | null
}

// isOffFocus is passed in (not read from shared state here) so this stays a
// pure function — the caller sources it from data/clientState.ts.
export function detailStatusInfo(task: Task, isOffFocus: boolean): DetailStatusInfo {
  const key = pillStatusFor(task)
  const meta = CARD_STATUS_META[key] ?? CARD_STATUS_META.idle
  const isWorking = key === 'working'
  const merged = task.status === 'done' && task.stageHistory.some((e) => e.stage === 'merge')
  const tag: DetailStatusTag | null =
    isOffFocus && key !== 'done'
      ? { label: 'off focus', bg: 'var(--driftSoft)', fg: 'var(--driftInk)' }
      : merged
        ? { label: 'merged', bg: 'var(--sageSoft)', fg: 'var(--sageInk)' }
        : null
  return { key, meta, isWorking, tag }
}

// A stage value's chain node id, folded into its parent node (plan-review
// into planning, the *-fixes stages into cr/qa) — the same grouping the stage
// chain uses, so a task stuck on 'cr-fixes' still lights the 'cr' node.
export function miniStageId(stage: string): string {
  const chainId: string = (STAGE_TO_CHAIN_ID as Record<string, string>)[stage] || stage
  for (const [parent, children] of Object.entries(STAGE_CHAIN_GROUPS)) {
    if ((children as string[]).includes(chainId)) return parent
  }
  return chainId
}

export interface MiniStageNode {
  label: string
  isDone: boolean
  isCurrent: boolean
  flex: string
  hasConnector: boolean
  connector: string
  ring: string
  bg: string
  fg: string
  glyph: string
}

// Decorative-only mini stage rail (session/dev card's 16px-node row) — NOT
// the interactive stage chain, which tracks its own click-selection state.
export function miniStageNodes(task: Pick<Task, 'status' | 'stage' | 'stageHistory'>, stageIds: string[]): MiniStageNode[] {
  const reachedIds = new Set((task.stageHistory || []).map((e) => miniStageId(e.stage)))
  const isFinished = task.status === 'done'
  const currentId = isFinished ? null : task.stage ? miniStageId(task.stage) : null
  const curIdx = currentId ? stageIds.indexOf(currentId) : isFinished ? stageIds.length : -1
  return stageIds.map((id, i) => {
    const isDone = isFinished ? reachedIds.has(id) : i < curIdx
    const isCurrent = !isFinished && i === curIdx
    return {
      label: id,
      isDone,
      isCurrent,
      flex: i === 0 ? '0 0 auto' : '1 1 auto',
      hasConnector: i > 0,
      connector: isDone || isCurrent || (isFinished && i <= curIdx) ? 'var(--accent)' : 'var(--border2)',
      ring: isDone || isCurrent ? '1.5px solid var(--accent)' : '1.5px solid var(--border2)',
      bg: isDone ? 'var(--accent)' : 'transparent',
      fg: isDone ? 'var(--surface)' : 'var(--text3)',
      glyph: isDone ? '✓' : '',
    }
  })
}

// The design's own board-card pill names the STAGE (Planning/Dev/Code review/
// QA/Merge), not the attention state — attention is carried by the pill's
// color alone. Reuses miniStageId's plan-review/*-fixes fold, so a task
// mid-fixes still reads as its parent stage.
const CARD_STAGE_LABEL: Record<string, string> = { planning: 'Planning', dev: 'Dev', cr: 'Code review', qa: 'QA', merge: 'Merge' }

export function cardStageLabel(task: Pick<Task, 'stage'>): string | null {
  if (!task.stage) return null
  return CARD_STAGE_LABEL[miniStageId(task.stage)] ?? null
}

// The predicate for "an active (non-done, on-board) task" — the header's spend pill is org-level, so it sums every
// active task, not the board's own project/state-filtered subset.
export function activeTasksOf(tasks: Task[]): Task[] {
  return tasks.filter((task) => task.status !== 'done' && task.showsOnBoard)
}

// A task with no priced METRICS (scopeTotals reports a null cost) contributes
// nothing to the sum.
export function sumScopeCost(tasks: Task[]): number {
  return tasks.reduce((sum, task) => sum + (scopeTotals(taskScope(task)).cost ?? 0), 0)
}
