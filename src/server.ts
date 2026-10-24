import os from 'node:os'
import express from 'express'
import chokidar from 'chokidar'
import { createApprovalPollState, createApprovalTicker, pollApprovalPrompts, productionApprovalWatchDeps } from './approvalWatch.js'
import type { ApprovalPrompt } from './approvalPrompt.js'
import {
  computeActiveProject,
  parseBacklog,
  groupDoneTasksByDate,
  STAGE_SKILL,
  SKIP_STAGE,
  composeStageCommand,
  applyBacklogEdit,
  applyBacklogRemoval,
  applyBacklogShelveEntry,
  findResumableBacklogSlug,
  localDateKey,
  reposDir,
  buildDeadSessionMessage,
  findPrNumber,
  parseQaCaseTitles,
  readSettings,
  computeAutoDispatch,
  recordQaSkipped,
  appendTimelineLine,
  DEFAULT_SETTINGS,
  parseSummarySection,
  stripSummarySection,
  parseOrchestratorMetrics,
  isBacklogProject,
  isCreaturePlacement,
} from './taskParser.js'
import { assignMissingCreatures } from './creature.js'
import type { PlanTestGroup } from './types.js'
import { runAutoActions } from './autoActions.js'
import { renderMarkdownToHtml } from './markdown.js'
import { loadStageScopes } from './stageScope.js'
import {
  reattachOrFocus,
  openVSCode,
  openBrowserUrl,
  reattachAndRecord,
  findSessionAttachedToTmux,
  openAnnotationSession,
  focusITermTab,
  normalizeWhitespace,
} from './focusTab.js'
import { commitAndRemoveWorktree, findPrByBranch, openPrInBrowser, readPrHeadBranch } from './gitOps.js'
import { loadTasks, type TaskLookups } from './loadTasks.js'
import { createPrMergeStateCache, createPrNumberCache, repoPrMergeStateLookup, repoPrNumberLookup } from './prLookup.js'
import { applyDesignApproval } from './designApproval.js'
import { resolveDesignQaAsset } from './designQaAssets.js'
import { markTaskDone, mergeTask } from './taskCompletion.js'
import { formatBranchMismatch, formatMergeBlockers, readPrMergeState } from './mergeGate.js'
import { effectiveWeeklyFocus, isWeeklyFocusEnabled, readStoredWeeklyFocus, WEEKLY_FOCUS_FILE } from './weeklyFocus.js'
import { writeTextToTmuxSession, type TmuxPaneWriteResult, type TmuxPaneWriteRefusal, type TmuxPaneWriteStep } from './tmuxPaneWrite.js'
import { withOrchestratorLock, OrchestratorLockTimeoutError } from './orchestratorLock.js'
import { composeBatchMessage, SAFE_TOKEN, renderBacklogProjectClause } from './batchDispatch.js'
import { ActiveProjectProgress, AutoModeOverride, BacklogItem, DoneDateGroup, Settings, Snapshot, Stage, Task } from './types.js'
import path from 'path'
import fs from 'node:fs/promises'
import type { Server } from 'node:http'
import open from 'open'
import { fileURLToPath } from 'url'
import { defaultPortForCwd } from './derivePort.js'
import { resolveBindHosts, listenOnHosts, wideBindWarnings, dashboardUrl } from './bindHosts.js'
import { resolveTasksDir } from './tasksDir.js'
import { requestIsRemote } from './remoteAccess.js'
import { checkAnswerDialogRequest } from './answerDialogGuard.js'
import { answerDialog, productionDialogAnswerDeps } from './dialogAnswer.js'
import { readOrchestratorTmux } from './orchestratorTmux.js'
import { BAD_REQUEST_RESPONSE, UNKNOWN_TASK_RESPONSE, parseAnswerBody, responseForAnswerResult, responseForGuardRefusal } from './answerDialogRoute.js'
import type { AnswerDialogResponseBody } from './answerDialogWire.js'
import { installRemoteAuth, requestAccess } from './remoteAuth.js'
import { deleteBookmark, isBookmarkId, listBookmarks, resolveBookmarksDir } from './bookmarks.js'
import { REMOTE_TOKEN_FILE_ENV_VAR, readRemoteToken, resolveRemoteTokenPath } from './remoteToken.js'
import { sanitizeInheritedEnv, SERVER_STARTUP_LEAK_VARS } from './sanitizeInheritedEnv.js'
import { findResultDoc } from './resultDoc.js'
import { decisionContext, dispatchTimelineNote, isQaStartPolicy, planSweep } from './nextAction.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// This server is long-lived and is routinely started (by hand, or via `npm
// run dev`) in an iTerm2 tab that was previously used for something else —
// a Playwright e2e run, a dispatched worker session — and none of these four
// are ever cleared once set, so they'd otherwise silently ride along forever.
// Deliberately excludes REPOS_DIR/TASKS_DIR/WORKTREES_DIR: those three ARE
// legitimately set on this exact process by playwright.config.ts's
// webServer.env to point an e2e run at fixture directories, so stripping
// them here would break that sanctioned override rather than a leak. Must
// run before the TASKS_DIR read below, and before anything else reads
// process.env.
sanitizeInheritedEnv(SERVER_STARTUP_LEAK_VARS)

// Orchestrator/pipelinely-handover task state is the cockpit's own responsibility, so it
// defaults under the cockpit-ai checkout (gitignored — ephemeral local state)
// for the canonical checkout only — a worktree with no explicit TASKS_DIR
// throws rather than silently binding the real one (see tasksDir.ts).
const TASKS_DIR = resolveTasksDir(process.cwd(), process.env.TASKS_DIR)

// Distinguishes "the one real dashboard" from any other process running this
// same src/server.ts — a worktree's own local preview server, an e2e test's
// webServer, etc. Those all default to the exact same real TASKS_DIR above
// regardless of which worktree they physically run from, so nothing but an
// explicit signal tells them apart — and every one of them was, until now,
// equally able to paste real text into the developer's live orchestrator
// terminal (see TASK.md). Only the pipelinely skill's own dev-server
// launch step sets this; env-var gated, matching this file's existing
// TASKS_DIR/REPOS_DIR/WORKTREES_DIR/PORT convention, rather than
// __dirname-sniffing an assumed canonical checkout path — that would break
// for anyone whose canonical checkout isn't at the exact expected path.
// Read live (not cached at module load) so tests can flip it per-case
// without re-importing the module.
function isCanonicalDispatchInstance(): boolean {
  return process.env.COCKPIT_DISPATCH_ENABLED === '1'
}

const NOT_CANONICAL_ERROR =
  'This dashboard instance is not the canonical orchestrator dashboard, so dispatch actions are disabled here — only the instance started by the pipelinely skill can write into the orchestrator session.'

// 3030 for the canonical checkout (unchanged, still bookmarkable); a port
// stably derived from cwd for any worktree — several task dev servers can be
// alive at once across concurrent worktrees, and without this they all
// picked the same literal default, so whichever bound first silently
// answered every other worktree's requests too (see derivePort.ts). The
// derived range (3030-3529) is disjoint from playwright.config.ts's own
// derived range so a worktree's dev server and its own e2e webServer, both
// commonly alive at once, can never collide with each other either.
const PORT = parseInt(process.env.PORT ?? String(defaultPortForCwd(process.cwd(), 3030, 3030, 500)), 10)
// Resolved off __dirname, the same way `GET /` resolves public/dist/index.html —
// deliberately not TASKS_DIR/REPOS_DIR (env vars, and stale fixture paths
// are known to leak into iTerm2 tabs through them). A worktree's own server
// reads that worktree's own .claude/skills, previewing its own skill edits;
// the canonical checkout reads the exact skill bytes Claude Code actually
// runs (see stageScope.ts's own comment on the symlink chain).
const SKILLS_DIR = path.join(__dirname, '..', '.claude', 'skills')
const ENGINEERING_CONSTRAINTS_PATH = path.join(__dirname, '..', 'docs', 'engineering-constraints.md')
// Read live (not cached at module load), mirroring reposDir()/worktreesDir()
// in taskParser.ts — the one other way to swap in a fixture would be
// mutating the real docs/user-guide.md, which would race docsGuide.test.ts
// reading it in a concurrent vitest worker.
function docsGuidePath(): string {
  return process.env.DOCS_GUIDE_PATH
    ? path.resolve(process.env.DOCS_GUIDE_PATH)
    : path.join(__dirname, '..', 'docs', 'user-guide.md')
}
const WEEKLY_FOCUS_PATH = path.join(TASKS_DIR, WEEKLY_FOCUS_FILE)
// BACKLOG.md is a sibling file at the top of TASKS_DIR, not a task
// subdirectory — parsed separately from parseAllTasks.
const BACKLOG_PATH = path.join(TASKS_DIR, 'BACKLOG.md')
// Written by the /pipelinely skill on startup — its own iTerm2 session
// id, so the backlog's "Start" button knows which tab to paste into.
const ORCHESTRATOR_SESSION_PATH = path.join(TASKS_DIR, 'ORCHESTRATOR_SESSION')
// Orchestrator-level preferences — see readSettings/parseSettingsContent in
// taskParser.ts. Currently just the global auto-mode default.
const SETTINGS_PATH = path.join(TASKS_DIR, 'SETTINGS.json')

// The literal slash-command text both Handover routes stage. /pipelinely-handover is a
// Claude Code skill the receiving session runs itself, not a dashboard route.
const HANDOVER_COMMAND = '/pipelinely-handover'

// The literal slash-command text POST /help/pipelinely-feedback stages. Spelled with
// cockpit-ai's own skill name, exactly like HANDOVER_COMMAND above —
// oss/lib.sh rewrites /pipelinely-feedback to /pipelinely-feedback at publish time, so
// the published build stages the right name without a second spelling
// living here.
const HELP_FEEDBACK_COMMAND = '/pipelinely-feedback'

type OrchestratorWriteResult =
  | { status: 'ok' }
  | { status: 'stray-process' }
  | { status: 'locked' }
  | { status: 'not-canonical' }
  | { status: 'not-tmux-backed' }
  | { status: 'pane-not-ready'; reason: PaneNotReadyReason }
  | { status: 'write-failed'; step: TmuxPaneWriteStep; error: string }
  | { status: 'write-rejected'; reason: WriteRejectedReason }

// How a write is delivered: 'send' types and submits without raising iTerm2,
// 'stage' types and leaves the command unsent for review, then brings the tab
// forward so the developer can find it.
type DispatchWriteMode = 'send' | 'stage'

function shouldSubmitMode(mode: DispatchWriteMode): boolean {
  return mode !== 'stage'
}

// Retrying cannot help: the cause is the text or a corrupt pointer file, not
// the state of the pane.
type WriteRejectedReason = Extract<TmuxPaneWriteRefusal, 'unsafe-text' | 'unsafe-session-name'>
type PaneNotReadyReason = Exclude<TmuxPaneWriteRefusal, 'stray-shell' | 'no-pane' | WriteRejectedReason>

// Maps a tmux writer outcome onto the statuses the routes know. A stray shell
// is a 503, and a missing pane reads as "not tmux-backed": either way the
// recorded tmux session is not a live claude to type into, and there is no
// keystroke fallback.
function toTmuxWriteFailure(result: Exclude<TmuxPaneWriteResult, { status: 'ok' }>): TmuxWriteFailure {
  if (result.status === 'failed') return { status: 'write-failed', step: result.step, error: result.error }
  if (result.reason === 'stray-shell') return { status: 'stray-process' }
  if (result.reason === 'no-pane') return { status: 'not-tmux-backed' }
  if (result.reason === 'unsafe-text' || result.reason === 'unsafe-session-name') return { status: 'write-rejected', reason: result.reason }
  return { status: 'pane-not-ready', reason: result.reason }
}

// After a tmux write landed: keep the pointer file on the tab that is really
// attached to the session (→ Terminal reads it), and for a staged command
// bring that tab forward — reattaching one if none is attached, since a
// staged command nobody can find is useless. Never changes the outcome: the
// text is already in the pane, so a failure here is only logged.
async function surfaceTmuxSessionTab(tmuxSession: string, sessionFilePath: string, shouldFocus: boolean): Promise<string | null> {
  try {
    let tabId = await findSessionAttachedToTmux(tmuxSession)
    if (tabId) await fs.writeFile(sessionFilePath, tabId)
    else if (shouldFocus) tabId = await reattachAndRecord(tmuxSession, sessionFilePath)
    if (tabId && shouldFocus) await focusITermTab(tmuxSession, tabId)
    return tabId
  } catch (err) {
    console.error(`[tmux-dispatch] wrote to ${tmuxSession} but could not surface its tab:`, err)
    return null
  }
}

