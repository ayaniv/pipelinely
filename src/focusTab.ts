import fs from 'node:fs/promises'
import path from 'node:path'
import { execa } from 'execa'

export async function focusITermTab(tabName: string, sessionId?: string | null): Promise<void> {
  try {
    // Prefer matching on the stable session id — iTerm session *names* are
    // mutated by the running program's title escape sequences (e.g. Claude
    // Code), so a name set at dispatch time does not survive. The id does.
    const matchCondition = sessionId
      ? `id of aSession is "${sessionId}"`
      : `name of aSession contains "${tabName}"`

    const script = `tell application "iTerm2"
  activate
  repeat with aWindow in windows
    tell aWindow
      repeat with aTab in tabs
        repeat with aSession in sessions of aTab
          if ${matchCondition} then
            select aTab
            select aWindow
            return
          end if
        end repeat
      end repeat
    end tell
  end repeat
end tell`
    await execa('osascript', ['-e', script])
  } catch (error) {
    console.error('Failed to focus iTerm tab:', error)
  }
}

// Collapses all whitespace (space/tab/CR/LF) down to single spaces. POST
// /help/pipelinely-feedback applies it to a staged message so a newline in the text can
// never become a literal Return keystroke in the pane — see
// tech-design-help-feedback-tab.md's "newline decision".
export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

// Returns the set of currently-open iTerm2 session ids, or null if iTerm2
// isn't running / scripting isn't available (caller should skip orphan
// detection for that refresh rather than treat every task as orphaned).
export async function getLiveSessionIds(): Promise<Set<string> | null> {
  const script = `tell application "iTerm2"
  set sessionIds to {}
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        set end of sessionIds to (id of aSession)
      end repeat
    end repeat
  end repeat
  return sessionIds
end tell`
  try {
    const { stdout } = await execa('osascript', ['-e', script])
    return new Set(stdout.split(',').map((s) => s.trim()).filter(Boolean))
  } catch (error) {
    console.error('Failed to list iTerm sessions:', error)
    return null
  }
}

export async function openVSCode(worktreePath: string): Promise<void> {
  try {
    await execa('code', [worktreePath])
  } catch (error) {
    console.error('Failed to open VS Code:', error)
  }
}

export async function openBrowserUrl(url: string): Promise<void> {
  try {
    await execa('open', [url])
  } catch (error) {
    console.error('Failed to open browser URL:', error)
  }
}

export type ReattachAction = 'focus' | 'reattach' | 'none'

// Pure — takes pre-fetched liveness data so it's testable without shelling
// out. sessionId/liveIds mirror focusITermTab's inputs; tmuxSessionLive is
// the result of a prior `tmux has-session` check.
export function decideReattachAction(
  sessionId: string | null,
  liveIds: Set<string> | null,
  tmuxSession: string | null,
  tmuxSessionLive: boolean,
): ReattachAction {
  if (sessionId && liveIds?.has(sessionId)) return 'focus'
  if (tmuxSession && tmuxSessionLive) return 'reattach'
  return 'none'
}

// Returns the set of currently-live tmux session names, or null if the
// tmux server isn't running / `tmux ls` failed. Unlike getLiveSessionIds,
// this failure is NOT logged — no tmux server running is an expected
// steady state (e.g. before this feature was adopted on a given machine),
// not a signal that something is broken.
//
// `timeoutMs` is opt-in: the approval poll passes one so a hung tmux can't
// keep its tick in flight forever; orphan detection leaves it unset. A
// timeout rejects instead of returning null — a hung tmux is a real fault the
// caller must be able to tell apart from "no server" and log.
export async function getLiveTmuxSessions(options: { timeoutMs?: number } = {}): Promise<Set<string> | null> {
  try {
    const { stdout } = await execa('tmux', ['ls', '-F', '#{session_name}'], { timeout: options.timeoutMs })
    return new Set(stdout.split('\n').map((s) => s.trim()).filter(Boolean))
  } catch (error) {
    if (error instanceof Error && 'timedOut' in error && error.timedOut) throw error
    return null
  }
}

