import { execa } from 'execa'
import { fakeClaudeBinaryPath } from './fakeClaude.js'
import { assertIsolatedEnvironment } from '../../src/e2eIsolation.js'

// Module-scope, deliberately: any spec that imports a single helper from
// this file — now or written next month — pays this check on import,
// before a single osascript/tmux call can fire. See src/e2eIsolation.ts.
assertIsolatedEnvironment()

// Real iTerm2/tmux scratch-session helpers, shared by every spec that needs
// to stand up a genuinely live session rather than a fake id.
//
// Extracted from resume-dead-session-fallback.spec.ts, which defined the
// first three of these privately. orchestrator-session-self-heal.spec.ts
// needs the same primitives (plus the tmux pair), and forking a second copy
// of the AppleScript would mean two literals to keep in sync the next time
// iTerm2's scripting dictionary shifts under us.
//
// This suite drives real osascript/tmux rather than mocking them, matching
// the precedent set by resume-dead-session-fallback.spec.ts and
// qa-case-list.spec.ts: the dashboard is inherently macOS+iTerm2-only, so a
// real round trip is the only honest verifier of "the tab actually came
// back".

// Every session id this module has itself handed back via
// openScratchSession — the set of ids the destructive helpers below
// (closeScratchSession, closeScratchTab, typeIntoSession) are actually
// allowed to act on. Without this, each of those helpers searches *every*
// open iTerm2 window for a matching id with no check that the id was ever
// one of theirs — a stale or wrong id (a bug elsewhere in a spec, a
// variable reused after a reattach) would make them happily close or type
// into a real, unrelated developer window — the same incident class
// orchestrator-prompt.md's Rules section records for the 2026-09-01
// incident, just reachable from a different code path.
const trackedScratchSessionIds = new Set<string>()

// Exported as its own pure predicate — rather than only living inline in
// the guard clauses below — so a unit test can assert tracking behavior
// (an id is tracked after openScratchSession, untracked after a close)
// without needing to inspect module-private state.
export function isTrackedScratchSession(sessionId: string): boolean {
  return trackedScratchSessionIds.has(sessionId)
}

// Runs before any osascript/execa call in the destructive helpers below —
// a loud, immediate failure for an untracked id, never a silent no-op, so a
// spec that hits this fails obviously instead of passing vacuously.
function assertOwnsScratchSession(sessionId: string, action: string): void {
  if (!isTrackedScratchSession(sessionId)) {
    throw new Error(`refusing to ${action} session ${sessionId}: not a scratch session this suite created`)
  }
}

// Opens a scratch iTerm2 window and returns its session id. A window (not a
// tab) so closing it can never take a developer's real tab with it.
//
// Saves and restores the frontmost app around the window creation — mirrors
// src/focusTab.ts's openNewTabRunning, whose own comment documents why:
// iTerm2 raises itself as a side effect of creating a window/tab regardless
// of whether `activate` is called. Without this, every scratch window a test
// opens steals focus from whatever the developer is looking at — this is
// test-harness noise, not a user-initiated action, so it must not disrupt
// the developer's foreground app the way a real dispatch button click
// (which deliberately keeps `activate`) is allowed to.
export async function openScratchSession(): Promise<string> {
  const script = `tell application "System Events"
  set frontApp to name of first application process whose frontmost is true
end tell
tell application "iTerm2"
  set newWindow to (create window with default profile)
  set sid to id of current session of newWindow
end tell
tell application "System Events"
  tell application process frontApp to set frontmost to true
end tell
return sid`
  const { stdout } = await execa('osascript', ['-e', script])
  const sessionId = stdout.trim()
  trackedScratchSessionIds.add(sessionId)
  return sessionId
}