const TASK_NOT_TMUX_BACKED_ERROR =
  "This task's tab is not tmux-backed (no TMUX_SESSION recorded or the session is gone), so nothing was typed. Dispatch writes need tmux."

const NOT_TMUX_BACKED_ERROR =
  'Orchestrator is not running inside tmux (or its recorded tmux session is gone) — start it with `orch`. Dispatch writes need tmux.'

const PANE_NOT_READY_ERROR: Record<PaneNotReadyReason, string> = {
  'dialog-open': 'The pane is showing a dialog — answer it first, then click again.',
  'pane-in-mode': 'The pane is in copy mode — leave it, then click again.',
  'no-bracketed-paste': 'The pane has not turned on bracketed paste, so nothing was typed.',
}

const WRITE_REJECTED_ERROR: Record<WriteRejectedReason, string> = {
  'unsafe-text': 'The text contains control characters that cannot be pasted safely, so nothing was typed. Retrying will not help.',
  'unsafe-session-name': 'The recorded tmux session name is not safe to address (check the ORCHESTRATOR_TMUX / TMUX_SESSION file), so nothing was typed. Retrying will not help.',
}

type TmuxOnlyFailure = Extract<OrchestratorWriteResult, { status: 'not-tmux-backed' | 'pane-not-ready' | 'write-failed' | 'write-rejected' }>
type TmuxWriteFailure = TmuxOnlyFailure | Extract<OrchestratorWriteResult, { status: 'stray-process' }>

// The own-session counterpart of writeToOrchestrator: a task's TMUX_SESSION
// is its identity, so there is no lock, no iTerm id check and no
// reattach-then-write — and no keystroke fallback when it is missing.
async function writeToTaskSessionViaTmux(task: Task, slug: string, text: string, mode: DispatchWriteMode): Promise<{ status: 'ok' } | TmuxWriteFailure> {
  if (!task.tmuxSession) {
    console.error(`[tmux-dispatch] ${slug} has no TMUX_SESSION — refusing to write`)
    return { status: 'not-tmux-backed' }
  }

  const result = await writeTextToTmuxSession(task.tmuxSession, text, { submit: shouldSubmitMode(mode) })
  if (result.status !== 'ok') return toTmuxWriteFailure(result)

  const tabId = await surfaceTmuxSessionTab(task.tmuxSession, path.join(TASKS_DIR, slug, 'ITERM_SESSION'), mode === 'stage')
  // surfaceTmuxSessionTab may have rewritten ITERM_SESSION (a reattach or an
  // adopted tab); without a refresh currentTasks keeps the dead id until the
  // next 5-minute refresh.
  if (tabId && tabId !== task.itermSessionId) await refreshTasks()
  return { status: 'ok' }
}

function respondTaskTmuxFailure(res: express.Response, result: TmuxWriteFailure): void {
  if (result.status === 'stray-process') {
    res.status(503).json({ error: "This task's tmux pane is sitting at a shell prompt — claude is not running there; check it manually" })
    return
  }
  respondTmuxPaneFailure(res, result, TASK_NOT_TMUX_BACKED_ERROR)
}

// The HTTP body for the three tmux-only failures, shared by every route
// (and the own-session helper below). A failed submit is the one case where
// text did land, so its wording says "staged, not sent".
function respondTmuxPaneFailure(res: express.Response, result: TmuxOnlyFailure, notTmuxBackedError = NOT_TMUX_BACKED_ERROR): void {
  if (result.status === 'not-tmux-backed') {
    res.status(503).json({ error: notTmuxBackedError })
    return
  }
  if (result.status === 'pane-not-ready') {
    res.status(409).json({ reason: result.reason, error: PANE_NOT_READY_ERROR[result.reason] })
    return
  }
  if (result.status === 'write-rejected') {
    console.error(`[tmux-dispatch] write rejected (${result.reason}); not retryable`)
    res.status(500).json({ reason: result.reason, error: WRITE_REJECTED_ERROR[result.reason] })
    return
  }
  const error = result.step === 'submit'
    ? `The text was staged but not sent (${result.error}) — check the pane.`
    : `Writing to tmux failed at the ${result.step} step: ${result.error}`
  res.status(500).json({ step: result.step, error })
}

// Writes `text` into the orchestrator's tmux pane (the session name recorded in
// ORCHESTRATOR_TMUX by /pipelinely) through the tmux pane writer, which
// pins the pane, refuses a shell prompt, a dialog or copy mode, and never
// falls back to keystrokes. `mode` is the only thing that varies between
// callers: 'send' (types and submits — /backlog/dispatch, the /focus/:slug
// fallback, auto mode, a phone-triggered stage) or 'stage' (types and leaves
// it unsent for review, then brings the tab forward — /stage-skill,
// /orchestrator/pipelinely-handover).
//
// The whole read-decide-write body runs under withOrchestratorLock: every
// caller (the ones listed above, plus POST /orchestrator/tab, which reads
// and can rewrite the same two pointer files directly) used to run this
// independently, with nothing stopping two concurrent callers from reading
// the pointers, deciding, and writing out of order with each other — see
// FINDINGS.md's "Mechanism A" for the incident this caused. The lock makes
// "read the pointers, type into the result, re-record the attached tab" one
// atomic unit with respect to every other pointer-touching caller in this
// process.
async function writeToOrchestrator(
  text: string,
  mode: DispatchWriteMode,
): Promise<OrchestratorWriteResult> {
  // Checked first, before ever touching the lock file or ORCHESTRATOR_SESSION
  // — a non-canonical instance has no business reading or racing over those
  // pointer files at all, only rejecting outright.
  if (!isCanonicalDispatchInstance()) return { status: 'not-canonical' }
  try {
    return await withOrchestratorLock(TASKS_DIR, () => writeToOrchestratorLocked(text, mode))
  } catch (error) {
    if (error instanceof OrchestratorLockTimeoutError) {
      console.error(error.message)
      return { status: 'locked' }
    }
    throw error
  }
}

// The recorded tmux session IS the orchestrator's identity, so there are no
// iTerm-id checks, no adopt and no reattach-then-write steps here, and
// nothing ever falls back to a keystroke writer.
async function writeToOrchestratorLocked(text: string, mode: DispatchWriteMode): Promise<OrchestratorWriteResult> {
  const tmuxSession = (await readOrchestratorTmux(TASKS_DIR).catch((err) => {
    console.error('[tmux-dispatch] could not read ORCHESTRATOR_TMUX:', err)
    return null
  })) ?? ''
  if (!tmuxSession) {
    console.error('[tmux-dispatch] no ORCHESTRATOR_TMUX recorded — the orchestrator is not inside tmux; refusing to write')
    return { status: 'not-tmux-backed' }
  }

  const result = await writeTextToTmuxSession(tmuxSession, text, { submit: shouldSubmitMode(mode) })
  if (result.status !== 'ok') return toTmuxWriteFailure(result)

  await surfaceTmuxSessionTab(tmuxSession, ORCHESTRATOR_SESSION_PATH, mode === 'stage')
  return { status: 'ok' }
}

// Submits `/cockpit-<skill> <slug>` into the orchestrator's own session for
// a stage whose STAGE_SKILL entry targets it. THE single automated dispatch
// path: the wave-batch route (POST /pipelinely-dev/:slug) and auto mode's
// advancement pass both go through here, so a second unattended dispatcher
// cannot fork a path that skips the pane checks writeToOrchestrator's
// tmux writer owns.
//
// Returns the write result verbatim rather than an HTTP status: the route
// wants a 409/503 with its own wording, the auto-advance pass wants a
// TIMELINE note. Neither mapping belongs here.
async function dispatchStageToOrchestrator(
  stage: Stage,
  slug: string,
): Promise<OrchestratorWriteResult> {
  const route = STAGE_SKILL[stage]
  if (!route || route.target !== 'orchestrator') {
    // Unreachable via either caller — both gate on the stage first. Guarded
    // anyway so a future caller cannot silently address the task's own tab.
    throw new Error(`dispatchStageToOrchestrator: stage ${stage} does not target the orchestrator`)
  }
  return writeToOrchestrator(composeStageCommand(route.skillName, slug), 'send')
}

// ---------------------------------------------------------------------------
// Auto mode — the advancement pass
// ---------------------------------------------------------------------------

// Auto mode is EDGE-triggered: it acts on a task CHANGING INTO an eligible
// handoff, never on one sitting in it. Two reasons, both load-bearing:
//
//   - Flipping the global switch on while several tasks already sit at a
//     handoff marker must not fire all of them at once for handoffs that
//     happened while it was off. The developer asked for what happens NEXT.
//   - refreshTasks() runs on every STATUS/METRICS/TIMELINE/... write anywhere
//     under TASKS_DIR, plus every five minutes on a timer. A level-triggered
//     pass would re-dispatch the same handoff on every one of those, because
//     the marker is still there until the worker it dispatched gets around
//     to changing it.
//
// Keyed on (stage, MATCHED MARKER) — see computeAutoDispatch's own key,
// which is what keeps the qa -> qa-fixes -> qa loop working across its two
// distinct markers while still treating a decorated status line the same as
// its bare marker.
const lastAutoKey = new Map<string, string | null>()

let advancePassInFlight: Promise<void> | null = null
let advancePassRerunRequested = false

// The pass as a whole is guarded by this in-flight promise: a refresh
// landing mid-pass sets the rerun flag rather than starting a second pass —
// all dispatches share the one orchestrator session, and two passes in
// flight would interleave keystrokes into it (the same constraint
// wave-batch-run.spec.ts already asserts: "Sequential, not Promise.all").
// The rerun re-reads currentTasks fresh once the in-flight pass finishes.
async function runAutoAdvancePass(): Promise<void> {
  if (advancePassInFlight) {
    advancePassRerunRequested = true
    return
  }
  advancePassInFlight = (async () => {
    do {
      advancePassRerunRequested = false
      await runAutoAdvancePassOnce()
    } while (advancePassRerunRequested)
  })()
  try {
    await advancePassInFlight
  } finally {
    advancePassInFlight = null
  }
}

function autoDispatchFailureReason(result: OrchestratorWriteResult): string {
  if (result.status === 'stray-process') return 'orchestrator tmux session found but not running claude'
  if (result.status === 'not-tmux-backed') return 'orchestrator not running inside tmux'
  if (result.status === 'pane-not-ready') return `orchestrator pane not ready (${result.reason})`
  if (result.status === 'write-failed') return `tmux write failed at ${result.step}`
  if (result.status === 'write-rejected') return `tmux write rejected (${result.reason})`
  return 'unknown failure'
}

// Every outcome is recorded twice: console.error with context on failure,
// and always a TIMELINE line — an unattended dispatch that left no trace
// would be indistinguishable from a stage the developer started by hand.
// The TIMELINE append is itself fallible and gets its own try/catch: it runs
// after the key is already recorded, so a swallowed EACCES/ENOENT here would
// produce exactly the untraceable unattended dispatch this exists to prevent
// — but it must not abort the rest of the pass either.
async function dispatchAndRecordAuto(slug: string, stage: Stage): Promise<void> {
  const result = await dispatchStageToOrchestrator(stage, slug)
  const ok = result.status === 'ok'
  const note = ok ? dispatchTimelineNote('auto mode') : `auto-dispatch failed — ${autoDispatchFailureReason(result)}`

  if (!ok) {
    console.error(`[auto-mode] dispatch failed for ${slug} -> ${stage}: ${autoDispatchFailureReason(result)}`)
  }

  try {
    await appendTimelineLine(path.join(TASKS_DIR, slug), stage, note)
  } catch (err) {
    console.error(`[auto-mode] failed to append TIMELINE for ${slug}:`, err)
  }
}

// The auto-mode outcome for a task whose QA is not applicable: nothing is
// pasted anywhere, the task just moves to "ready to merge". Merging stays the
// developer's click.
async function skipQaAndRecordAuto(slug: string, reason: string): Promise<void> {
  try {
    await recordQaSkipped(TASKS_DIR, slug, reason)
  } catch (err) {
    console.error(`[auto-mode] failed to record the QA skip for ${slug}:`, err)
  }
}