export const TMUX_WRITE_TIMEOUT_MS = 2000
export const TMUX_PANE_ID = /^%\d+$/

// The keystroke half of the tmux writes (the paste half is tmuxPaneWrite's
// load-buffer + paste-buffer). argv only (no shell), and it never adds Enter:
// the caller passes exactly the keys to type, built by keysForChoice or the
// single Enter that submits a paste. Takes a pinned pane id, never a session name, so the pane that was
// re-checked is the pane that is typed into.
export async function sendKeysToPane(paneId: string, keys: readonly string[]): Promise<void> {
  if (!TMUX_PANE_ID.test(paneId)) throw new Error(`refusing to send keys: ${JSON.stringify(paneId)} is not a tmux pane id`)
  await execa('tmux', ['send-keys', '-t', paneId, ...keys], { timeout: TMUX_WRITE_TIMEOUT_MS })
}

// The id (`%N`) of the session's active pane, or null when it can't be read.
export async function resolveActivePaneId(session: string): Promise<string | null> {
  if (!SAFE_TMUX_SESSION_NAME.test(session)) return null
  try {
    const { stdout } = await execa('tmux', ['display-message', '-p', '-t', `=${session}:`, '#{pane_id}'], { timeout: TMUX_WRITE_TIMEOUT_MS })
    const paneId = stdout.trim()
    return TMUX_PANE_ID.test(paneId) ? paneId : null
  } catch (err) {
    console.error(`[focusTab] could not resolve the active pane of ${session}:`, err)
    return null
  }
}

export interface TmuxPaneState {
  paneId: string
  command: string
  hasBracketedPaste: boolean
  isInMode: boolean
}

// One snapshot of the session's active pane, taken in a single tmux call so
// the id, the foreground command and the input-mode flags all describe the
// same pane. Returns null when no pane resolves: measured on tmux 3.7b,
// `display-message -t '=missing:'` exits 0 with EMPTY output, so the exit
// code alone cannot say "no such session" — the pane id read back has to be
// validated. The trailing `:` (empty window/pane) is required, and `=` forces
// an exact session-name match: `=foo:` resolves to the session's active pane
// but never matches session `foobar`, whereas a bare `=name` resolves to no
// pane at all. Throws when tmux itself fails (timeout, server gone), which
// callers must tell apart from "no such pane".
export async function readPaneState(session: string): Promise<TmuxPaneState | null> {
  if (!SAFE_TMUX_SESSION_NAME.test(session)) return null
  const { stdout } = await execa(
    'tmux',
    ['display-message', '-p', '-t', `=${session}:`, '#{pane_id}\t#{pane_current_command}\t#{bracket_paste_flag}\t#{pane_in_mode}'],
    { timeout: TMUX_WRITE_TIMEOUT_MS },
  )
  const [paneId, command, bracketPasteFlag, inModeFlag] = stdout.trim().split('\t')
  if (!TMUX_PANE_ID.test(paneId ?? '')) return null
  return { paneId, command: command ?? '', hasBracketedPaste: bracketPasteFlag === '1', isInMode: inModeFlag === '1' }
}

export async function tmuxSessionExists(name: string): Promise<boolean> {
  try {
    // '=' forces an exact match on the session name. Without it, tmux's -t
    // target resolution falls back to start-of-name prefix matching, so e.g.
    // "worker-overlap-m2" would match a live "worker-overlap-m2-followup"
    // session even though "worker-overlap-m2" itself is dead.
    await execa('tmux', ['has-session', '-t', `=${name}`])
    return true
  } catch {
    return false
  }
}