// Best-effort: a session already closed by the test (or by a reattach that
// replaced it) is not a failure, so osascript errors are swallowed here
// rather than failing an otherwise-passing test in its cleanup block.
//
// Same frontmost save/restore as openScratchSession, and for the same
// reason. No early `return` inside the `tell application "iTerm2"` block —
// as openNewTabRunning's own comment notes, an AppleScript `return` inside a
// `tell` exits the whole script, which would skip the focus restore below —
// so a `didClose` flag plus `exit repeat` is used instead to unwind the
// nested loops once the target window is found.
export async function closeScratchSession(sessionId: string): Promise<void> {
  assertOwnsScratchSession(sessionId, 'close')
  const script = `tell application "System Events"
  set frontApp to name of first application process whose frontmost is true
end tell
tell application "iTerm2"
  set didClose to false
  repeat with aWindow in windows
    if didClose then exit repeat
    repeat with aTab in tabs of aWindow
      if didClose then exit repeat
      repeat with aSession in sessions of aTab
        if id of aSession is "${sessionId}" then
          close aWindow
          set didClose to true
          exit repeat
        end if
      end repeat
    end repeat
  end repeat
end tell
tell application "System Events"
  tell application process frontApp to set frontmost to true
end tell`
  await execa('osascript', ['-e', script]).catch(() => {})
  // Unconditional, not just on success: this call is already best-effort
  // (errors above are swallowed), and an id whose window was never found
  // still means "not ours to touch anymore" — the caller's intent was to
  // be done with it either way.
  trackedScratchSessionIds.delete(sessionId)
}

// Closes a session that lives in a tab of a shared window — the shape
// reattachTmuxSession creates (`create tab` in the current window), where
// closing the whole window would take unrelated tabs with it. Same
// frontmost save/restore and no-early-`return` reasoning as
// closeScratchSession above.
export async function closeScratchTab(sessionId: string): Promise<void> {
  assertOwnsScratchSession(sessionId, 'close')
  const script = `tell application "System Events"
  set frontApp to name of first application process whose frontmost is true
end tell
tell application "iTerm2"
  set didClose to false
  repeat with aWindow in windows
    if didClose then exit repeat
    repeat with aTab in tabs of aWindow
      if didClose then exit repeat
      repeat with aSession in sessions of aTab
        if id of aSession is "${sessionId}" then
          close aSession
          set didClose to true
          exit repeat
        end if
      end repeat
    end repeat
  end repeat
end tell
tell application "System Events"
  tell application process frontApp to set frontmost to true
end tell`
  await execa('osascript', ['-e', script]).catch(() => {})
  // Same unconditional-drop reasoning as closeScratchSession above.
  trackedScratchSessionIds.delete(sessionId)
}

