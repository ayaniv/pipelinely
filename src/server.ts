import express from 'express'
import chokidar from 'chokidar'
import {
  parseAllTasks,
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
  DEFAULT_SETTINGS,
  parseSummarySection,
  stripSummarySection,
  parseOrchestratorMetrics,
  isBacklogProject,
} from './taskParser.js'
import type { PlanTestGroup } from './types.js'
import { renderMarkdownToHtml } from './markdown.js'
import { loadStageScopes } from './stageScope.js'
import {
  reattachOrFocus,
  openVSCode,
  openBrowserUrl,
  pasteIntoSession,
  pasteIntoSessionQuiet,
  stageInSession,
  tmuxSessionExists,
  reattachAndRecord,
  findSessionAttachedToTmux,
  tmuxPaneIsStrayShell,
  sessionIsClientOf,
  openAnnotationSession,
  pasteIntoTrackedSession,
  normalizeWhitespace,
  type TrackedSessionPasteResult,
} from './focusTab.js'
import { commitAndRemoveWorktree, findOpenPrNumberByBranch, openPrInBrowser } from './gitOps.js'
import { attachResolvedPrNumbers, createPrNumberCache, repoPrNumberLookup } from './prLookup.js'
import { markTaskDone, mergeTask } from './taskCompletion.js'
import { formatMergeBlockers } from './mergeGate.js'
import { withOrchestratorLock, OrchestratorLockTimeoutError } from './orchestratorLock.js'
import { composeBatchMessage, SAFE_TOKEN, renderBacklogProjectClause } from './batchDispatch.js'
import { ActiveProjectProgress, AutoModeOverride, BacklogItem, DoneDateGroup, Settings, Stage, Task } from './types.js'
import path from 'path'
import fs from 'node:fs/promises'
import type { Server } from 'node:http'
import open from 'open'
import { fileURLToPath } from 'url'
import { defaultPortForCwd } from './derivePort.js'
import { resolveTasksDir } from './tasksDir.js'
import { requestIsRemote } from './remoteAccess.js'
import { sanitizeInheritedEnv, SERVER_STARTUP_LEAK_VARS } from './sanitizeInheritedEnv.js'

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
// Resolved off __dirname, the same way `GET /` resolves public/index.html —
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
const WEEKLY_FOCUS_PATH = path.join(TASKS_DIR, 'WEEKLY_FOCUS')
// BACKLOG.md is a sibling file at the top of TASKS_DIR, not a task
// subdirectory — parsed separately from parseAllTasks.
const BACKLOG_PATH = path.join(TASKS_DIR, 'BACKLOG.md')
// Written by the /pipelinely skill on startup — its own iTerm2 session
// id, so the backlog's "Start" button knows which tab to paste into.
const ORCHESTRATOR_SESSION_PATH = path.join(TASKS_DIR, 'ORCHESTRATOR_SESSION')
// Also written by /pipelinely, but only when it's running inside tmux —
// the session name to reattach to when the recorded iTerm tab is gone.
const ORCHESTRATOR_TMUX_PATH = path.join(TASKS_DIR, 'ORCHESTRATOR_TMUX')
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
  | { status: 'reattached-failed' }
  | { status: 'stray-process' }
  | { status: 'no-session'; hadRecordedSession: boolean }
  | { status: 'locked' }
  | { status: 'not-canonical' }