// Returns the tty device path of the given iTerm2 session, or null if no
// session with that id is currently open / iTerm2 scripting fails.
export async function getSessionTty(sessionId: string): Promise<string | null> {
  const script = `tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if id of aSession is "${sessionId}" then
          return tty of aSession
        end if
      end repeat
    end repeat
  end repeat
end tell
return ""`
  try {
    const { stdout } = await execa('osascript', ['-e', script])
    return stdout.trim() || null
  } catch (error) {
    console.error('Failed to get iTerm session tty:', error)
    return null
  }
}

// Returns the ttys of clients currently attached to a tmux session, or null
// if the session doesn't exist / has no clients / tmux isn't running.
async function getTmuxClientTtys(tmuxSession: string): Promise<Set<string> | null> {
  try {
    const { stdout } = await execa('tmux', ['list-clients', '-t', `=${tmuxSession}`, '-F', '#{client_tty}'])
    return new Set(stdout.split('\n').map((s) => s.trim()).filter(Boolean))
  } catch {
    return null
  }
}

// Pure — whether `tty` shows up among a tmux session's attached client ttys.
// Split out from waitForTmuxAttach so the gating decision is unit-testable
// without shelling out.
export function isTtyAttached(tty: string | null, clientTtys: Set<string> | null): boolean {
  return !!tty && !!clientTtys && clientTtys.has(tty)
}