// The visible buffer of a session — how a test observes that text actually
// landed in a real terminal pane, whether pasted-and-sent or staged unsent.
//
// Selects the tab/window before reading: `contents of aSession` for a
// session that is not iTerm2's own "current" tab/window can return a stale
// snapshot from the last time that pane was actually rendered, rather than
// its live buffer — the read-side counterpart of the write-side race
// `pasteIntoSession` (src/focusTab.ts) closes by confirming its own write
// landed before returning. `select` only changes iTerm2's internal notion of
// its current tab/window, not the OS-level frontmost app — no `activate`
// here, since this runs inside `expect.poll` and would otherwise repeatedly
// steal real OS focus on every poll tick, which is exactly what this whole
// fixture exists to prevent.
//
// Deliberately NOT guarded by assertOwnsScratchSession, unlike
// closeScratchSession/closeScratchTab/typeIntoSession: this only reads a
// pane's text (plus a `select`, which changes iTerm2's own notion of its
// current tab/window, not any user-visible state) — it cannot close a
// window or land a keystroke, so it cannot reproduce the incident class the
// guard exists for. Adding the guard here anyway would over-scope this fix
// beyond the destructive operations that actually caused harm; sessionTty
// below is read-only for the same reason and gets the same treatment.
export async function readSessionContents(sessionId: string): Promise<string> {
  const script = `tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if id of aSession is "${sessionId}" then
          select aTab
          select aWindow
          return contents of aSession
        end if
      end repeat
    end repeat
  end repeat
end tell
return ""`
  // Every caller here wraps this in expect.poll(), which does NOT retry past
  // a thrown exception — it fails the assertion immediately on the first
  // throw, timeout budget or not. iTerm2's AppleScript enumeration of "every
  // window"/"every tab" is a live snapshot that can be invalidated mid-walk
  // by a concurrent process mutating that same list (e.g. a sibling Claude
  // Code session opening/closing its own tab), raising "Can't get item N of
  // every tab ... Invalid index." — reproduced directly against this
  // machine's real, multi-session iTerm2 state: the same script that fails
  // this way on one invocation succeeds immediately on the next. Retrying
  // internally here means one transient hit costs a few hundred ms, not a
  // failed test.
  for (let attempt = 1; ; attempt++) {
    try {
      const { stdout } = await execa('osascript', ['-e', script])
      return stdout
    } catch (error) {
      if (attempt >= 5) throw error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

// The name of whatever application is frontmost right now. Used to prove a
// negative that matters for the auto-submitted remote path: that writing into
// a session did NOT raise iTerm2 to the OS foreground. pasteIntoSessionQuiet
// (src/focusTab.ts) exists precisely so an unattended, phone-triggered
// dispatch never jumps the developer's windows, and only a real frontmost
// reading can show that it didn't.
export async function frontmostAppName(): Promise<string> {
  const script = `tell application "System Events"
  return name of first application process whose frontmost is true
end tell`
  const { stdout } = await execa('osascript', ['-e', script])
  return stdout.trim()
}

// `=` is tmux's exact-match target syntax — without it, `has-session -t foo`
// also matches a session named `foobar`, which would make a "the session is
// really gone" assertion pass for the wrong reason. Mirrors the same guard
// in focusTab.ts's tmuxSessionExists.
export async function tmuxSessionIsLive(name: string): Promise<boolean> {
  try {
    await execa('tmux', ['has-session', '-t', `=${name}`])
    return true
  } catch {
    return false
  }
}

export async function createTmuxSession(name: string): Promise<void> {
  await execa('tmux', ['new-session', '-d', '-s', name])
}

// Like createTmuxSession, but the pane runs fakeClaudeBinaryPath() instead
// of the default shell — a tmux session whose `pane_current_command` is
// genuinely "claude", for tests that must survive
// tmuxSessionRunningOrchestrator's check (the reattach/adopt heal paths).
// createTmuxSession's plain shell is what the CHECK is meant to reject, so
// it stays as the "stray process" fixture for the negative-path tests.
export async function createOrchestratorTmuxSession(name: string): Promise<void> {
  const claudeBin = await fakeClaudeBinaryPath()
  await execa('tmux', ['new-session', '-d', '-s', name, '--', claudeBin])
}

// The raw text sitting in a tmux pane, read directly via tmux rather than
// iTerm2 — used to assert nothing was typed into a pane that was never
// wrapped in a tracked iTerm2 session to begin with (the "reattach into a
// stray shell" case, where the only thing to inspect is the tmux pane
// itself, not any particular tab). The trailing `:` on the target matters:
// measured on this machine (tmux 3.7b), `capture-pane -t '=name'` with no
// window/pane part errors "can't find pane" even though the session plainly
// has one — `=name:` (session's current window, active pane) is what
// actually resolves. See getTmuxPaneCommand's comment in focusTab.ts for the
// same finding.
export async function readTmuxPaneContents(tmuxSession: string): Promise<string> {
  const { stdout } = await execa('tmux', ['capture-pane', '-t', `=${tmuxSession}:`, '-p'])
  return stdout
}

// Best-effort, for the same reason as closeScratchSession: a session the
// test already killed must not fail the cleanup path.
export async function killTmuxSession(name: string): Promise<void> {
  await execa('tmux', ['kill-session', '-t', `=${name}`]).catch(() => {})
}

// The ttys currently attached as clients of `tmuxSession`, or an empty array
// if the session is gone. The observable answer to "did that tab actually
// join this session?" — used both by attachSessionToTmux (waiting for a join
// it wants) and by tmux-session-collision.spec.ts (asserting a join that
// must NOT have happened). `=` is exact-match, same reason as
// tmuxSessionIsLive's own comment.
export async function tmuxClientTtys(tmuxSession: string): Promise<string[]> {
  try {
    const { stdout } = await execa('tmux', ['list-clients', '-t', `=${tmuxSession}`, '-F', '#{client_tty}'])
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  } catch {
    return []
  }
}

// Types `command` into an existing session and presses Return — the same
// `write text` primitive src/focusTab.ts's openNewTabRunning uses, so a test
// can put a real dispatch command into a real shell and observe what tmux
// actually does with it. Escapes exactly as openNewTabRunning does: an
// embedded `"` would otherwise terminate the AppleScript literal early and
// fail as a syntax error, which is easy to misdiagnose as a permissions
// problem.
export async function typeIntoSession(sessionId: string, command: string): Promise<void> {
  assertOwnsScratchSession(sessionId, 'type into')
  const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const script = `tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if id of aSession is "${sessionId}" then
          tell aSession to write text "${escaped}"
        end if
      end repeat
    end repeat
  end repeat
end tell`
  await execa('osascript', ['-e', script])
}

// Types a `tmux attach` into an existing scratch session and waits until it
// really shows up as a client of that tmux session — the "the orchestrator's
// tab is already open and attached, only the recorded id is stale" state.
// Polls rather than sleeping: the shell needs a moment to actually run the
// command, and a fixed sleep would either flake or be needlessly slow.
export async function attachSessionToTmux(sessionId: string, tmuxSession: string): Promise<void> {
  await typeIntoSession(sessionId, `tmux attach -t '=${tmuxSession}'`)

  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const tty = await sessionTty(sessionId)
    if (tty && (await tmuxClientTtys(tmuxSession)).includes(tty)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`session ${sessionId} never attached to tmux session ${tmuxSession}`)
}

// Read-only, same as readSessionContents — see that function's comment for
// why it's deliberately not guarded by assertOwnsScratchSession.
export async function sessionTty(sessionId: string): Promise<string | null> {
  const script = `tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if id of aSession is "${sessionId}" then return tty of aSession
      end repeat
    end repeat
  end repeat
end tell
return ""`
  const { stdout } = await execa('osascript', ['-e', script])
  return stdout.trim() || null
}

// Total open iTerm2 sessions — used to assert a heal adopted an existing tab
// rather than opening another one.
export async function countSessions(): Promise<number> {
  const script = `tell application "iTerm2"
  set n to 0
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      set n to n + (count of sessions of aTab)
    end repeat
  end repeat
  return n
end tell`
  const { stdout } = await execa('osascript', ['-e', script])
  return parseInt(stdout.trim(), 10)
}

// Total open iTerm2 windows — the counterpart to countSessions, for asserting
// that a dispatch opened a window of its own rather than appending a tab to
// whatever window iTerm2 happened to consider "current" at that instant (see
// openNewTabRunning's `tell current window` and FINDINGS.md's window-ambiguity
// section).
export async function countWindows(): Promise<number> {
  const script = `tell application "iTerm2"
  return count of windows
end tell`
  const { stdout } = await execa('osascript', ['-e', script])
  return parseInt(stdout.trim(), 10)
}

// How many tabs live in the window that owns `sessionId`, or 0 if no window
// does. A dispatch that opened its own dedicated window reports 1; one that
// appended a tab to a developer's existing window reports whatever that
// window already had, plus one.
export async function tabCountForWindowOfSession(sessionId: string): Promise<number> {
  const script = `tell application "iTerm2"
  set n to 0
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if id of aSession is "${sessionId}" then set n to (count of tabs of aWindow)
      end repeat
    end repeat
  end repeat
  return n
end tell`
  const { stdout } = await execa('osascript', ['-e', script])
  return parseInt(stdout.trim(), 10) || 0
}