// Writes `text` into the orchestrator's own iTerm2 session (registered via
// ORCHESTRATOR_SESSION by /pipelinely), reattaching a
// detached-but-alive tmux session first if the recorded tab is gone — and
// verifying, before every write, that the tmux pane it is about to write
// into has not fallen back to a shell (see tmuxPaneIsStrayShell). `write` is
// the only thing that varies between callers: pasteIntoSession (types and
// sends — /backlog/dispatch, the /focus/:slug fallback) or stageInSession
// (types and leaves it unsent for review — /stage-skill,
// /orchestrator/pipelinely-handover). The liveness-check -> reattach -> retry logic
// lives here and nowhere else.
//
// The whole read-decide-write body runs under withOrchestratorLock: every
// caller (the four listed above, plus POST /orchestrator/tab, which reads
// and can rewrite the same two pointer files directly) used to run this
// independently, with nothing stopping two concurrent callers from reading
// the pointers, deciding, and writing out of order with each other — see
// FINDINGS.md's "Mechanism A" for the incident this caused (a message meant
// for one target landing, via a stale/racily-adopted session id, in a
// different live pane). The lock makes "read the pointers, decide how to
// heal them, type into the result" one atomic unit with respect to every
// other pointer-touching caller in this process, so no caller can ever act
// on a pointer value another caller is concurrently changing underneath it.
async function writeToOrchestrator(
  text: string,
  write: (sessionId: string, text: string) => Promise<boolean>,
): Promise<OrchestratorWriteResult> {
  // Checked first, before ever touching the lock file or ORCHESTRATOR_SESSION
  // — a non-canonical instance has no business reading or racing over those
  // pointer files at all, only rejecting outright.
  if (!isCanonicalDispatchInstance()) return { status: 'not-canonical' }
  try {
    return await withOrchestratorLock(TASKS_DIR, () => writeToOrchestratorLocked(text, write))
  } catch (error) {
    if (error instanceof OrchestratorLockTimeoutError) {
      console.error(error.message)
      return { status: 'locked' }
    }
    throw error
  }
}

async function writeToOrchestratorLocked(
  text: string,
  write: (sessionId: string, text: string) => Promise<boolean>,
): Promise<OrchestratorWriteResult> {
  const sessionId = (await fs.readFile(ORCHESTRATOR_SESSION_PATH, 'utf-8').catch(() => '')).trim()
  const tmuxSession = (await fs.readFile(ORCHESTRATOR_TMUX_PATH, 'utf-8').catch(() => '')).trim()

  // Identity (FINDINGS.md item 2): the lock alone does nothing about a
  // pointer that was already wrong when the critical section opened — a
  // live-but-unrelated recorded tab still accepts a `write text` cleanly, so
  // the fast path below must not trust the recorded id on sight. When
  // ORCHESTRATOR_TMUX names a live session, the recorded tab must actually
  // be a client of it to count as "the orchestrator"; if it's absent, dead,
  // or names a session this tab isn't attached to (pipelinely only
  // writes that file when $TMUX is set, and never clears it, so it can be
  // stale), there is nothing to verify and the recorded tab is trusted
  // exactly as before. Computed once and shared with the stray-shell gate
  // below rather than calling sessionIsClientOf twice. Also short-circuits
  // on an empty sessionId — no tab was ever recorded, so there's nothing to
  // check identity against, and both `sessionId &&`-guarded callers below
  // ignore this value anyway; skipping avoids a wasted osascript/tmux round
  // trip whose result is guaranteed false.
  const tmuxRecordedAndLive = !!tmuxSession && await tmuxSessionExists(tmuxSession)
  const recordedTabIsTheOrchestrator =
    !tmuxRecordedAndLive || !sessionId || await sessionIsClientOf(sessionId, tmuxSession)

  // Step 0 — before the fast-path write. Only meaningful when the recorded
  // tab is genuinely a client of the recorded tmux session — then, and only
  // then, is that pane's foreground command a statement about where our
  // keystrokes are going. If identity doesn't hold, there's nothing to
  // inspect here; the routing below (fall through to adopt/reattach) is what
  // handles it.
  if (
    sessionId && tmuxRecordedAndLive && recordedTabIsTheOrchestrator &&
    await tmuxPaneIsStrayShell(tmuxSession)
  ) {
    return { status: 'stray-process' }
  }

  // Identity-gated: a recorded tab that is live but NOT a client of a live
  // ORCHESTRATOR_TMUX is routed away from here — this is a routing decision,
  // not a new refusal path, so it falls through to the adopt/reattach heal
  // below rather than returning any new status.
  if (sessionId && recordedTabIsTheOrchestrator && await write(sessionId, text)) return { status: 'ok' }

  // The recorded iTerm session is gone (tab closed) or was never recorded,
  // or ORCHESTRATOR_TMUX itself is absent/dead — nothing to reattach/adopt.
  if (!tmuxRecordedAndLive) {
    return { status: 'no-session', hadRecordedSession: !!sessionId }
  }

  // Step 3 — before adopt and before reattach: one check in front of both
  // heal branches, since they're both about to write into this same pane.
  if (await tmuxPaneIsStrayShell(tmuxSession)) {
    return { status: 'stray-process' }
  }

  // A tab is already attached to this tmux session (e.g. the recorded id
  // went stale while the orchestrator's tab stayed on screen the whole
  // time) — adopt it rather than reattach, which would forcibly detach it.
  const adoptedSessionId = await findSessionAttachedToTmux(tmuxSession)
  if (adoptedSessionId) {
    await fs.writeFile(ORCHESTRATOR_SESSION_PATH, adoptedSessionId)
    if (await write(adoptedSessionId, text)) return { status: 'ok' }
    return { status: 'reattached-failed' }
  }

  // No local tab is attached, so reattachTmuxSession's `-d` is now correct.
  // reattachTmuxSession only returns once it has *verified* the new tab's
  // tmux client actually attached (see its own comment) — not just that the
  // tab exists — so the pty is already live by the time we get here and an
  // immediate retry write is safe. No arbitrary sleep needed: confirmed by
  // repeated live testing against a real orchestrator session (reattach +
  // immediate paste succeeded every trial).
  const newSessionId = await reattachAndRecord(tmuxSession, ORCHESTRATOR_SESSION_PATH)
  if (newSessionId) {
    if (await write(newSessionId, text)) return { status: 'ok' }
    return { status: 'reattached-failed' }
  }

  return { status: 'no-session', hadRecordedSession: !!sessionId }
}