async function runAutoAdvancePassOnce(): Promise<void> {
  // Phase 1 — synchronous, no await anywhere in it. Interleaving
  // "decide, record, await" per task would leave the map half-updated
  // across an await point, which the rerun flag above can observe.
  const toDispatch: { slug: string; stage: Stage; skipReason?: string }[] = []
  const seenSlugs = new Set<string>()

  const ctx = decisionContext(currentSettings)
  for (const task of currentTasks) {
    seenSlugs.add(task.slug)
    const auto = computeAutoDispatch(task, ctx)
    const key = auto?.key ?? null

    // A task seen for the first time (server start, or a brand-new task
    // dir) is seeded and never dispatched, so a restart cannot re-fire a
    // standing handoff. Safe rather than lossy: the orchestrator writes
    // 'working' to a new task's STATUS before it ever opens the tab, so no
    // task dir's first observed state is an eligible handoff.
    if (lastAutoKey.has(task.slug) && auto !== null && key !== lastAutoKey.get(task.slug) && task.autoMode) {
      toDispatch.push({ slug: task.slug, stage: auto.stage, skipReason: auto.skipReason })
    }

    // Set for EVERY task, whether or not it dispatched and whether or not
    // auto mode is on — keeping the map current while auto is off is what
    // makes flipping it on a no-op for tasks already standing at a handoff.
    lastAutoKey.set(task.slug, key)
  }

  // A removed task dir must not leak in the map forever.
  for (const slug of [...lastAutoKey.keys()]) {
    if (!seenSlugs.has(slug)) lastAutoKey.delete(slug)
  }

  // Phase 2 — await each entry in turn. The map is already fully written by
  // the time the first await happens, so a failed dispatch is never
  // retried on the next refresh, and a mid-pass rerun re-reads a
  // consistent map.
  await runAutoActions(toDispatch, { dispatch: dispatchAndRecordAuto, skipQa: skipQaAndRecordAuto })
}

// Shared 503 response for every pointer-touching route that got
// OrchestratorWriteResult's 'locked' status or caught an
// OrchestratorLockTimeoutError — one body, called from all six sites
// (/focus/:slug's fallback, /backlog/dispatch, /batch-dispatch,
// /stage-skill/:slug's orchestrator branch, POST /orchestrator/tab's catch,
// and POST /orchestrator/pipelinely-handover) instead of six copy-pasted bodies.
function respondOrchestratorLocked(res: express.Response): void {
  res.status(503).json({ error: 'Another orchestrator operation is already in progress — try again in a moment' })
}

// The stray-process / locked / tmux-failure -> HTTP mapping shared by every
// route whose write goes through writeToOrchestrator and isn't a plain 'ok'.
function respondOrchestratorWriteFailure(
  res: express.Response,
  result: Exclude<OrchestratorWriteResult, { status: 'ok' }>,
): void {
  if (result.status === 'not-canonical') {
    res.status(403).json({ error: NOT_CANONICAL_ERROR })
    return
  }

  if (result.status === 'stray-process') {
    res.status(503).json({
      error: 'Orchestrator tmux session found but is not running claude — check it manually',
    })
    return
  }

  if (result.status === 'locked') {
    respondOrchestratorLocked(res)
    return
  }

  respondTmuxPaneFailure(res, result)
}

async function isRemoteAccessEnabled(): Promise<boolean> {
  try {
    return (await readRemoteToken(currentRemoteTokenFile())) !== null
  } catch (err) {
    console.error('remote-auth: cannot read the remote token file; treating remote access as off for the startup warning', err)
    return false
  }
}

export const app = express()
// First, ahead of the body parser and every static mount, so nothing is
// served (and no remote body is parsed) before the gate has decided. Resolved
// per request so `remote-token rotate` and `disable` apply with no restart.
const currentRemoteTokenFile = () => resolveRemoteTokenPath(process.env, os.homedir())
installRemoteAuth(app, { readToken: () => readRemoteToken(currentRemoteTokenFile()) })
app.use(express.json())

let currentTasks: Task[] = []
let currentActiveProject: ActiveProjectProgress | null = null
let currentWeeklyFocus = ''
let currentBacklog: BacklogItem[] = []
let currentDoneGroups: DoneDateGroup[] = []
let currentSettings: Settings = DEFAULT_SETTINGS
let currentOrchestratorContextPct: number | null = null
const sseClients: Set<express.Response> = new Set()

// The one snapshot shape both the SSE broadcast and the initial /api/tasks
// load send — a single builder rather than two independently-maintained
// object literals, which is how M1's orchestratorContextPct field almost
// shipped live-only-on-broadcast and absent on a cold /api/tasks load (or
// vice versa). Anything added to the snapshot going forward belongs here,
// not in a second copy at either call site.
function buildSnapshot(): Snapshot {
  return {
    tasks: currentTasks,
    activeProject: currentActiveProject,
    weeklyFocus: effectiveWeeklyFocus(currentSettings, currentWeeklyFocus),
    backlog: currentBacklog,
    doneGroups: currentDoneGroups,
    settings: currentSettings,
    orchestratorContextPct: currentOrchestratorContextPct,
    // Lets the client detect a non-canonical instance of itself (a
    // worktree's own local preview, an e2e webServer) and mark itself
    // read-only rather than letting a dispatch-triggering CTA silently 403 —
    // see isCanonicalDispatchInstance's own comment.
    isCanonical: isCanonicalDispatchInstance(),
  }
}

function broadcastTasks(): void {
  const payload = JSON.stringify(buildSnapshot())
  for (const res of sseClients) {
    res.write(`data: ${payload}\n\n`)
  }
}

const prNumberCache = createPrNumberCache()
const lookUpPrNumber = repoPrNumberLookup(findPrByBranch, TASKS_DIR)
const prMergeStateCache = createPrMergeStateCache()
const lookUpPrMergeState = repoPrMergeStateLookup(readPrMergeState, TASKS_DIR)
const taskLookups: TaskLookups = { lookUpPrNumber, lookUpPrMergeState, prNumberCache, prMergeStateCache }

// slug -> the dialog a worker's tmux session is stopped on, owned by the
// approval poll below and stamped onto tasks by parseAllTasks.
let currentApprovalPrompts = new Map<string, ApprovalPrompt>()

async function refreshTasks(): Promise<void> {
  // Before the auto pass below: it must see a conflicting PR to hold back QA,
  // CR and the QA skip (computeAutoDispatch).
  currentTasks = await loadTasks(TASKS_DIR, currentSettings, taskLookups, currentApprovalPrompts)
  await assignMissingCreatures(currentTasks, TASKS_DIR, console.error)
  currentActiveProject = computeActiveProject(currentTasks)
  currentDoneGroups = groupDoneTasksByDate(currentTasks)
  await runAutoAdvancePass()
  broadcastTasks()
}

async function refreshSettings(): Promise<void> {
  currentSettings = await readSettings(TASKS_DIR)
  await refreshTasks()   // every task's effective autoMode just changed
}

async function refreshWeeklyFocus(): Promise<void> {
  try {
    currentWeeklyFocus = await readStoredWeeklyFocus(TASKS_DIR)
  } catch (err) {
    console.error('[weekly-focus] failed to read WEEKLY_FOCUS:', err)
    currentWeeklyFocus = ''
  }
  broadcastTasks()
}

async function refreshBacklog(): Promise<void> {
  currentBacklog = await parseBacklog(TASKS_DIR)
  broadcastTasks()
}

// <TASKS_DIR>/ORCHESTRATOR_METRICS — the orchestrator's own context meter
// (M1 of align-cockpit-ui-to-claude-design-v2). A machine with no
// orchestrator running is normal (parseOrchestratorMetrics returns null
// silently for a missing file); a malformed or out-of-range file logs on its
// own, so refreshOrchestratorContext doesn't need a second error path here.
async function refreshOrchestratorContext(): Promise<void> {
  currentOrchestratorContextPct = await parseOrchestratorMetrics(TASKS_DIR)
  broadcastTasks()
}

// public/dist/ is Vite's build output (web/vite.config.ts's build.outDir),
// written by `npm run build:web` — react-migration M0's bundle. Missing
// until that has run at least once (or after `rm -rf public/dist`), which
// sendDashboardShell below treats as a named 500, not a bare ENOENT, so the
// failure points at the fix instead of reading like a stack trace.
const DASHBOARD_DIST = path.join(__dirname, '..', 'public', 'dist')

function sendDashboardShell(_req: express.Request, res: express.Response): void {
  res.sendFile(path.join(DASHBOARD_DIST, 'index.html'), (err) => {
    if (!err) return
    console.error('dashboard bundle missing — run npm run build:web', err)
    if (!res.headersSent) res.status(500).send('dashboard bundle missing — run npm run build:web')
  })
}

// The design's own illustrations (Claude Design project 76cb2c13…): the
// sidebar app mark and the two section-header heads. Scoped to public/art
// rather than public/ so this never becomes an accidental way to serve the
// rest of the checkout.
app.use('/art', express.static(path.join(__dirname, '..', 'public', 'art'), {
  fallthrough: false,
  maxAge: '1h',
}))

// Vite's own hashed JS/CSS bundle — scoped to dist/assets exactly like
// /art above, so it can't also serve the rest of dist/ (e.g. dist/index.html
// by name, which react-shell.spec.ts checks for directly).
app.use('/assets', express.static(path.join(DASHBOARD_DIST, 'assets'), {
  fallthrough: false,
  maxAge: '1h',
}))

// Self-hosted Figtree + JetBrains Mono woff2 files (web/public/fonts/, copied
// into dist/fonts by Vite's public-dir passthrough) — the @font-face rules in
// app.css point here so the dashboard never asks Google Fonts. Scoped like
// /assets above. The filenames aren't content-hashed, so keep the cache short —
// a deliberate font update must reach browsers within an hour, not a week.
app.use('/fonts', express.static(path.join(DASHBOARD_DIST, 'fonts'), {
  fallthrough: false,
  maxAge: '1h',
}))

// GET / — serve the dashboard
app.get('/', sendDashboardShell)

// GET /task/:slug — same dashboard shell; the client reads location.pathname
// on boot and opens straight into that task's detail view. Kept as a plain
// mirror of GET / (not a redirect) so a direct load/refresh here works
// without a round trip, and the client owns which task actually exists.
app.get('/task/:slug', sendDashboardShell)

// GET /settings — same dashboard shell, opened straight into the settings
// page (mirrors GET /task/:slug's own reasoning). Distinct from POST
// /settings below, which actually writes the setting — Express dispatches
// on method, so the two coexist on the same path with no conflict.
app.get('/settings', sendDashboardShell)

// GET /help — same dashboard shell, opened straight into the help page
// (mirrors GET /settings' own reasoning).
app.get('/help', sendDashboardShell)

// GET /docs — same dashboard shell, opened straight into the Docs page
// (mirrors GET /help's own reasoning).
app.get('/docs', sendDashboardShell)

// GET /bookmarks — same dashboard shell, opened straight into the Bookmarks
// page (mirrors GET /docs' own reasoning).
app.get('/bookmarks', sendDashboardShell)

// GET /backlog, GET /done, GET /usage — same dashboard shell, opened straight
// into that board tab. '/' itself is the fourth board tab (In Progress) —
// see the client's own DEFAULT_TAB/tabUrl, which is why it doesn't need a
// route of its own here.
app.get('/backlog', sendDashboardShell)
app.get('/done', sendDashboardShell)
app.get('/usage', sendDashboardShell)

// The Usage tab was the You tab until dashboard-v3-update M0; keep old
// bookmarks and shared links working. Not a shell route, so no client entry.
app.get(/^\/you\/?$/, (_req, res) => res.redirect('/usage'))

// Bookmarks are personal data kept in files on this Mac, so they are served to
// this Mac only: a signed-in phone can see the board but gets a 403 here.
// installRemoteAuth already refuses a loopback request driven from another
// site; this is the extra "and not a remote device" test both routes share.
function refuseUnlessLoopback(res: express.Response): boolean {
  if (requestAccess(res) === 'loopback') return false
  res.status(403).json({ error: 'Bookmarks are only available on this Mac' })
  return true
}