// Polls until the iTerm session's tty shows up as an attached tmux client,
// or timeoutMs elapses. The new tab's shell needs a moment to actually run
// the `tmux attach` command typed into it — this closes that gap instead of
// assuming the attach succeeded the instant the tab was created.
async function waitForTmuxAttach(
  sessionId: string,
  tmuxSession: string,
  timeoutMs = 2000,
  pollMs = 150,
): Promise<boolean> {
  const tty = await getSessionTty(sessionId)
  if (!tty) return false
  const deadline = Date.now() + timeoutMs
  while (true) {
    const clientTtys = await getTmuxClientTtys(tmuxSession)
    if (isTtyAttached(tty, clientTtys)) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

// Session names generated elsewhere in this system (see orchestrator-prompt.md's
// dispatch step) are always `worker-<slug>` / `orchestrator-<slug>` built from
// task-directory-safe characters. buildTmuxAttachCommand refuses anything
// outside that set rather than risk it breaking out of the single-quoted
// shell string it's embedded in below.
export const SAFE_TMUX_SESSION_NAME = /^[a-zA-Z0-9_.-]+$/

// Builds the shell command line typed into the new tab's interactive zsh
// shell. The `=` prefix is tmux's exact-match target syntax (see the comment
// on tmuxSessionExists) — it must stay single-quoted here because, unlike
// tmuxSessionExists's execa call, this string is interpreted by a real
// interactive zsh shell, where an unquoted `=word` is expanded by zsh's
// EQUALS option to the path of an executable named `word` before tmux ever
// sees it. Returns null if tmuxSession isn't safe to embed.
export function buildTmuxAttachCommand(tmuxSession: string): string | null {
  if (!SAFE_TMUX_SESSION_NAME.test(tmuxSession)) return null
  return `tmux attach -d -t '=${tmuxSession}'`
}

// Opens a new iTerm2 window and types `command` into its shell. Returns the
// new window's current session id (empty string if osascript ran but
// returned nothing); throws on an osascript failure so each caller can log
// its own contextual message. Shared by reattachTmuxSession (types a `tmux
// attach` command) and openAnnotationSession (types a `tmux new` command for
// a fresh session).
async function openNewTabRunning(command: string): Promise<string> {
  // AppleScript string literals need their own backslashes and double
  // quotes escaped — command strings that embed a `"` (e.g.
  // openAnnotationSession's `"bash '...'"`) would otherwise terminate the
  // `write text "..."` literal early and fail with an AppleScript syntax
  // error, not a permissions error, which is easy to misdiagnose.
  const escapedCommand = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  // No `activate`, and no early `return` from inside the iTerm2 block (an
  // AppleScript `return` inside a `tell` exits the whole script, which would
  // skip the focus restore).
  // Every planning/dev/QA/CR/annotate dispatch opens a tab through here;
  // removing the bare `activate` alone isn't sufficient — iTerm2 raises
  // itself as a side effect of creating/writing to a new tab regardless —
  // so this explicitly hands focus back to whatever was frontmost instead
  // of just not asking for it. Stealing focus on every automated dispatch
  // (multiple times per hour in normal use) is exactly the disruption a
  // real user would uninstall the tool over.
  //
  // `create window with default profile` rather than `tell current window /
  // create tab`: `current window` is iTerm2-application-global state —
  // whichever window the OS most recently made frontmost, uncontrolled by
  // this request — so a dispatch could land its tab in whatever a developer
  // happened to be looking at. Mirrors
  // e2e/fixtures/itermSessions.ts's openScratchSession, which needed the
  // same isolation for the same reason.
  const script = `tell application "System Events"
  set frontApp to name of first application process whose frontmost is true
end tell
tell application "iTerm2"
  set newWindow to (create window with default profile)
  set sid to id of current session of newWindow
  tell current session of newWindow
    write text "${escapedCommand}"
  end tell
end tell
tell application "System Events"
  tell application process frontApp to set frontmost to true
end tell
return sid`
  const { stdout } = await execa('osascript', ['-e', script])
  return stdout.trim()
}

// Opens a new iTerm2 tab and reattaches it to an existing tmux session.
// -d detaches any other client already attached to that session first, so
// a stale unreaped client elsewhere can't clamp the new window to its
// (possibly smaller) terminal size. Returns the new tab's session id, or
// null on failure — including when the attach command was typed into the
// new tab but never actually succeeded there (see waitForTmuxAttach below),
// so a shell-level failure can no longer get recorded as a live session.
// Reattaches a tmux session into a fresh iTerm2 tab and records the new
// tab's id in `pointerFilePath`, so the next lookup hits the fast path
// instead of healing again. Returns the new session id, or null if the
// reattach failed (reattachTmuxSession logs its own reason). Shared by the
// per-task path (reattachOrFocus, writing ITERM_SESSION) and the
// orchestrator path (writeToOrchestrator, writing ORCHESTRATOR_SESSION) —
// the two differ only in which pointer file they own.
export async function reattachAndRecord(
  tmuxSession: string,
  pointerFilePath: string,
): Promise<string | null> {
  const newSessionId = await reattachTmuxSession(tmuxSession)
  if (!newSessionId) return null
  await fs.writeFile(pointerFilePath, newSessionId)
  return newSessionId
}

export async function reattachTmuxSession(tmuxSession: string): Promise<string | null> {
  const attachCommand = buildTmuxAttachCommand(tmuxSession)
  if (!attachCommand) {
    console.error(`Refusing to reattach tmux session with unsafe name: ${JSON.stringify(tmuxSession)}`)
    return null
  }

  // -d detaches whatever client is currently attached with no warning to
  // whoever was looking at it; log which tty that is (if any) so a
  // previously-live tab going silently dead is at least traceable after
  // the fact.
  const priorClients = await getTmuxClientTtys(tmuxSession)
  if (priorClients && priorClients.size > 0) {
    console.log(
      `Reattaching to tmux session "${tmuxSession}" will detach its current client(s): ${[...priorClients].join(', ')}`,
    )
  }

  let sid: string | null
  try {
    sid = (await openNewTabRunning(attachCommand)) || null
  } catch (error) {
    console.error('Failed to reattach tmux session:', error)
    return null
  }
  if (!sid) return null

  const attached = await waitForTmuxAttach(sid, tmuxSession)
  if (!attached) {
    console.error(
      `Reattach to tmux session "${tmuxSession}" did not verify as attached (tab ${sid}) — the attach command may have failed in the new tab's shell`,
    )
    return null
  }
  return sid
}

// Opens Plannotator's annotation UI against a task's tracked tech-design.md
// in its own dedicated tmux session/iTerm2 tab — never the orchestrator's,
// since `plannotator annotate` blocks synchronously on the browser
// round-trip (see plannotator-annotate/SKILL.md) and would freeze
// orchestration for however long the developer takes to annotate. The tmux
// session name is deterministic (worker-<slug>-annotate), so no session-id
// file needs to be tracked anywhere — tmuxSessionExists is itself the
// idempotency check ("already open? reattach, don't double-open a second
// browser tab against the same file").
export async function openAnnotationSession(
  slug: string,
  tasksDir: string,
): Promise<{ status: 'ok' } | { status: 'error'; error: string }> {
  const tmuxSession = `worker-${slug}-annotate`
  if (!SAFE_TMUX_SESSION_NAME.test(tmuxSession)) {
    return { status: 'error', error: `Unsafe task slug: ${slug}` }
  }

  if (await tmuxSessionExists(tmuxSession)) {
    const sid = await reattachTmuxSession(tmuxSession)
    return sid
      ? { status: 'ok' }
      : { status: 'error', error: 'Annotation session is already running but its tab could not be reattached' }
  }

  const taskDir = path.join(tasksDir, slug)
  const launchScriptPath = path.join(taskDir, 'launch-annotate.sh')
  const launchScript = `#!/bin/bash\ncd "${taskDir}"\nclaude "/plannotator-annotate tech-design.md"\n`
  try {
    await fs.writeFile(launchScriptPath, launchScript, { mode: 0o755 })
  } catch (error) {
    console.error(`Failed to write launch-annotate.sh for ${slug}:`, error)
    return { status: 'error', error: 'Could not write annotation launch script' }
  }

  try {
    // No `-A`: `tmuxSessionExists` above only proves the session was absent
    // at the time of that check, not at the time this command actually runs
    // in the new tab's shell — a concurrent call for the same slug (or any
    // other same-named session springing up in between) can still win that
    // race. `-A` would make tmux silently attach this "new" tab to whatever
    // that other, unrelated session already has running rather than the
    // fresh `launch-annotate.sh` — see FINDINGS.md's Mechanism B for the
    // incident this caused elsewhere. Plain `tmux new-session` instead fails
    // loudly (a `COCKPIT_TMUX_COLLISION` line printed into the otherwise-empty
    // tab) on a name collision, which is always safer than a silent
    // misdirect. This marker must stay byte-identical to the copies in
    // orchestrator-prompt.md and .claude/skills/pipelinely-handover/SKILL.md —
    // e2e/tmux-session-collision.spec.ts holds it as a single constant.
    const sid = await openNewTabRunning(
      `tmux new-session -s '${tmuxSession}' "bash '${launchScriptPath}'" || echo COCKPIT_TMUX_COLLISION`,
    )
    if (!sid) return { status: 'error', error: 'Failed to open a new iTerm2 tab for annotation' }

    // `sid` only proves the iTerm2 tab opened — not that tmux agreed to
    // create the session inside it (the `|| echo` fallback above means the
    // typed command always "succeeds" from AppleScript's point of view even
    // on a collision). waitForTmuxAttach is the same real verification
    // reattachTmuxSession already relies on rather than trusting the typed
    // command, reused here for the same reason.
    const attached = await waitForTmuxAttach(sid, tmuxSession)
    return attached
      ? { status: 'ok' }
      : { status: 'error', error: 'Could not start the annotation session — a session with that name may already be in use' }
  } catch (error) {
    console.error(`Failed to open annotation tab for ${slug}:`, error)
    return { status: 'error', error: 'Failed to open a new iTerm2 tab for annotation' }
  }
}

// Outcome of reattachOrFocus, surfaced to the caller (POST /focus/:slug) so
// it can tell the difference between "something is live now" and "neither
// the iTerm tab nor its tmux session could be reached" — the latter used to
// be swallowed as a silent no-op (see this function's own history).
export type ReattachOutcome = 'focused' | 'reattached' | 'reattach-failed' | 'none'

// Focuses the task's existing iTerm tab if it's still live; otherwise, if
// its tmux session survived the tab closing, opens a new tab and reattaches
// to it — updating ITERM_SESSION so subsequent focuses hit the fast path
// again. Returns 'none' if neither is reachable, so the caller can fall
// back (e.g. to pasteToOrchestrator) instead of doing nothing.
export async function reattachOrFocus(
  slug: string,
  sessionId: string | null,
  tmuxSession: string | null,
  itermSessionFilePath: string,
): Promise<ReattachOutcome> {
  const liveIds = await getLiveSessionIds()
  const tmuxSessionLive = tmuxSession ? await tmuxSessionExists(tmuxSession) : false
  const action = decideReattachAction(sessionId, liveIds, tmuxSession, tmuxSessionLive)

  if (action === 'focus') {
    await focusITermTab(slug, sessionId)
    return 'focused'
  }
  if (action === 'reattach' && tmuxSession) {
    const newSessionId = await reattachAndRecord(tmuxSession, itermSessionFilePath)
    return newSessionId ? 'reattached' : 'reattach-failed'
  }
  return 'none'
}

// Returns id->tty pairs for every currently-open iTerm2 session, or null if
// iTerm2 isn't running / scripting isn't available. Building block for
// findSessionAttachedToTmux — getLiveSessionIds returns ids only.
async function getLiveSessionTtys(): Promise<Map<string, string> | null> {
  const script = `tell application "iTerm2"
  set sessionInfo to {}
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        set end of sessionInfo to ((id of aSession) & "::" & (tty of aSession))
      end repeat
    end repeat
  end repeat
  return sessionInfo
end tell`
  try {
    const { stdout } = await execa('osascript', ['-e', script])
    const ttysById = new Map<string, string>()
    for (const entry of stdout.split(',').map((s) => s.trim()).filter(Boolean)) {
      const [id, tty] = entry.split('::')
      if (id && tty) ttysById.set(id, tty)
    }
    return ttysById
  } catch (error) {
    console.error('Failed to list iTerm session ttys:', error)
    return null
  }
}

// Returns the id of a live iTerm2 session whose tty is already an attached
// client of `tmuxSession`, or null if none is. This is the same cross-check
// used to root-cause the stale-pointer bug by hand (matching iTerm ttys
// against `tmux list-clients`), promoted from a diagnostic into the heal
// itself: when the tab is already there, re-pointing at it is both cheaper
// than opening a new one and non-disruptive, since reattachTmuxSession's
// `-d` would otherwise detach that very tab.
export async function findSessionAttachedToTmux(tmuxSession: string): Promise<string | null> {
  const clientTtys = await getTmuxClientTtys(tmuxSession)
  if (!clientTtys || clientTtys.size === 0) return null
  const sessionTtys = await getLiveSessionTtys()
  if (!sessionTtys) return null
  for (const [id, tty] of sessionTtys) {
    if (clientTtys.has(tty)) return id
  }
  return null
}

// The shells a tmux pane falls back to once the program that owned it exits.
// A deny-list, not an "is it claude" allow-list, on purpose: tmux names a
// process after its resolved executable file, and the real CLI's executable
// is named after its version (`2.1.251`), which changes on every auto-update.
// The two failure directions are not symmetric. A wrong allow-list fails
// closed on a HEALTHY orchestrator, bricking every dispatch button; a wrong
// deny-list at worst lets a write reach some non-shell leftover.
const STRAY_SHELL_COMMANDS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'tcsh', 'csh', 'login',
])

// Pure. `null` counts as stray, i.e. this gate fails CLOSED: it only ever
// runs after tmuxSessionExists has already confirmed the session is there,
// so a null here is a real tmux failure, not a normal state — and the whole
// point is to not type into a destination we could not verify.
export function isStrayShellCommand(paneCommand: string | null): boolean {
  return paneCommand === null || STRAY_SHELL_COMMANDS.has(paneCommand)
}