// Submits `/cockpit-<skill> <slug>` into the orchestrator's own session for
// a stage whose STAGE_SKILL entry targets it. THE single automated dispatch
// path: the wave-batch route (POST /pipelinely-dev/:slug) and auto mode's
// advancement pass both go through here, so a second unattended dispatcher
// cannot fork a path that skips the liveness/self-heal checks
// writeToOrchestrator owns.
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
    return { status: 'no-session', hadRecordedSession: false }
  }
  return writeToOrchestrator(composeStageCommand(route.skillName, slug), pasteIntoSession)
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
  if (result.status === 'reattached-failed') return 'orchestrator reattached but the retry failed'
  if (result.status === 'stray-process') return 'orchestrator tmux session found but not running claude'
  if (result.status === 'no-session') {
    return result.hadRecordedSession ? 'orchestrator tab not found' : 'orchestrator not running'
  }
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
  const note = ok ? 'auto-dispatched — auto mode' : `auto-dispatch failed — ${autoDispatchFailureReason(result)}`

  if (!ok) {
    console.error(`[auto-mode] dispatch failed for ${slug} -> ${stage}: ${autoDispatchFailureReason(result)}`)
  }

  try {
    await fs.appendFile(path.join(TASKS_DIR, slug, 'TIMELINE'), `${new Date().toISOString()} ${stage} ${note}\n`)
  } catch (err) {
    console.error(`[auto-mode] failed to append TIMELINE for ${slug}:`, err)
  }
}