// The folder is resolved per request, so a changed PIPELINELY_BOOKMARKS_DIR
// takes effect without a restart. Bookmarks never ride the shared task
// snapshot: every client, remote ones included, receives that.
const currentBookmarksDir = () => resolveBookmarksDir(process.env, os.homedir())

// GET /api/bookmarks — every readable bookmark, newest first, each saying
// whether its task is still on the board (worked out here on every list, never
// stored), plus the names of files that could not be read.
app.get('/api/bookmarks', async (_req, res) => {
  if (refuseUnlessLoopback(res)) return
  try {
    const { bookmarks, unreadable } = await listBookmarks(currentBookmarksDir())
    const boardSlugs = new Set(currentTasks.map((task) => task.slug))
    res.json({
      bookmarks: bookmarks.map((bookmark) => ({ ...bookmark, taskOnBoard: bookmark.source.taskSlug !== null && boardSlugs.has(bookmark.source.taskSlug) })),
      unreadable,
    })
  } catch (err) {
    // listBookmarks has already logged the folder and error code; nothing from
    // a file's content may reach a log.
    console.error('[bookmarks] GET /api/bookmarks failed:', (err as NodeJS.ErrnoException).code ?? 'unreadable folder')
    res.status(500).json({ error: 'Could not read the bookmarks folder' })
  }
})

// DELETE /api/bookmarks/:id — remove one bookmark's file.
app.delete('/api/bookmarks/:id', async (req, res) => {
  if (refuseUnlessLoopback(res)) return
  const { id } = req.params
  if (!isBookmarkId(id)) {
    res.status(400).json({ error: 'Not a bookmark id' })
    return
  }
  try {
    const outcome = await deleteBookmark(currentBookmarksDir(), id)
    if (outcome === 'not-found') res.status(404).json({ error: 'No such bookmark' })
    else res.status(204).end()
  } catch (err) {
    console.error(`[bookmarks] DELETE /api/bookmarks/${id} failed:`, (err as NodeJS.ErrnoException).code ?? 'unknown error')
    res.status(500).json({ error: 'Could not delete the bookmark' })
  }
})

// GET /api/tasks — snapshot for initial page load
app.get('/api/tasks', (_, res) => {
  res.json(buildSnapshot())
})

// GET /api/access — is THIS request coming from a remote/mobile context?
//
// Per-request on purpose, and deliberately not folded into /api/tasks or the
// SSE payload: broadcastTasks serialises one object and writes it to every
// client in sseClients, so a per-client field there would end up being
// whatever the last connecting client happened to be — the failure mode
// being a desktop tab told it is remote. Read-only, no side effects, no lock.
app.get('/api/access', (req, res) => {
  res.json({ isRemoteAccess: requestIsRemote(req), hasRemoteSession: requestAccess(res) === 'remote-authenticated' })
})

// POST /weekly-focus — free-text banner describing this week's focus
app.post('/weekly-focus', async (req, res) => {
  // A disabled pane has no editor, so an edit can only be a stale client or
  // a script — refuse it loudly rather than writing text nothing will show.
  if (!isWeeklyFocusEnabled(currentSettings)) return res.status(409).json({ error: 'weekly focus is disabled' })
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text : ''
    await fs.writeFile(WEEKLY_FOCUS_PATH, text)
    currentWeeklyFocus = text.trim()
    broadcastTasks()
    res.sendStatus(200)
  } catch {
    res.sendStatus(500)
  }
})

// Whichever settings fields the body carries, each validated; null when a
// present field is invalid or the body carries none of them.
function parseSettingsPatch(body: unknown): Partial<Settings> | null {
  const { autoMode, creaturePlacement, weeklyFocusEnabled, qaStartPolicy } = (body ?? {}) as { autoMode?: unknown; creaturePlacement?: unknown; weeklyFocusEnabled?: unknown; qaStartPolicy?: unknown }
  const patch: Partial<Settings> = {}
  if (autoMode !== undefined) {
    if (typeof autoMode !== 'boolean') return null
    patch.autoMode = autoMode
  }
  if (creaturePlacement !== undefined) {
    if (!isCreaturePlacement(creaturePlacement)) return null
    patch.creaturePlacement = creaturePlacement
  }
  if (weeklyFocusEnabled !== undefined) {
    if (typeof weeklyFocusEnabled !== 'boolean') return null
    patch.weeklyFocusEnabled = weeklyFocusEnabled
  }
  if (qaStartPolicy !== undefined) {
    if (!isQaStartPolicy(qaStartPolicy)) return null
    patch.qaStartPolicy = qaStartPolicy
  }
  return Object.keys(patch).length === 0 ? null : patch
}

// POST /settings — the global switches. Body: { autoMode?: boolean,
// creaturePlacement?: 'header' | 'off', weeklyFocusEnabled?: boolean,
// qaStartPolicy?: 'ask-every-time' | 'cockpit-ai-ui-preapproved' }, merged
// into the file.
// Rejects a non-boolean rather than coercing: this is the switch that
// decides whether the machine spends money unattended, and "truthy" is not
// a good enough answer.
app.post('/settings', async (req, res) => {
  try {
    const patch = parseSettingsPatch(req.body)
    if (patch === null) return res.sendStatus(400)
    await fs.writeFile(SETTINGS_PATH, JSON.stringify({ ...currentSettings, ...patch }))
    await refreshSettings()
    res.sendStatus(200)
  } catch (err) {
    console.error('Failed to write SETTINGS.json:', err)
    res.sendStatus(500)
  }
})

// POST /task-auto-mode/:slug — this task's own override.
// Body: { override: 'auto' | 'manual' | 'inherit' }. 'inherit' DELETES the
// AUTO_MODE file rather than writing the word, so "no opinion" is the
// absence of a file, exactly as parseAutoModeOverride reads it — one
// representation of one state.
app.post('/task-auto-mode/:slug', async (req, res) => {
  try {
    const override = req.body?.override as AutoModeOverride | undefined
    if (override !== 'auto' && override !== 'manual' && override !== 'inherit') return res.sendStatus(400)

    const task = currentTasks.find(t => t.slug === req.params.slug)
    if (!task) return res.sendStatus(404)

    const autoModePath = path.join(TASKS_DIR, req.params.slug, 'AUTO_MODE')
    if (override === 'inherit') {
      await fs.rm(autoModePath, { force: true })
    } else {
      await fs.writeFile(autoModePath, override)
    }
    await refreshTasks()
    res.sendStatus(200)
  } catch (err) {
    console.error(`Failed to write AUTO_MODE for ${req.params.slug}:`, err)
    res.sendStatus(500)
  }
})

// GET /events — SSE stream
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.write(`data: ${JSON.stringify(buildSnapshot())}\n\n`)
  sseClients.add(res)
  req.on('close', () => sseClients.delete(res))
})

// POST /answer-dialog/:slug — types exactly one key into a worker's tmux
// pane to answer the Claude Code dialog it is stopped on. Only ever reached by
// an explicit click: nothing else in the server calls answerDialog
// (dialogAnswer.contract.test.ts). Every refusal is `{ reason, error }`; see
// dialogAnswer.ts for the safety rules.
const productionDialogAnswerDepsForTasksDir = productionDialogAnswerDeps(TASKS_DIR)

app.post('/answer-dialog/:slug', async (req, res) => {
  const { slug } = req.params
  try {
    const refusal = checkAnswerDialogRequest(req)
    if (refusal) {
      console.warn(`[answerDialog] refused ${slug} from ${req.socket.remoteAddress ?? 'unknown-peer'}: ${refusal}`)
      const { status, body } = responseForGuardRefusal(refusal)
      return res.status(status).json(body)
    }
    if (!isCanonicalDispatchInstance()) return res.status(403).json({ reason: 'not-canonical', error: NOT_CANONICAL_ERROR } satisfies AnswerDialogResponseBody)

    const answer = parseAnswerBody(req.body)
    if (!answer) return res.status(BAD_REQUEST_RESPONSE.status).json(BAD_REQUEST_RESPONSE.body)
    const task = currentTasks.find((candidate) => candidate.slug === slug)
    if (!task) return res.status(UNKNOWN_TASK_RESPONSE.status).json(UNKNOWN_TASK_RESPONSE.body)

    const result = await answerDialog(
      task,
      { slug, ...answer, peer: req.socket.remoteAddress ?? 'unknown-peer', userAgent: req.get('user-agent') ?? null },
      { publishedPrompt: task.approvalPrompt ?? null, tasks: currentTasks },
      productionDialogAnswerDepsForTasksDir,
    )
    // So the card reflects the new pane in this same push, not up to a poll interval later.
    if (result.outcome === 'answered' || result.outcome === 'unconfirmed') await approvalTick()
    const { status, body } = responseForAnswerResult(result)
    return res.status(status).json(body)
  } catch (err) {
    console.error(`[answerDialog] ${slug} failed:`, err)
    // approvalTick() can throw after a key went out, so this must not say nothing was sent.
    return res.status(500).json({ reason: 'internal', error: 'Answering failed unexpectedly, so it is unknown whether a key was sent. Check the terminal.' } satisfies AnswerDialogResponseBody)
  }
})

// POST /focus/:slug — focus iTerm2 tab, or reattach to its tmux session
// if the tab closed but the session backing it is still alive. If neither
// is reachable (e.g. after a computer restart wiped both), falls back to
// pasteToOrchestrator, asking it to recreate the task's tmux session
// against its existing worktree and resume it — the same thing a developer
// would type by hand, and the same fallback primitive /backlog/dispatch
// already uses, so the retry/reattach logic for the orchestrator's own
// session lives in exactly one place.
app.post('/focus/:slug', async (req, res) => {
  try {
    const task = currentTasks.find(t => t.slug === req.params.slug)
    if (!task) return res.sendStatus(404)
    const itermSessionFilePath = path.join(TASKS_DIR, req.params.slug, 'ITERM_SESSION')
    const outcome = await reattachOrFocus(req.params.slug, task.itermSessionId, task.tmuxSession, itermSessionFilePath)

    if (outcome === 'reattached') {
      // A reattach writes the new iTerm session id to ITERM_SESSION on disk,
      // but ITERM_SESSION/TMUX_SESSION aren't in the chokidar watch glob
      // (only STATUS/METRICS/DEV_URL/PLAN.md are) and the interval refresh
      // is 5 minutes out — without this, currentTasks keeps the stale dead
      // session id and a repeat click decides 'reattach' again, opening a
      // duplicate tab that forcibly detaches the one just created. Scoped to
      // this outcome only (not called unconditionally up front): the
      // fallback branch below can take a while (pasteToOrchestrator may
      // itself retry/reattach), and an early refreshTasks() broadcasts an
      // SSE update that re-renders the dashboard — replacing this request's
      // button DOM node — before the response (and its flash) even lands.
      await refreshTasks()
    }

    if (outcome === 'focused' || outcome === 'reattached') return res.sendStatus(200)

    if (outcome === 'reattach-failed') {
      // The tmux session itself was confirmed live, but opening a new tab
      // and verifying its attach failed (see reattachTmuxSession) — unlike
      // 'none', the session isn't actually gone, so falling back to
      // "recreate it" would be wrong; just report the failure.
      console.error(`Focus ${req.params.slug}: tmux session is live but reattaching a new tab to it failed`)
      return res.status(500).json({ error: 'Tmux session found but reattaching to it failed — see server logs' })
    }

    // outcome === 'none': neither the recorded iTerm session nor its tmux
    // session is alive. Mirror what a developer would do by hand.
    const message = buildDeadSessionMessage(req.params.slug, task, TASKS_DIR)
    const result = await writeToOrchestrator(message, 'send')
    if (result.status === 'ok') return res.status(202).json({ fallback: true })

    if (result.status === 'not-canonical') return res.status(403).json({ error: NOT_CANONICAL_ERROR })

    if (result.status === 'stray-process') {
      return res.status(503).json({
        error: "Session gone, and the orchestrator's tmux session is not running claude — check it manually",
      })
    }

    if (result.status === 'locked') {
      return respondOrchestratorLocked(res)
    }

    return respondTmuxPaneFailure(res, result)
  } catch (err) {
    console.error(`Failed to focus/reattach ${req.params.slug}:`, err)
    res.sendStatus(500)
  }
})

// POST /orchestrator/tab — bring the orchestrator's own tab back: focus it
// if it is still live, otherwise reattach its surviving tmux session into a
// fresh tab. The same primitive the per-task "→ Terminal" button uses
// (reattachOrFocus), one level up. Distinct from writeToOrchestrator: this is
// the developer asking for the tab itself, with nothing to dispatch into it —
// so it deliberately does not run the tmux writer's stray-shell gate:
// refusing to even open the tab because claude isn't running there would
// block exactly the moment a developer wants to look at it, to restart
// claude themselves.
//
// Still canonical-gated, though, same as every other reader/writer of
// ORCHESTRATOR_SESSION/ORCHESTRATOR_TMUX: this route reads and can rewrite
// both pointer files directly (via reattachOrFocus's adopt/reattach heal),
// and can forcibly reattach or foreground the developer's real, live
// orchestrator tab — a non-canonical instance (a worktree's own local
// preview, an e2e webServer) pointed at the real, shared TASKS_DIR has no
// business doing either. Checked first, before the lock or either pointer
// file, for the same reason writeToOrchestrator checks it first.
app.post('/orchestrator/tab', async (req, res) => {
  try {
    if (!isCanonicalDispatchInstance()) return res.status(403).json({ error: NOT_CANONICAL_ERROR })

    // Reads ORCHESTRATOR_SESSION/ORCHESTRATOR_TMUX and — via reattachOrFocus
    // — can rewrite ORCHESTRATOR_SESSION_PATH (the adopt/reattach heal
    // paths), exactly like writeToOrchestrator does. Sharing the same lock
    // is what makes the two mutually exclusive rather than just internally
    // consistent — see orchestratorLock.ts's own comment.
    const { outcome, sessionId } = await withOrchestratorLock(TASKS_DIR, async () => {
      const sessionId = (await fs.readFile(ORCHESTRATOR_SESSION_PATH, 'utf-8').catch(() => '')).trim() || null
      const tmuxSession = await readOrchestratorTmux(TASKS_DIR).catch(() => null)
      const outcome = await reattachOrFocus('orchestrator', sessionId, tmuxSession, ORCHESTRATOR_SESSION_PATH)
      return { outcome, sessionId }
    })

    if (outcome === 'focused' || outcome === 'reattached') return res.sendStatus(200)

    if (outcome === 'reattach-failed') {
      console.error('Orchestrator tab: tmux session is live but reattaching a new tab to it failed')
      return res.status(500).json({ error: 'Tmux session found but reattaching to it failed — see server logs' })
    }

    return res.status(503).json({
      error: sessionId
        ? 'Orchestrator tab and tmux session are both gone — start it with /pipelinely'
        : 'Orchestrator not running — no ORCHESTRATOR_SESSION found',
    })
  } catch (err) {
    if (err instanceof OrchestratorLockTimeoutError) {
      console.error(err.message)
      return respondOrchestratorLocked(res)
    }
    console.error('Failed to bring back the orchestrator tab:', err)
    res.sendStatus(500)
  }
})

// POST /orchestrator/pipelinely-handover — stage `/pipelinely-handover` into the orchestrator's own
// session, unsent, for the developer to review before running it. Sits next
// to POST /orchestrator/tab, but goes through writeToOrchestrator (like
// /backlog/dispatch and /batch-dispatch) rather than reattachOrFocus, since
// this one has something to type once the tab is found. See
// tech-design.md's "stage, don't send" decision for why this never
// auto-submits.
app.post('/orchestrator/pipelinely-handover', async (_req, res) => {
  try {
    const result = await writeToOrchestrator(HANDOVER_COMMAND, 'stage')
    if (result.status === 'ok') return res.sendStatus(200)
    return respondOrchestratorWriteFailure(res, result)
  } catch (err) {
    console.error('Failed to stage /pipelinely-handover into the orchestrator:', err)
    res.sendStatus(500)
  }
})

const LOAD_DECIMALS = 10
function roundLoad(load1: number): number {
  return Math.round(load1 * LOAD_DECIMALS) / LOAD_DECIMALS
}

// POST /babysit — the Push forward pill. Plans one sweep with the same
// planSweep the /pipelinely-babysit skill runs, and only when it has something to
// push submits that skill into the orchestrator's own session (the same
// submit path auto mode uses). The click is the consent to one sweep; the
// skill itself refuses every hard stop. Load-too-high and nothing-to-do write
// nothing, so the pill never reports a sweep that was not started.
app.post('/babysit', async (_req, res) => {
  try {
    const load1 = os.loadavg()[0]
    const plan = planSweep(currentTasks, { load1 }, decisionContext(currentSettings))
    // The raw reading is a long float; the pill prints it as given.
    if (plan.isLoadTooHigh) return res.json({ outcome: 'load-too-high', load1: roundLoad(load1) })
    if (plan.actions.length === 0) return res.json({ outcome: 'nothing' })

    const result = await writeToOrchestrator(composeStageCommand('babysit', null), 'send')
    if (result.status === 'ok') return res.json({ outcome: 'sent', planned: plan.actions.length })
    console.error(`[babysit] sweep not sent: ${result.status}`, result)
    return respondOrchestratorWriteFailure(res, result)
  } catch (err) {
    console.error('[babysit] Failed to submit /pipelinely-babysit into the orchestrator:', err)
    res.sendStatus(500)
  }
})

// POST /help/pipelinely-feedback — stage `/pipelinely-feedback <message>` into the orchestrator's
// own session, unsent. Same shape as /orchestrator/pipelinely-handover, but with a
// free-text message instead of a constant, so it validates the body the way
// /backlog/dispatch does first. normalizeWhitespace collapses any newline
// before it can become a literal Return keystroke in the pane — see
// tech-design-help-feedback-tab.md's newline decision.
app.post('/help/pipelinely-feedback', async (req, res) => {
  try {
    const { message } = req.body ?? {}
    if (typeof message !== 'string' || !message.trim()) return res.sendStatus(400)

    const result = await writeToOrchestrator(
      `${HELP_FEEDBACK_COMMAND} ${normalizeWhitespace(message)}`,
      'stage',
    )
    if (result.status === 'ok') return res.sendStatus(200)
    return respondOrchestratorWriteFailure(res, result)
  } catch (err) {
    console.error('Failed to stage /pipelinely-feedback into the orchestrator:', err)
    res.sendStatus(500)
  }
})

// POST /vscode/:slug — open VS Code on worktree
app.post('/vscode/:slug', async (req, res) => {
  try {
    const task = currentTasks.find(t => t.slug === req.params.slug)
    if (!task?.worktree) return res.sendStatus(404)
    await openVSCode(task.worktree)
    res.sendStatus(200)
  } catch {
    res.sendStatus(500)
  }
})

// POST /browse/:slug — open browser at devUrl
app.post('/browse/:slug', async (req, res) => {
  try {
    const task = currentTasks.find(t => t.slug === req.params.slug)
    if (!task?.devUrl) return res.sendStatus(404)
    await openBrowserUrl(task.devUrl)
    res.sendStatus(200)
  } catch {
    res.sendStatus(500)
  }
})

// POST /open-pr/:slug — opens the task's PR in the browser via `gh pr view
// --web` (see openPrInBrowser in gitOps.ts) rather than a plain <a href>: a
// task only knows its bare repo name, not the GitHub org/owner a real URL
// needs, and `gh` already knows both.
app.post('/open-pr/:slug', async (req, res) => {
  try {
    const task = currentTasks.find(t => t.slug === req.params.slug)
    if (!task) return res.sendStatus(404)

    const prNumber = findPrNumber(task)
    if (!prNumber) {
      console.error(`Open PR refused for ${req.params.slug}: no PR recorded`)
      return res.status(404).json({ error: 'No PR recorded for this task yet' })
    }

    const repoPath = path.join(reposDir(TASKS_DIR), task.repo)
    // Same guard as the merge path: a mis-resolved PR number must fail loudly
    // rather than open somebody else's PR.
    const head = await readPrHeadBranch(repoPath, prNumber)
    if (!head.ok) return res.status(503).json({ error: head.error })
    if (head.headRefName !== task.branch) {
      const mismatch = { prNumber, expectedBranch: task.branch, actualBranch: head.headRefName }
      console.error(`Open PR refused for ${req.params.slug}: ${formatBranchMismatch(mismatch)}`)
      return res.status(409).json({ error: formatBranchMismatch(mismatch) })
    }

    const result = await openPrInBrowser(repoPath, prNumber)
    if (!result.ok) return res.status(503).json({ error: result.error })
    res.sendStatus(200)
  } catch (err) {
    console.error(`Failed to open PR for ${req.params.slug}:`, err)
    res.sendStatus(500)
  }
})

// Shared by GET /tech-design/:slug and GET /qa-spec/:slug: reads a
// (possibly comma-joined) declared spec path from the first candidate
// worktree root that has it, and reports every path that couldn't be read
// from ANY root. `worktrees` is an ordered list of candidate roots — the
// caller filters out nulls (a milestone group tries the dispatched child's
// worktree before the parent's; /qa-spec has just the one).
//
// ENOENT in every root (or an empty root list) is an expected, UI-surfaced
// state — "not written yet" / "no worktree on disk" — so it is not logged
// (the Plan tab re-fetches this on every SSE frame while open; logging it
// would spam). Any other read error (EISDIR, EACCES, …) is unexpected, so it
// both counts as missing AND gets console.error'd with slug + path, matching
// this file's existing console.error convention.
async function readSpecTitles(
  worktrees: string[],
  specFile: string,
  slug: string,
): Promise<{ titles: string[]; missingSpecFiles: string[] }> {
  const relPaths = specFile.split(',').map(s => s.trim()).filter(Boolean)
  const titles: string[] = []
  const missingSpecFiles: string[] = []

  for (const relPath of relPaths) {
    let content: string | null = null
    let unexpectedErr: NodeJS.ErrnoException | null = null

    for (const root of worktrees) {
      try {
        content = await fs.readFile(path.join(root, relPath), 'utf-8')
        break
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') unexpectedErr = err as NodeJS.ErrnoException
      }
    }

    if (content !== null) {
      titles.push(...parseQaCaseTitles(content))
      continue
    }

    missingSpecFiles.push(relPath)
    if (unexpectedErr) {
      console.error(`Failed to read spec file ${relPath} for ${slug}:`, unexpectedErr)
    }
  }

  return { titles, missingSpecFiles }
}

// GET /tech-design/:slug — the task's tech-design.md, split into its pinned
// `## Summary` prose, the rest of the document (rendered to HTML), and the
// derived list of e2e test titles that will run against the task — for the
// detail view's Plan / Plan Review tabs. Not part of the SSE payload: one
// Markdown document per task on every broadcast is a lot of bytes for
// something only an open Plan tab reads, so the client fetches it lazily.
// Looking the slug up in currentTasks first is also what keeps this from
// being a path-traversal read — only a known task dir can be named.
app.get('/tech-design/:slug', async (req, res) => {
  try {
    const task = currentTasks.find(t => t.slug === req.params.slug)
    if (!task) return res.sendStatus(404)
    const raw = await fs.readFile(path.join(TASKS_DIR, req.params.slug, 'tech-design.md'), 'utf-8')
      .catch(() => null)
    if (raw === null) return res.sendStatus(404)

    const summary = parseSummarySection(raw)
    const html = renderMarkdownToHtml(stripSummarySection(raw))
    const summaryHtml = summary !== null ? renderMarkdownToHtml(summary) : null

    let testGroups: PlanTestGroup[]
    if (task.milestones) {
      testGroups = await Promise.all(task.milestones.map(async (m): Promise<PlanTestGroup> => {
        // Dispatched child's worktree first (the copy QA will actually run,
        // and dev may have renamed cases there), then the parent's — a
        // per-file fallback, since a freshly-cut child branch doesn't yet
        // have the parent's own planning commit merged in.
        const roots = [m.task?.worktree, task.worktree].filter((r): r is string => !!r)
        const hasWorktree = roots.length > 0
        if (!m.specFile) {
          return { milestoneId: m.id, name: m.name, specFile: null, titles: [], missingSpecFiles: [], hasWorktree }
        }
        const { titles, missingSpecFiles } = await readSpecTitles(roots, m.specFile, task.slug)
        return { milestoneId: m.id, name: m.name, specFile: m.specFile, titles, missingSpecFiles, hasWorktree }
      }))
    } else if (task.qaSpecFile) {
      const roots = task.worktree ? [task.worktree] : []
      const { titles, missingSpecFiles } = await readSpecTitles(roots, task.qaSpecFile, task.slug)
      testGroups = [{
        milestoneId: null, name: null, specFile: task.qaSpecFile, titles, missingSpecFiles,
        hasWorktree: roots.length > 0,
      }]
    } else {
      testGroups = []
    }

    res.json({ html, summaryHtml, testGroups })
  } catch (err) {
    console.error(`Failed to render tech-design.md for ${req.params.slug}:`, err)
    res.sendStatus(500)
  }
})