async function runAutoAdvancePassOnce(): Promise<void> {
  // Phase 1 — synchronous, no await anywhere in it. Interleaving
  // "decide, record, await" per task would leave the map half-updated
  // across an await point, which the rerun flag above can observe.
  const toDispatch: { slug: string; stage: Stage }[] = []
  const seenSlugs = new Set<string>()

  for (const task of currentTasks) {
    seenSlugs.add(task.slug)
    const auto = computeAutoDispatch(task)
    const key = auto?.key ?? null

    // A task seen for the first time (server start, or a brand-new task
    // dir) is seeded and never dispatched, so a restart cannot re-fire a
    // standing handoff. Safe rather than lossy: the orchestrator writes
    // 'working' to a new task's STATUS before it ever opens the tab, so no
    // task dir's first observed state is an eligible handoff.
    if (lastAutoKey.has(task.slug) && auto !== null && key !== lastAutoKey.get(task.slug) && task.autoMode) {
      toDispatch.push({ slug: task.slug, stage: auto.stage })
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
  for (const { slug, stage } of toDispatch) {
    await dispatchAndRecordAuto(slug, stage)
  }
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

// The reattached-failed / stray-process / locked / no-session -> HTTP mapping
// shared by every route whose write goes through writeToOrchestrator and
// isn't a plain 'ok'. `logContext` names the calling route in the log line;
// `retryHint` is the one sentence of caller-specific wording appended to the
// 409 body (e.g. "Click Run again." vs "Click Start again."). The 409 log
// line reads "the retry write still failed" — not "paste" — because a
// staged route (POST /batch-dispatch) never attempts a paste at all, and
// this body is shared with a route that does (/backlog/dispatch); a verb
// true of both is the only one that can't misreport what either route did.
function respondOrchestratorWriteFailure(
  res: express.Response,
  result: Exclude<OrchestratorWriteResult, { status: 'ok' }>,
  logContext: string,
  retryHint: string,
): void {
  if (result.status === 'not-canonical') {
    res.status(403).json({ error: NOT_CANONICAL_ERROR })
    return
  }

  if (result.status === 'reattached-failed') {
    console.error(`${logContext}: reattached orchestrator but the retry write still failed`)
    res.status(409).json({
      reattached: true,
      error: `Orchestrator was detached — reattached it in a new tab, but the message still failed to send. ${retryHint}`,
    })
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

  res.status(503).json({
    error: result.hadRecordedSession
      ? 'Orchestrator tab not found — it may have closed'
      : 'Orchestrator not running — no ORCHESTRATOR_SESSION found',
  })
}

// The reattach-paste-failed / no-session -> HTTP mapping shared by every
// route whose write goes through pasteIntoTrackedSession — the own-session
// sibling of respondOrchestratorWriteFailure. `wording` carries the phrases
// that differ per caller so the response bodies stay caller-specific without
// copying the mapping itself.
function respondTrackedSessionWriteFailure(
  res: express.Response,
  result: Exclude<TrackedSessionPasteResult, { status: 'ok' }>,
  wording: { logContext: string; failedRetry: string; noSessionVerb: string },
): void {
  if (result.status === 'reattach-paste-failed') {
    console.error(`${wording.logContext}: reattached its session but the retry write still failed`)
    res.status(409).json({
      reattached: true,
      error: `Session was gone — reattached a new tab, but ${wording.failedRetry}. Click again.`,
    })
    return
  }

  console.error(`${wording.logContext}: no live session and no tmux session to reattach (hadRecordedSession=${result.hadRecordedSession})`)
  res.status(503).json({
    error: result.hadRecordedSession
      ? "This task's own tab not found — it may have closed"
      : `This task has no recorded session to ${wording.noSessionVerb}`,
  })
}

export const app = express()
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
function buildSnapshot() {
  return {
    tasks: currentTasks,
    activeProject: currentActiveProject,
    weeklyFocus: currentWeeklyFocus,
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
const lookUpPrNumber = repoPrNumberLookup(findOpenPrNumberByBranch)

async function refreshTasks(): Promise<void> {
  const parsedTasks = await parseAllTasks(TASKS_DIR, currentSettings)
  currentTasks = await attachResolvedPrNumbers(parsedTasks, lookUpPrNumber, prNumberCache)
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
    currentWeeklyFocus = (await fs.readFile(WEEKLY_FOCUS_PATH, 'utf-8')).trim()
  } catch {
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

// The design's own illustrations (Claude Design project 76cb2c13…): the
// sidebar app mark and the two section-header heads. Scoped to public/art
// rather than public/ so this never becomes an accidental way to serve the
// rest of the checkout.
app.use('/art', express.static(path.join(__dirname, '..', 'public', 'art'), {
  fallthrough: false,
  maxAge: '1h',
}))

// GET / — serve the dashboard
app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'))
})

// GET /task/:slug — same dashboard shell; the client reads location.pathname
// on boot and opens straight into that task's detail view. Kept as a plain
// mirror of GET / (not a redirect) so a direct load/refresh here works
// without a round trip, and the client owns which task actually exists.
app.get('/task/:slug', (_, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'))
})

// GET /settings — same dashboard shell, opened straight into the settings
// page (mirrors GET /task/:slug's own reasoning). Distinct from POST
// /settings below, which actually writes the setting — Express dispatches
// on method, so the two coexist on the same path with no conflict.
app.get('/settings', (_, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'))
})

// GET /help — same dashboard shell, opened straight into the help page
// (mirrors GET /settings' own reasoning).
app.get('/help', (_, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'))
})

// GET /docs — same dashboard shell, opened straight into the Docs page
// (mirrors GET /help's own reasoning).
app.get('/docs', (_, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'))
})

// GET /backlog, GET /done, GET /you — same dashboard shell, opened straight
// into that board tab. '/' itself is the fourth board tab (In Progress) —
// see the client's own DEFAULT_TAB/tabUrl, which is why it doesn't need a
// route of its own here.
app.get('/backlog', (_, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'))
})
app.get('/done', (_, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'))
})
app.get('/you', (_, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'))
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
  res.json({ isRemoteAccess: requestIsRemote(req) })
})

// POST /weekly-focus — free-text banner describing this week's focus
app.post('/weekly-focus', async (req, res) => {
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

// POST /settings — the global auto-mode switch. Body: { autoMode: boolean }.
// Rejects a non-boolean rather than coercing: this is the switch that
// decides whether the machine spends money unattended, and "truthy" is not
// a good enough answer.
app.post('/settings', async (req, res) => {
  try {
    const autoMode = req.body?.autoMode
    if (typeof autoMode !== 'boolean') return res.sendStatus(400)
    await fs.writeFile(SETTINGS_PATH, JSON.stringify({ autoMode }))
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
    const message = buildDeadSessionMessage(req.params.slug, task)
    const result = await writeToOrchestrator(message, pasteIntoSession)
    if (result.status === 'ok') return res.status(202).json({ fallback: true })

    if (result.status === 'not-canonical') return res.status(403).json({ error: NOT_CANONICAL_ERROR })

    if (result.status === 'reattached-failed') {
      console.error(`Focus fallback for ${req.params.slug}: reattached orchestrator but the retry paste still failed`)
      return res.status(409).json({
        reattached: true,
        error: 'Session was gone — reattached the orchestrator in a new tab, but the resume message still failed to send. Click again.',
      })
    }

    if (result.status === 'stray-process') {
      return res.status(503).json({
        error: "Session gone, and the orchestrator's tmux session is not running claude — check it manually",
      })
    }

    if (result.status === 'locked') {
      return respondOrchestratorLocked(res)
    }

    console.error(`Focus fallback for ${req.params.slug}: no live session and orchestrator unreachable (${result.status})`)
    return res.status(503).json({
      error: result.hadRecordedSession
        ? 'Session gone and orchestrator tab not found — it may have closed'
        : 'Session gone and orchestrator not running — no ORCHESTRATOR_SESSION found',
    })
  } catch (err) {
    console.error(`Failed to focus/reattach ${req.params.slug}:`, err)
    res.sendStatus(500)
  }
})

// POST /orchestrator/tab — bring the orchestrator's own tab back: focus it
// if it is still live, otherwise reattach its surviving tmux session into a
// fresh tab. The same primitive the per-task "→ Terminal" button uses
// (reattachOrFocus), one level up. Distinct from the automatic heal in
// writeToOrchestrator: this is the developer asking for the tab itself, with
// nothing to dispatch into it — so it deliberately does not run Change 4's
// stray-shell gate (see that change's own scope note): refusing to even open
// the tab because claude isn't running there would block exactly the moment
// a developer wants to look at it, to restart claude themselves.
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
      const tmuxSession = (await fs.readFile(ORCHESTRATOR_TMUX_PATH, 'utf-8').catch(() => '')).trim() || null
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
    const result = await writeToOrchestrator(HANDOVER_COMMAND, stageInSession)
    if (result.status === 'ok') return res.sendStatus(200)
    return respondOrchestratorWriteFailure(res, result, 'Orchestrator handover', 'Click Handover again.')
  } catch (err) {
    console.error('Failed to stage /pipelinely-handover into the orchestrator:', err)
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
      stageInSession,
    )
    if (result.status === 'ok') return res.sendStatus(200)
    return respondOrchestratorWriteFailure(res, result, 'Help feedback', 'Click Send again.')
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
    if (!prNumber) return res.sendStatus(404)

    const repoPath = path.join(reposDir(), task.repo)
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
// client fetches this once per page load (see loadStageScope in
// index.html), so a skill edit shows up on the next dashboard reload with
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
    const { cleanupError } = await markTaskDone(TASKS_DIR, task)

    await refreshTasks()
    res.json({ cleaned: cleanupError === null, cleanupError })
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
      const cleanup = await commitAndRemoveWorktree(path.join(reposDir(), task.repo), task.worktree)
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
      case 'gate-unavailable':
      case 'merge-failed':
        console.error(`Merge failed for ${req.params.slug}:`, result.error)
        return res.status(503).json({ error: result.error })
      case 'merged':
        await refreshTasks()
        return res.json({ merged: true, prNumber: result.prNumber, cleaned: result.cleanupError === null, cleanupError: result.cleanupError })
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
// iTerm2 session (registered via ORCHESTRATOR_SESSION by /pipelinely),
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

    const result = await writeToOrchestrator(message, pasteIntoSession)
    if (result.status === 'ok') return res.sendStatus(200)
    return respondOrchestratorWriteFailure(res, result, 'Backlog dispatch', 'Click Start again.')
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
    const result = await writeToOrchestrator(message, stageInSession)
    if (result.status === 'ok') return res.sendStatus(200)
    return respondOrchestratorWriteFailure(res, result, 'Batch dispatch', 'Click Run again.')
  } catch (err) {
    console.error('Failed to stage batch dispatch to orchestrator:', err)
    res.sendStatus(500)
  }
})

// POST /stage-skill/:slug — stage the correct /cockpit-<stage> [<slug>]
// invocation into the right iTerm2 session (the orchestrator's own tab for
// most stages, the task's own tab for qa-fixes/comment-fix), unsent, for the
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
    // pasteIntoSessionQuiet, never pasteIntoSession: this write fires
    // unattended, triggered from a phone while the developer may be working
    // in an unrelated app on the desktop, so it must not raise iTerm2 to the
    // OS foreground. See that function's own comment.
    const shouldAutoSubmit = req.body?.autoSubmit === true && requestIsRemote(req)
    const write = shouldAutoSubmit ? pasteIntoSessionQuiet : stageInSession

    if (route.target === 'orchestrator') {
      // No currentTasks lookup here on purpose: an undispatched milestone
      // (e.g. "Start Dev" on fanout-parent-m1) has no task dir yet — that's
      // exactly what /pipelinely-dev is about to create. writeToOrchestrator
      // reads ORCHESTRATOR_SESSION/ORCHESTRATOR_TMUX itself.
      const result = await writeToOrchestrator(text, write)
      if (result.status === 'ok') return res.json({ submitted: shouldAutoSubmit })
      if (result.status === 'not-canonical') return res.status(403).json({ error: NOT_CANONICAL_ERROR })
      if (result.status === 'reattached-failed') {
        console.error(`Stage /pipelinely-${stage} for ${req.params.slug}: reattached the orchestrator but the retry stage still failed`)
        return res.status(409).json({
          reattached: true,
          error: 'Orchestrator was detached — reattached it in a new tab, but the command still failed to stage. Click again.',
        })
      }
      if (result.status === 'stray-process') {
        return res.status(503).json({
          error: 'Orchestrator tmux session found but is not running claude — it is sitting at a shell prompt; check it manually',
        })
      }
      if (result.status === 'locked') {
        return respondOrchestratorLocked(res)
      }
      return res.status(503).json({
        error: result.hadRecordedSession
          ? 'Orchestrator tab not found — it may have closed'
          : 'Orchestrator not running — no ORCHESTRATOR_SESSION found',
      })
    }

    const task = currentTasks.find(t => t.slug === req.params.slug)
    if (!task) return res.sendStatus(404)

    // TODO: this branch has no stray-shell gate. The orchestrator branch above
    // gets one from writeToOrchestrator (tmuxPaneIsStrayShell before every
    // write); this one writes to the task's own session directly, with no
    // lock and no pane inspection — true today for staging, and auto-submit
    // raises the stakes: submitting into a task tab that has fallen back to a
    // shell runs `/pipelinely-qa-fixes` as a shell command and gets `command not
    // found`. That is a visible annoyance in the task's own scratch tab, not
    // the class of incident the peer-address gate exists to prevent, so it is
    // accepted for now — see tech-design.md's "Known, accepted gap". Closing
    // it means plumbing task.tmuxSession through a new gate: a separate
    // change.
    //
    // pasteIntoTrackedSession, not a flat write to task.itermSessionId: gives
    // this branch the same reattach-and-retry resilience the orchestrator
    // branch above already has via writeToOrchestrator, and /pipelinely-handover/:slug
    // already has via this same helper — a closed tab whose tmux session is
    // still alive gets reattached into a fresh tab and re-recorded, rather
    // than a flat 503 the moment the tab that started this task's dev/CR/QA
    // stage happens to have closed since.
    const result = await pasteIntoTrackedSession(
      {
        sessionId: task.itermSessionId,
        tmuxSession: task.tmuxSession,
        sessionFilePath: path.join(TASKS_DIR, req.params.slug, 'ITERM_SESSION'),
      },
      text,
      { submit: shouldAutoSubmit, focus: !shouldAutoSubmit },
    )

    if (result.status === 'ok') {
      // Mirrors /pipelinely-handover/:slug: a reattach rewrites ITERM_SESSION on disk,
      // and without this currentTasks keeps the dead id until the next
      // 5-minute refresh, so a second click before then would reattach again
      // and open a duplicate tab.
      if (result.reattached) await refreshTasks()
      return res.json({ submitted: shouldAutoSubmit })
    }

    return respondTrackedSessionWriteFailure(res, result, {
      logContext: `Stage /pipelinely-${stage} for ${req.params.slug}`,
      failedRetry: 'the command still failed to stage',
      noSessionVerb: 'stage into',
    })
  } catch (err) {
    console.error(`Failed to stage /pipelinely-${req.body?.stage} for ${req.params.slug}:`, err)
    res.sendStatus(500)
  }
})