// GET /result-doc/:slug — a research task's deliverable markdown, for the
// Result tab. The snapshot carries only its metadata (Task.resultDoc): a
// document of up to 512 KB per task on every broadcast to every client is far
// too much for something only an open Result tab reads, so it is fetched here,
// under the same rule as /tech-design/:slug — looking the slug up in
// currentTasks first means only a known task dir can be named.
app.get('/result-doc/:slug', async (req, res) => {
  try {
    const task = currentTasks.find(t => t.slug === req.params.slug)
    if (!task) return res.sendStatus(404)
    const taskDir = path.join(TASKS_DIR, task.slug)
    const taskMdContent = await fs.readFile(path.join(taskDir, 'TASK.md'), 'utf-8').catch(() => null)
    const doc = await findResultDoc(taskDir, taskMdContent, task.mode)
    if (!doc) return res.sendStatus(404)
    res.json(doc)
  } catch (err) {
    console.error(`Failed to load the result document for ${req.params.slug}:`, err)
    res.sendStatus(500)
  }
})

// GET /qa-spec/:slug — planned QA case titles for a task that hasn't run QA
// yet, parsed straight out of its declared e2e spec file(s) (qaSpecFile).
// Resolved relative to the task's own worktree, not TASKS_DIR — this is
// source code planning committed, not a pipeline artifact. A preview only:
// once QA_REPORT.md exists, that's the authoritative pass/fail list.
app.get('/qa-spec/:slug', async (req, res) => {
  try {
    const task = currentTasks.find(t => t.slug === req.params.slug)
    if (!task || !task.qaSpecFile || !task.worktree) return res.sendStatus(404)

    const { titles } = await readSpecTitles([task.worktree], task.qaSpecFile, task.slug)
    res.json({ titles })
  } catch (err) {
    console.error(`Failed to read QA spec for ${req.params.slug}:`, err)
    res.sendStatus(500)
  }
})

// GET /api/stage-scope — each skill-backed stage's own "what this stage
// covers" summary, parsed live from .claude/skills/cockpit-*/SKILL.md on
// every request (see stageScope.ts). No slug and no user input reach a
// path here, so there's no traversal surface, and no server-side cache: the
// client fetches this once per page load (see useStageScopes in
// web/src/data/taskResources.ts), so a skill edit shows up on the next dashboard reload with
// no server restart needed.
app.get('/api/stage-scope', async (_, res) => {
  try {
    res.json({ stages: await loadStageScopes(SKILLS_DIR, ENGINEERING_CONSTRAINTS_PATH) })
  } catch (err) {
    console.error('Failed to load stage scopes:', err)
    res.sendStatus(500)
  }
})

// GET /api/docs — the user guide (docs/user-guide.md), rendered through the
// same renderMarkdownToHtml the Plan tab's GET /tech-design/:slug already
// uses. 404 when the file is missing (a checkout that predates it, or a
// guide not yet published downstream); 500 on any other read failure. No
// server-side cache: the file is read per request, so an edit shows up the
// next time the Docs page opens with no restart, matching /api/stage-scope's
// reasoning above. No slug or user input reaches the path, so there is no
// traversal surface.
app.get('/api/docs', async (_, res) => {
  try {
    const raw = await fs.readFile(docsGuidePath(), 'utf-8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
    if (raw === null) return res.sendStatus(404)
    res.json({ html: renderMarkdownToHtml(raw) })
  } catch (err) {
    console.error('Failed to read docs/user-guide.md:', err)
    res.sendStatus(500)
  }
})

// POST /mark-done/:slug — manual override for tasks the dashboard can't
// resolve itself (e.g. orphaned: worker tab closed before writing STATUS=done).
// Also cleans up the task's own worktree + branch, once it has one — a task
// this route marks done has, by definition, nothing left to do in its
// worktree. Cleanup is best-effort: a task is still "done" even if git
// refuses the delete (uncommitted changes, an unmerged branch), so a
// cleanup failure never blocks the STATUS write itself — it's reported back
// in the response instead, for the client to surface as a soft error.
app.post('/mark-done/:slug', async (req, res) => {
  try {
    const task = currentTasks.find(t => t.slug === req.params.slug)
    if (!task) return res.sendStatus(404)
    const { cleanupError, sessions } = await markTaskDone(TASKS_DIR, task)

    await refreshTasks()
    res.json({ cleaned: cleanupError === null, cleanupError, sessions })
  } catch (err) {
    console.error(`Failed to mark ${req.params.slug} done:`, err)
    res.sendStatus(500)
  }
})

// POST /shelve/:slug — takes an in-progress task off both board tabs and
// records it as a BACKLOG.md entry pointing back at its own task dir, so it
// can be picked up later without starting over. Body-less, like /mark-done:
// shelving captures no reason, and everything the entry needs is read off
// the task itself.
//
// Nothing is discarded except the worktree, which is committed first (see
// commitAndRemoveWorktree in gitOps.ts): the task dir keeps TASK.md,
// TIMELINE and tech-design.md, and the branch keeps every commit, including
// whatever was still in flight at the moment of shelving.
//
// **The backlog line is written before STATUS, deliberately** — the reverse
// of /mark-done's order. A done task stays visible on the Done tab either
// way, so it has no state to strand in; this route does. A task whose STATUS
// says `shelved` with no backlog entry is off In Progress, off Done and off
// the backlog — invisible on every surface, recoverable only by hand-editing
// STATUS. Writing the backlog line first inverts that failure into a
// *duplicate* (a backlog row whose Resume still points at a task that is
// also still on the board), which Resume itself heals. The content is
// computed and validated before any of it is written, so the BACKLOG.md
// write is the first mutation of any kind, and the worktree — the one step
// touching anything outside TASKS_DIR — goes last.
app.post('/shelve/:slug', async (req, res) => {
  try {
    const task = currentTasks.find(t => t.slug === req.params.slug)
    if (!task) return res.sendStatus(404)
    if (task.status === 'done' || task.status === 'shelved') {
      console.error(`Refused to shelve ${req.params.slug}: status is already '${task.status}'`)
      return res.status(400).json({ error: `A ${task.status} task can't be shelved` })
    }

    // Only a genuinely absent file becomes a fresh one — every other read
    // failure (a permissions problem, a directory in its place) throws to
    // the catch below rather than being treated as "no backlog yet", which
    // would replace a real, unreadable BACKLOG.md with a bare header. This
    // is the one route that can create the file, so it is the one that has
    // to tell those two cases apart.
    const raw = await fs.readFile(BACKLOG_PATH, 'utf-8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
    // A non-empty repo that isn't a clean token (e.g. contains "/" or ":")
    // would corrupt the line if tagged unchecked — shelve must never fail
    // over a tag, so it just writes the entry untagged, logged the same way
    // as every other handled-but-notable rejection in this file.
    const repoIsValidProject = isBacklogProject(task.repo)
    if (task.repo && !repoIsValidProject) {
      console.error(`Shelving ${req.params.slug}: repo "${task.repo}" is not a valid project token, writing untagged`)
    }
    const result = applyBacklogShelveEntry(raw ?? '# Backlog\n', {
      description: task.title || req.params.slug,
      date: localDateKey(new Date()),
      slug: req.params.slug,
      project: repoIsValidProject ? task.repo : null,
    })
    if (!result.ok) {
      console.error(`Failed to shelve ${req.params.slug}: ${result.error}`)
      return res.status(409).json({ error: result.error })
    }

    await fs.writeFile(BACKLOG_PATH, result.content)
    await fs.writeFile(path.join(TASKS_DIR, req.params.slug, 'STATUS'), 'shelved\n')
    if (task.stage) {
      await fs.appendFile(
        path.join(TASKS_DIR, req.params.slug, 'TIMELINE'),
        `${new Date().toISOString()} ${task.stage} shelved\n`,
      )
    }

    // Best-effort, exactly like /mark-done's cleanup: the board state has
    // already changed, so a git refusal is reported rather than allowed to
    // block the shelve. The branch is never deleted — see gitOps.ts.
    let cleanupError: string | null = null
    if (task.worktree) {
      const cleanup = await commitAndRemoveWorktree(path.join(reposDir(TASKS_DIR), task.repo), task.worktree)
      if (!cleanup.ok) cleanupError = cleanup.error
    }

    await refreshTasks()
    await refreshBacklog()
    res.json({ shelved: true, cleaned: cleanupError === null, cleanupError })
  } catch (err) {
    console.error(`Failed to shelve ${req.params.slug}:`, err)
    res.sendStatus(500)
  }
})

// POST /merge-pr/:slug — the gated Merge button and the /pipelinely-merge CLI's
// one shared path (see taskCompletion.ts's mergeTask): refuse unless the PR
// is open, conflict-free and green, then merge pinned to the checked head
// commit and finish exactly like /mark-done, plus deleting the merged PR's
// remote branch. Body-less, like /mark-done — everything it needs (repo, PR
// number) is read off the task itself, never trusted from the client, since
// this is the one route that mutates a shared remote, not just local state.
app.post('/merge-pr/:slug', async (req, res) => {
  const task = currentTasks.find(t => t.slug === req.params.slug)
  if (!task) return res.sendStatus(404)

  try {
    const result = await mergeTask(TASKS_DIR, task)
    switch (result.outcome) {
      case 'no-pr':
        console.error(`Merge refused for ${req.params.slug}: no PR recorded`)
        return res.status(400).json({ error: 'No PR recorded for this task yet' })
      case 'blocked':
        console.error(`Merge refused for ${req.params.slug}: ${formatMergeBlockers(result.blockers)}`)
        return res.status(409).json({ error: formatMergeBlockers(result.blockers), blockers: result.blockers })
      case 'branch-mismatch':
        console.error(`Merge refused for ${req.params.slug}: ${formatBranchMismatch(result)}`)
        return res.status(409).json({ error: formatBranchMismatch(result) })
      case 'gate-unavailable':
      case 'merge-failed':
        console.error(`Merge failed for ${req.params.slug}:`, result.error)
        return res.status(503).json({ error: result.error })
      case 'merged':
        await refreshTasks()
        return res.json({ merged: true, prNumber: result.prNumber, cleaned: result.cleanupError === null, cleanupError: result.cleanupError, sessions: result.sessions })
    }
  } catch (err) {
    console.error(`Failed to merge PR for ${req.params.slug}:`, err)
    // Best-effort: refreshTasks() failing a second time here (the same
    // underlying fs/parse error that could have driven mergeTask's own
    // throw above) must not swallow the 500 below — a client left with no
    // response at all is worse than one with slightly stale board state.
    try {
      await refreshTasks()
    } catch (refreshErr) {
      console.error(`Failed to refresh tasks after a failed merge for ${req.params.slug}:`, refreshErr)
    }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// POST /triage/:slug — persist which code-review findings the human selected
// for a future fixer agent to act on. Body: { selected: number[] }
app.post('/triage/:slug', async (req, res) => {
  try {
    const task = currentTasks.find(t => t.slug === req.params.slug)
    if (!task) return res.sendStatus(404)
    const selected = Array.isArray(req.body?.selected)
      ? req.body.selected.filter((n: unknown) => typeof n === 'number')
      : []
    await fs.writeFile(
      path.join(TASKS_DIR, req.params.slug, 'TRIAGE.json'),
      JSON.stringify({ selected, updatedAt: new Date().toISOString() }, null, 2) + '\n',
    )
    await refreshTasks()
    res.sendStatus(200)
  } catch {
    res.sendStatus(500)
  }
})

// Mirrors /triage/:slug above, for QA_REPORT.md's failing cases instead of
// task-pr-review.md's findings — a separate sidecar file since a task can in
// principle carry both at once.
app.post('/qa-triage/:slug', async (req, res) => {
  try {
    const task = currentTasks.find(t => t.slug === req.params.slug)
    if (!task) return res.sendStatus(404)
    const selected = Array.isArray(req.body?.selected)
      ? req.body.selected.filter((n: unknown) => typeof n === 'number')
      : []
    await fs.writeFile(
      path.join(TASKS_DIR, req.params.slug, 'QA_TRIAGE.json'),
      JSON.stringify({ selected, updatedAt: new Date().toISOString() }, null, 2) + '\n',
    )
    await refreshTasks()
    res.sendStatus(200)
  } catch {
    res.sendStatus(500)
  }
})

// POST /backlog/dispatch — paste a backlog item into the orchestrator's own
// tmux session (registered via ORCHESTRATOR_TMUX by /pipelinely),
// as if the developer had typed "let's do this". The orchestrator runs its
// normal promote-to-task flow from there — PM expansion, repo/branch
// determination, opening the worker tab, and removing the item from
// BACKLOG.md itself (see orchestrator-prompt.md's "Backlog" section); this
// endpoint doesn't touch BACKLOG.md or create a task directly.
app.post('/backlog/dispatch', async (req, res) => {
  try {
    const { description, context, project } = req.body ?? {}
    if (typeof description !== 'string' || !description.trim()) return res.sendStatus(400)
    if (project !== undefined && project !== null && (typeof project !== 'string' || !isBacklogProject(project))) {
      console.error('Backlog dispatch: rejected a malformed project', { project })
      return res.sendStatus(400)
    }

    const projectClause = renderBacklogProjectClause(project)
    const message = typeof context === 'string' && context
      ? `Let's do this backlog item${projectClause}: ${description} — ${context}`
      : `Let's do this backlog item${projectClause}: ${description}`

    const result = await writeToOrchestrator(message, 'send')
    if (result.status === 'ok') return res.sendStatus(200)
    return respondOrchestratorWriteFailure(res, result)
  } catch (err) {
    console.error('Failed to dispatch backlog item to orchestrator:', err)
    res.sendStatus(500)
  }
})

// POST /batch-dispatch — stage ONE combined command for a whole batch (a
// wave's queued/unblocked milestones, or the backlog's checked items) into
// the orchestrator's own session, unsent, for the developer to review before
// running it. The one route both batch surfaces share (see
// tech-design.md's requirement 1) — never auto-submits, unlike the deleted
// POST /pipelinely-dev/:slug this replaces, which is exactly the incident this
// route exists to remove. Body: BatchDispatchRequest (composeBatchMessage
// earns the type out of untrusted JSON; see its own comment for why the
// check lives there and not at this boundary).
app.post('/batch-dispatch', async (req, res) => {
  try {
    const message = composeBatchMessage(req.body)
    if (!message) {
      console.error('Batch dispatch: rejected a malformed batch request', { kind: req.body?.kind })
      return res.sendStatus(400)
    }
    const result = await writeToOrchestrator(message, 'stage')
    if (result.status === 'ok') return res.sendStatus(200)
    return respondOrchestratorWriteFailure(res, result)
  } catch (err) {
    console.error('Failed to stage batch dispatch to orchestrator:', err)
    res.sendStatus(500)
  }
})

// POST /stage-skill/:slug — stage the correct /cockpit-<stage> [<slug>]
// invocation into the right tmux session (the orchestrator's own for most
// stages, the task's own for qa-fixes/comment-fix), unsent, for the
// developer to review before running it. Body: { stage: Stage }.
app.post('/stage-skill/:slug', async (req, res) => {
  try {
    const stage = req.body?.stage
    const route = STAGE_SKILL[stage as Stage]
    if (!route) return res.sendStatus(400) // 'planning'/'merge'/unknown — nothing to stage

    // Own-session gets slug validation for free below via currentTasks.find().
    // Orchestrator-target stages skip that lookup (see comment below), so the
    // slug needs its own charset check here before it's concatenated into the
    // staged command — SAFE_TOKEN mirrors buildTmuxAttachCommand's guard.
    if (route.target === 'orchestrator' && !SAFE_TOKEN.test(req.params.slug)) {
      return res.sendStatus(400)
    }

    const text = composeStageCommand(route.skillName, route.target === 'own-session' ? null : req.params.slug)

    // Two independent conditions, both required. The body flag says "this
    // device's developer asked for auto-submit"; the socket address says "and
    // this really is a remote access context". A localhost request is staged
    // no matter what it asks for — from the desktop browser, from a stray
    // script, from a future bug in the client — which is the regression
    // constraint, enforced here rather than trusted to the client. `=== true`
    // rather than a truthy check so a client sending a string or a number
    // gets the safe answer too.
    //
    // A 'send' never raises iTerm2: this write fires unattended, triggered
    // from a phone while the developer may be working in an unrelated app on
    // the desktop.
    const shouldAutoSubmit = req.body?.autoSubmit === true && requestIsRemote(req) && requestAccess(res) === 'remote-authenticated'
    const mode: DispatchWriteMode = shouldAutoSubmit ? 'send' : 'stage'

    if (route.target === 'orchestrator') {
      // No currentTasks lookup here on purpose: an undispatched milestone
      // (e.g. "Start Dev" on fanout-parent-m1) has no task dir yet — that's
      // exactly what /pipelinely-dev is about to create. writeToOrchestrator
      // reads ORCHESTRATOR_SESSION/ORCHESTRATOR_TMUX itself.
      const result = await writeToOrchestrator(text, mode)
      if (result.status === 'ok') return res.json({ submitted: shouldAutoSubmit })
      if (result.status === 'not-canonical') return res.status(403).json({ error: NOT_CANONICAL_ERROR })
      if (result.status === 'stray-process') {
        return res.status(503).json({
          error: 'Orchestrator tmux session found but is not running claude — it is sitting at a shell prompt; check it manually',
        })
      }
      if (result.status === 'locked') {
        return respondOrchestratorLocked(res)
      }
      return respondTmuxPaneFailure(res, result)
    }

    const task = currentTasks.find(t => t.slug === req.params.slug)
    if (!task) return res.sendStatus(404)

    const tmuxResult = await writeToTaskSessionViaTmux(task, req.params.slug, text, mode)
    if (tmuxResult.status === 'ok') return res.json({ submitted: shouldAutoSubmit })
    return respondTaskTmuxFailure(res, tmuxResult)
  } catch (err) {
    console.error(`Failed to stage /pipelinely-${req.body?.stage} for ${req.params.slug}:`, err)
    res.sendStatus(500)
  }
})

// POST /pipelinely-handover/:slug — stage `/pipelinely-handover` into the task's own tmux session,
// unsent, for the developer to review before running it. Staging brings the
// task's tab forward (reattaching one if none is attached): a staged command
// the developer can't find is useless.
app.post('/pipelinely-handover/:slug', async (req, res) => {
  const { slug } = req.params
  try {
    const task = currentTasks.find((t) => t.slug === slug)
    if (!task) return res.sendStatus(404)

    const tmuxResult = await writeToTaskSessionViaTmux(task, slug, HANDOVER_COMMAND, 'stage')
    if (tmuxResult.status === 'ok') return res.sendStatus(200)
    return respondTaskTmuxFailure(res, tmuxResult)
  } catch (err) {
    console.error(`Failed to stage /pipelinely-handover for ${slug}:`, err)
    res.sendStatus(500)
  }
})

// POST /annotate-plan/:slug — opens Plannotator's annotation UI against the
// task's tracked tech-design.md, in its own dedicated tab/tmux session (see
// openAnnotationSession's own comment for why never the orchestrator's own
// session). Named to match the existing `/${action}/${slug}` route shape so
// the client's generic doAction() fallback handles this with no new JS.
app.post('/annotate-plan/:slug', async (req, res) => {
  const { slug } = req.params
  try {
    await fs.access(path.join(TASKS_DIR, slug, 'tech-design.md'))
  } catch {
    return res.sendStatus(404)
  }
  try {
    const result = await openAnnotationSession(slug, TASKS_DIR)
    if (result.status === 'ok') return res.sendStatus(200)
    console.error(`Failed to open annotation session for ${slug}: ${result.error}`)
    return res.status(500).json({ error: result.error })
  } catch (err) {
    console.error(`Failed to open annotation session for ${slug}:`, err)
    res.sendStatus(500)
  }
})

// POST /skip-stage/:slug — bypasses qa-fixes/comment-fix without dispatching
// a fixer skill, for a checklist with nothing worth acting on. Writes
// TIMELINE + STATUS directly (see SKIP_STAGE in taskParser.ts) — the same
// two files a real worker finishing that stage would write, so the rest of
// the pipeline (computeStage, computeNextStageCta) treats a skip exactly
// like a normal completion. Body: { stage: 'qa-fixes' | 'comment-fix' }.
app.post('/skip-stage/:slug', async (req, res) => {
  try {
    const stage = req.body?.stage
    const skip = SKIP_STAGE[stage as Stage]
    if (!skip) return res.sendStatus(400)

    const task = currentTasks.find(t => t.slug === req.params.slug)
    if (!task) return res.sendStatus(404)

    await appendTimelineLine(path.join(TASKS_DIR, req.params.slug), stage as Stage, skip.timelineNote)
    await fs.writeFile(path.join(TASKS_DIR, req.params.slug, 'STATUS'), `waiting: ${skip.nextWaitingReason}\n`)

    await refreshTasks()
    res.sendStatus(200)
  } catch (err) {
    console.error(`Failed to skip ${req.body?.stage} for ${req.params.slug}:`, err)
    res.sendStatus(500)
  }
})

// POST /design-approval/:slug — the designer's gate in the ds pipeline. Body:
// { decision: 'approve' } or { decision: 'request-changes', notes }. Writes the
// same TIMELINE + STATUS a stage's worker would (see applyDesignApproval), so
// the merge gate and the next-stage hand-offs read it like any other stage.
app.post('/design-approval/:slug', async (req, res) => {
  const task = currentTasks.find(t => t.slug === req.params.slug)
  if (!task) return res.sendStatus(404)

  try {
    const outcome = await applyDesignApproval(TASKS_DIR, task, req.body)
    switch (outcome) {
      case 'not-at-gate':
        console.error(`Design approval refused for ${task.slug}: not waiting at the design-approval gate`)
        return res.status(409).json({ error: 'This task is not waiting for design approval' })
      case 'blank-notes':
        return res.status(400).json({ error: 'Change notes are required to request changes' })
      case 'invalid-decision':
        return res.status(400).json({ error: "decision must be 'approve' or 'request-changes'" })
      case 'approved':
      case 'changes-requested':
        await refreshTasks()
        return res.json({ decision: outcome })
    }
  } catch (err) {
    console.error(`Failed to record the design approval decision for ${task.slug}:`, err)
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// GET /task-asset/:slug/design-qa/:file — design QA's Storybook and Figma
// screenshots, which live in the tasks dir outside every static mount. Serves
// only an image directly inside <task>/design-qa/ (see resolveDesignQaAsset).
app.get('/task-asset/:slug/design-qa/:file', async (req, res) => {
  try {
    const asset = await resolveDesignQaAsset(TASKS_DIR, req.params.slug, req.params.file)
    if (!asset.ok) return res.sendStatus(asset.status)
    res.type(asset.contentType).sendFile(asset.filePath)
  } catch (err) {
    console.error(`Failed to serve design QA asset ${req.params.slug}/${req.params.file}:`, err)
    res.sendStatus(500)
  }
})

// Coerces the `original` BacklogItem snapshot out of a request body for the
// backlog edit/dismiss endpoints below — both use it purely as an opaque
// concurrency-guard value (see applyBacklogEdit/applyBacklogRemoval in
// taskParser.ts), so a malformed field just becomes a value that won't match
// what's on disk rather than a thrown error.
function coerceBacklogOriginal(body: any): BacklogItem | null {
  const original = body?.original
  if (!original || typeof original !== 'object') return null
  return {
    description: typeof original.description === 'string' ? original.description : '',
    date: typeof original.date === 'string' ? original.date : null,
    context: typeof original.context === 'string' ? original.context : null,
    shelvedSlug: typeof original.shelvedSlug === 'string' ? original.shelvedSlug : null,
    // Load-bearing: without this, matchesOriginal fails for every tagged
    // item, and edit, dismiss and resume would all return 409.
    project: typeof original.project === 'string' ? original.project : null,
    done: original.done === true,
  }
}

// POST /backlog/edit/:index — rewrite an existing backlog item's
// description/date/context in place. Index-addressed, matching how
// parseBacklogContent produces the array in file order, with an `original`
// snapshot as a concurrency guard: if BACKLOG.md changed underneath the edit
// (backlogWatcher fired from a dispatch, or a different edit landed first)
// since the client last fetched, the index may now point at a different
// item — refuse rather than silently rewriting the wrong line. See
// applyBacklogEdit in taskParser.ts.
app.post('/backlog/edit/:index', async (req, res) => {
  try {
    const index = Number(req.params.index)
    if (!Number.isInteger(index) || index < 0) return res.sendStatus(400)

    const { description, date, context, project } = req.body ?? {}
    if (typeof description !== 'string' || !description.trim()) return res.sendStatus(400)
    const original = coerceBacklogOriginal(req.body)
    if (!original) return res.sendStatus(400)

    const raw = await fs.readFile(BACKLOG_PATH, 'utf-8').catch(() => null)
    if (raw === null) return res.sendStatus(404)

    const result = applyBacklogEdit(
      raw,
      index,
      original,
      {
        description: description.trim(),
        date: typeof date === 'string' && date.trim() ? date.trim() : null,
        context: typeof context === 'string' && context.trim() ? context.trim() : null,
        project: typeof project === 'string' ? project : null,
      },
    )

    if (!result.ok) {
      console.error(`Failed to edit backlog item at index ${index}: ${result.error}`)
      return res.status(result.error === 'conflict' ? 409 : 400).json({ error: result.error })
    }

    await fs.writeFile(BACKLOG_PATH, result.content)
    await refreshBacklog()
    res.sendStatus(200)
  } catch (err) {
    console.error(`Failed to edit backlog item at index ${req.params.index}:`, err)
    res.sendStatus(500)
  }
})

// POST /backlog/dismiss/:index — permanently remove a backlog item.
// Index-addressed and concurrency-guarded the same way as
// POST /backlog/edit/:index above; see applyBacklogRemoval in taskParser.ts.
app.post('/backlog/dismiss/:index', async (req, res) => {
  try {
    const index = Number(req.params.index)
    if (!Number.isInteger(index) || index < 0) return res.sendStatus(400)

    const original = coerceBacklogOriginal(req.body)
    if (!original) return res.sendStatus(400)

    const raw = await fs.readFile(BACKLOG_PATH, 'utf-8').catch(() => null)
    if (raw === null) return res.sendStatus(404)

    const result = applyBacklogRemoval(raw, index, original)

    if (!result.ok) {
      console.error(`Failed to dismiss backlog item at index ${index}: ${result.error}`)
      return res.status(result.error === 'conflict' ? 409 : 400).json({ error: result.error })
    }

    await fs.writeFile(BACKLOG_PATH, result.content)
    await refreshBacklog()
    res.sendStatus(200)
  } catch (err) {
    console.error(`Failed to dismiss backlog item at index ${req.params.index}:`, err)
    res.sendStatus(500)
  }
})

// POST /backlog/resume/:index — puts a shelved entry back on the board. The
// inverse of POST /shelve/:slug, and deliberately NOT /backlog/dispatch:
// dispatch is the promote-fresh path (it pastes "Let's do this backlog item"
// at the orchestrator, which would create a second task dir, worktree and
// branch for work that already exists). Index-addressed and
// concurrency-guarded exactly like /backlog/edit and /backlog/dismiss.
//
// `paused: resumed from backlog` is the deliberate landing state: a task
// coming back has no live session and no worktree, which is exactly what the
// board's existing "↺ Resume" CTA already handles — and /focus/:slug's
// dead-session fallback now also tells the orchestrator to recreate the
// missing worktree from the branch first.
//
// STATUS is written before the entry is removed, the same "a visible
// duplicate beats an invisible task" reasoning /shelve applies in the other
// direction: a failure after the STATUS write leaves the task back on the
// board *and* a stale backlog row the developer can waive, which beats a
// task that is off the backlog and still off both tabs.
app.post('/backlog/resume/:index', async (req, res) => {
  try {
    const index = Number(req.params.index)
    if (!Number.isInteger(index) || index < 0) return res.sendStatus(400)

    const original = coerceBacklogOriginal(req.body)
    if (!original) return res.sendStatus(400)

    const raw = await fs.readFile(BACKLOG_PATH, 'utf-8').catch(() => null)
    if (raw === null) return res.sendStatus(404)

    const lookup = findResumableBacklogSlug(raw, index, original)
    if (!lookup.ok) {
      console.error(`Failed to resume backlog item at index ${index}: ${lookup.error}`)
      const error = lookup.error === 'not-shelved'
        ? 'That item was never dispatched — use Run instead'
        : lookup.error
      return res.status(lookup.error === 'conflict' ? 409 : 400).json({ error })
    }

    // The stranded-pointer case: report it rather than deleting the entry,
    // so the developer can still see it and waive it by hand.
    const task = currentTasks.find(t => t.slug === lookup.slug)
    if (!task) {
      console.error(`Failed to resume backlog item at index ${index}: task dir ${lookup.slug} is gone`)
      return res.status(404).json({ error: 'That task directory is gone — nothing to resume' })
    }

    await fs.writeFile(
      path.join(TASKS_DIR, task.slug, 'STATUS'),
      'paused: resumed from backlog\n',
    )
    if (task.stage) {
      await fs.appendFile(
        path.join(TASKS_DIR, task.slug, 'TIMELINE'),
        `${new Date().toISOString()} ${task.stage} resumed from backlog\n`,
      )
    }

    const result = applyBacklogRemoval(raw, index, original)
    if (!result.ok) {
      console.error(`Failed to remove resumed backlog item at index ${index}: ${result.error}`)
      return res.status(result.error === 'conflict' ? 409 : 400).json({ error: result.error })
    }
    await fs.writeFile(BACKLOG_PATH, result.content)

    await refreshTasks()
    await refreshBacklog()
    res.sendStatus(200)
  } catch (err) {
    console.error(`Failed to resume backlog item at index ${req.params.index}:`, err)
    res.sendStatus(500)
  }
})

// Chokidar watcher
const watcher = chokidar.watch(
  path.join(TASKS_DIR, '**', '{STATUS,METRICS,METRICS-*.json,DEV_URL,PLAN.md,VERIFY,TIMELINE,QA_REPORT.md,task-pr-review.md,tech-design.md,RESULT.md,AUDIT.md,DESIGN.md,FINDINGS.md,TASK.md,TRIAGE.json,QA_TRIAGE.json,AUTO_MODE,CREATURE,KIND,DESIGN_QA.md,DESIGN_FEEDBACK.md}'),
  { ignoreInitial: true, usePolling: false }
)
watcher.on('all', () => { refreshTasks().catch(console.error) })

const weeklyFocusWatcher = chokidar.watch(WEEKLY_FOCUS_PATH, { ignoreInitial: true, usePolling: false })
weeklyFocusWatcher.on('all', () => { refreshWeeklyFocus().catch(console.error) })

const backlogWatcher = chokidar.watch(BACKLOG_PATH, { ignoreInitial: true, usePolling: false })
backlogWatcher.on('all', () => { refreshBacklog().catch(console.error) })

const settingsWatcher = chokidar.watch(SETTINGS_PATH, { ignoreInitial: true, usePolling: false })
settingsWatcher.on('all', () => { refreshSettings().catch(console.error) })

// A single-path watcher, mirroring weeklyFocusWatcher/backlogWatcher exactly
// — the main `watcher` glob above only matches basenames inside a task
// directory (STATUS/METRICS/etc.), and ORCHESTRATOR_METRICS sits at the
// tasks-dir root, so it is invisible to it. Re-parsing every task directory
// via refreshTasks to pick up one integer would be the wrong trade.
const orchestratorMetricsWatcher = chokidar.watch(
  path.join(TASKS_DIR, 'ORCHESTRATOR_METRICS'),
  { ignoreInitial: true, usePolling: false }
)
orchestratorMetricsWatcher.on('all', () => { refreshOrchestratorContext().catch(console.error) })

// Independent of file-change events — without this, a dashboard left open
// overnight with no task activity would keep "Today"'s date group stale
// until the next STATUS/METRICS/etc. write anywhere.
setInterval(() => { refreshTasks().catch(console.error) }, 5 * 60 * 1000)

// A pane change touches no file, so the watcher never fires for a worker that
// stops on a permission dialog; poll the panes (read-only) instead.
const APPROVAL_POLL_MS = Number(process.env.COCKPIT_APPROVAL_POLL_MS ?? 10_000)
const approvalPollState = createApprovalPollState()
const approvalTick = createApprovalTicker({
  poll: () => pollApprovalPrompts(currentTasks, productionApprovalWatchDeps, approvalPollState),
  onChange: async (prompts) => {
    currentApprovalPrompts = prompts
    await refreshTasks()
  },
  logError: console.error,
})
setInterval(() => { approvalTick() }, APPROVAL_POLL_MS)

// PORT=0 is a legitimate "let the OS assign a free port" request (standard
// net.Server semantics) — .listen(0, ...) binds a real ephemeral port under
// the hood, but the pre-listen PORT constant stays literally 0. Read the
// actual bound port back off the listening server instead of assuming
// address() returns the shape we expect (guaranteed here since we bind an
// IP, not a Unix socket — but observable rather than silently wrong if that
// ever stops holding).
export function resolveBoundPort(address: ReturnType<Server['address']>, fallbackPort: number): number {
  if (address && typeof address === 'object') {
    return address.port
  }
  console.error(
    `app.listen() did not return a network address (got ${JSON.stringify(address)}) — falling back to the pre-listen PORT value ${fallbackPort}, which is wrong if PORT=0 asked the OS for an ephemeral port.`,
  )
  return fallbackPort
}

// Startup
export async function main(): Promise<Server> {
  // refreshSettings already awaits refreshTasks — calling both would run the
  // advancement pass twice at startup. That second pass would be harmless
  // (every slug is already seeded with an unchanged key, so nothing
  // dispatches), but only by accident, and the seeding rule is the one thing
  // standing between a restart and a re-fired handoff. One call.
  await refreshSettings()       // initial load (DEFAULT_SETTINGS if file missing), then refreshTasks
  await refreshWeeklyFocus()
  await refreshBacklog()        // initial load (empty array if file missing)
  await refreshOrchestratorContext() // initial load (null if file missing)
  // Resolved before anything listens so a bad PIPELINELY_HOST fails startup
  // loudly instead of falling back to a bind the developer did not ask for.
  const bindHosts = resolveBindHosts(process.env)
  const server = await listenOnHosts(app, bindHosts, PORT)
  const boundPort = resolveBoundPort(server.address(), PORT)
  const url = dashboardUrl(bindHosts, boundPort)
  console.log(`Pipelinely running at ${url}`)
  // A leaked override would make this server trust whatever token that file
  // holds, so it must never be silent.
  if (process.env[REMOTE_TOKEN_FILE_ENV_VAR]?.trim()) {
    console.log(`Remote-access token file overridden by ${REMOTE_TOKEN_FILE_ENV_VAR}: ${currentRemoteTokenFile()}`)
  }
  const isRemoteAccessOn = await isRemoteAccessEnabled()
  wideBindWarnings(bindHosts, boundPort, isRemoteAccessOn).forEach((warning) => console.warn(warning))
  // Opt-in, not opt-out: most callers of main() are not a developer
  // sitting in front of the dashboard (playwright's webServer, every
  // dispatched task's own "start the dev server for QA" step, etc.), so
  // popping a real browser tab must be something a caller explicitly
  // asks for via COCKPIT_AUTO_OPEN_BROWSER rather than something every
  // new spawn site has to remember to opt out of.
  if (process.env.COCKPIT_AUTO_OPEN_BROWSER) {
    open(url).catch(console.error)
  }
  return server
}

// Vitest sets this automatically — importing the module for server.test.ts
// must not also app.listen(3030), open a real browser tab, or watch the
// developer's real TASKS_DIR.
if (!process.env.VITEST) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