// POST /pipelinely-handover/:slug — stage `/pipelinely-handover` into the task's own tracked
// session, unsent, for the developer to review before running it. Goes
// through pasteIntoTrackedSession (not /stage-skill's own-session branch),
// which brings reattach-and-retry for a closed-tab-but-live-tmux task —
// /stage-skill's own-session branch lacks that and just 503s flat.
// `focus: true`: a staged-but-unsent command the developer can't find is
// useless — see stageInSession's own reasoning.
app.post('/pipelinely-handover/:slug', async (req, res) => {
  const { slug } = req.params
  try {
    const task = currentTasks.find((t) => t.slug === slug)
    if (!task) return res.sendStatus(404)

    const result = await pasteIntoTrackedSession(
      {
        sessionId: task.itermSessionId,
        tmuxSession: task.tmuxSession,
        sessionFilePath: path.join(TASKS_DIR, slug, 'ITERM_SESSION'),
      },
      HANDOVER_COMMAND,
      { submit: false, focus: true },
    )

    if (result.status === 'ok') {
      // Refreshing after the response would leave currentTasks holding the
      // dead session id, so a second click would reattach again and open a
      // duplicate tab. Scoped to the reattached case only, so the common
      // case's response isn't delayed by an SSE broadcast re-rendering the
      // card out from under it.
      if (result.reattached) await refreshTasks()
      return res.sendStatus(200)
    }

    return respondTrackedSessionWriteFailure(res, result, {
      logContext: `Handover for ${slug}`,
      failedRetry: 'the handover command still failed to stage',
      noSessionVerb: 'stage into',
    })
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

    const timelineLine = `${new Date().toISOString()} ${stage} ${skip.timelineNote}\n`
    await fs.appendFile(path.join(TASKS_DIR, req.params.slug, 'TIMELINE'), timelineLine)
    await fs.writeFile(path.join(TASKS_DIR, req.params.slug, 'STATUS'), `waiting: ${skip.nextWaitingReason}\n`)

    await refreshTasks()
    res.sendStatus(200)
  } catch (err) {
    console.error(`Failed to skip ${req.body?.stage} for ${req.params.slug}:`, err)
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
  path.join(TASKS_DIR, '**', '{STATUS,METRICS,METRICS-*.json,DEV_URL,PLAN.md,VERIFY,TIMELINE,QA_REPORT.md,task-pr-review.md,tech-design.md,TRIAGE.json,QA_TRIAGE.json,AUTO_MODE}'),
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
  // Explicit '0.0.0.0' rather than the default host: with no host given,
  // Node binds an IPv6-only-reachable socket on some setups, which does NOT
  // conflict at the OS level with an unrelated stray process bound to plain
  // IPv4 0.0.0.0 on the same port — both silently coexist, and which one
  // answers a given request depends on whether the client resolves
  // 'localhost' to ::1 or 127.0.0.1. Binding 0.0.0.0 ourselves means any
  // other process already on this port (0.0.0.0 or 127.0.0.1, the common
  // case for both a stray cockpit server and a generic stray process) hits
  // a real EADDRINUSE here instead — a loud, immediate crash rather than a
  // dashboard flakily served by whichever process the OS happened to route
  // to first.
  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(PORT, '0.0.0.0', () => {
      const boundPort = resolveBoundPort(server.address(), PORT)
      console.log(`Pipelinely running at http://localhost:${boundPort}`)
      // Opt-in, not opt-out: most callers of main() are not a developer
      // sitting in front of the dashboard (playwright's webServer, every
      // dispatched task's own "start the dev server for QA" step, etc.), so
      // popping a real browser tab must be something a caller explicitly
      // asks for via COCKPIT_AUTO_OPEN_BROWSER rather than something every
      // new spawn site has to remember to opt out of.
      if (process.env.COCKPIT_AUTO_OPEN_BROWSER) {
        open(`http://localhost:${boundPort}`).catch(console.error)
      }
      resolve(server)
    })
    server.on('error', reject)
  })
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
