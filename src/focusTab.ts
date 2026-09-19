import fs from 'node:fs/promises'
import path from 'node:path'
import { execa } from 'execa'

// iTerm2's AppleScript enumeration of "every window" / "every tab" is a
// live snapshot that can be invalidated mid-walk by a concurrent process
// mutating the same window/tab list (e.g. a sibling Claude Code session
// opening or closing its own tab while this script is still iterating) —
// iTerm2 then raises "Can't get item N of every tab ... Invalid index."
// Reproduced directly against this machine's real, multi-session iTerm2
// state: the same script that fails this way on one invocation succeeds
// immediately on the next, since the list is stable again a moment later.
// So this retries the whole osascript call a few times before giving up,
// rather than letting a transient race either surface as an uncaught
// rejection (pasteIntoSession/stageInSession are documented to return
// false, never throw) or as a spurious "not found". Attempt count and delay
// were widened (from an initial 3x150ms) after that budget still lost to
// the race on this machine under real multi-session load — 5x250ms (a ~1s
// worst case) is still negligible next to the 30s callers poll for.
async function runOsascriptWithTabListRaceRetry(script: string, attempts = 5): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const { stdout } = await execa('osascript', ['-e', script])
      return stdout
    } catch (error) {
      if (attempt >= attempts) throw error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

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

export interface SessionWriteOptions {
  submit: boolean   // send the Return as its own `write text` call afterwards
  focus: boolean    // bring iTerm2 itself to the OS foreground (`activate`)
}

// Escapes a string for embedding inside an AppleScript double-quoted string
// literal: `\` and `"` (as always), plus CR/LF collapsed to the two-character
// `\n` escape. Without the CR/LF handling, an embedded raw line break makes
// the generated script a syntax error — `osascript` exits non-zero and the
// caller throws, which is not a handled failure. No caller passed multi-line
// text before this was extracted, so this closes a latent hole for every
// caller at once (including /backlog/dispatch's description/context).
function escapeForAppleScriptString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n/g, '\\n')
}

// Pure — builds the AppleScript that writeToSession runs. Split out so the
// escaping, the newline-no/newline-yes split, and the focus/no-focus
// difference are unit-testable without driving a real iTerm2.
//
// `select aTab`/`select aWindow` run regardless of `focus` — measured against
// a real iTerm2 (10+ real-session e2e runs, reproduced consistently): a
// `write text` sent to a session that was never `select`ed is silently lost
// often enough to make a real e2e case against it flake/fail outright, even
// though `osascript` still reports "ok" (it found the session; it did not
// confirm delivery). `select` only changes which tab/window iTerm2 itself
// considers current — unlike `activate`, it does not raise iTerm2 to the OS
// foreground, so it doesn't steal the developer's focus away from the
// dashboard. `focus: false` omits only the leading `activate` line for that
// reason.
// `pasteIntoSession`'s own `focus: true` default additionally activates —
// right for an explicit "Run" click, which spawns a tab the developer needs
// to see; that reasoning does not carry to answering a yes/no.
export function buildSessionWriteScript(
  sessionId: string,
  text: string,
  { submit, focus }: SessionWriteOptions,
): string {
  const escapedSessionId = escapeForAppleScriptString(sessionId)
  const escapedText = escapeForAppleScriptString(text)
  const activateLine = focus ? '  activate\n' : ''
  const selectLines = '            select aTab\n            select aWindow\n'
  const submitWrite = submit ? '\n              write text "" newline yes' : ''
  return `tell application "iTerm2"
${activateLine}  repeat with aWindow in windows
    tell aWindow
      repeat with aTab in tabs
        repeat with aSession in sessions of aTab
          if id of aSession is "${escapedSessionId}" then
${selectLines}            tell aSession
              write text "${escapedText}" newline no${submitWrite}
            end tell
            return "ok"
          end if
        end repeat
      end repeat
    end tell
  end repeat
end tell
return "not-found"`
}

// Runs buildSessionWriteScript's script and reports whether the session was
// found and written to. Shared body behind pasteIntoSession/stageInSession/
// pasteIntoTrackedSession — see buildSessionWriteScript's own comment for why
// this exists as one function rather than a near-copy per caller.
async function writeToSession(sessionId: string, text: string, options: SessionWriteOptions): Promise<boolean> {
  const script = buildSessionWriteScript(sessionId, text, options)
  try {
    const stdout = await runOsascriptWithTabListRaceRetry(script)
    return stdout.trim() === 'ok'
  } catch (error) {
    console.error('Failed to write into iTerm session:', error)
    return false
  }
}

// Focuses the session by id and types `text` into it followed by Return, as
// if the developer had typed it themselves — used to paste a promoted
// backlog item into the orchestrator's own running session. Returns false
// (rather than throwing) when no session with that id is currently open, so
// callers can surface "orchestrator not running" distinctly from a hard error.
//
// The text and the Return are sent as two separate `write text` calls
// (message with `newline no`, then an empty write with `newline yes`)
// rather than one call with a trailing newline. Observed failure mode
// (reproduced 10+ times against a real Claude Code session in a scratch
// tmux/iTerm2 pair, before this change): the message would sit in the input
// box unsent, requiring a separate real Enter keypress to submit — as if the
// `\r` iTerm2's `write text` appends had been delivered as literal pasted
// content rather than an Enter keystroke, which is consistent with (but not
// confirmed as) Ink's bracketed-paste handling swallowing it. The exact
// trigger is NOT nailed down — it did not reproduce as a clean "text over N
// characters" rule (a real ~90-char dispatch succeeded on unmodified code
// shortly after this was written), so it's likely timing- or
// system-load-dependent rather than purely length-based. This change is a
// safe hardening regardless: sending the Return as its own `write text` call
// can't make delivery less reliable than bundling it with the text.
//
// Keeps `activate` (focus: true) — this is the direct result of an explicit
// "Run" click on a backlog item, not background automation. The developer
// just told the dashboard to do something and should see it happen, the
// same way focusITermTab does for → Terminal. (Contrast openNewTabRunning,
// which fires repeatedly and unattended mid-dispatch and must NOT steal
// focus — see that function's own comment.)
//
// Restores whatever app was frontmost before `activate`, once the whole
// write+confirm sequence is done — mirroring openNewTabRunning's own
// save/restore, which this function never had. Without it, iTerm2 stayed
// frontmost indefinitely after every call: fine for the one real "Run"
// click this comment describes, but this same code path also fires from
// automated dispatch (/backlog/dispatch, /focus/:slug's fallback)
// and from e2e tests exercising those routes — repeated,
// unattended calls that each yanked the developer's real OS focus to iTerm2
// and never gave it back, observed live as iTerm2 windows "jumping"
// forward while the developer was working in a completely unrelated app.
// Collapses all whitespace (space/tab/CR/LF, including a terminal's own
// soft-wrap line breaks, which land as real newlines in `contents of
// aSession`) down to single spaces, matching pasteIntoSession's AppleScript
// `collapseWhitespace` handler. Applied to `text` before it's embedded in
// that script, so the confirmation check compares two identically-normalized
// strings — a message long enough to wrap mid-string in the terminal window
// gets a literal line break inserted into its buffer contents that never
// existed in the text that was written, so an exact, un-normalized substring
// check would permanently report a perfectly-landed write as failed for any
// sufficiently long message (reproduced against /focus/:slug's ~300-char
// fallback message).
// Also the collapse POST /help/pipelinely-feedback applies to a staged message before
// it can become a literal Return keystroke in the pane — see
// tech-design-help-feedback-tab.md's "newline decision".
export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

// Pure — builds the AppleScript that finds `sessionId`, waits for iTerm2 to
// actually be frontmost, and writes `text` — nothing else. Split out, same
// as buildSessionWriteScript above, so the escaping is unit-testable without
// driving a real iTerm2.
//
// `activate` asks iTerm2 to become frontmost but does not block until the
// WindowServer actually finishes the transition — `select tab`/`select
// window` can return, and `write text` can fire, while some other app is
// still key. `write text` delivers via synthetic keyboard events, so a write
// issued before iTerm2 is genuinely frontmost is silently dropped (no
// AppleScript error — the call still reports "ok"): confirmed via a
// read-back-after-write diagnostic that a raw `activate` left the paste
// missing from the session's contents entirely a real fraction of the time,
// worse and more erratic under real machine load (multiple back-to-back
// dispatches, as wave-batch mode does, made it far more likely to hit).
// Polling System Events' own frontmost-process reading until it actually
// reports "iTerm2" — rather than trusting `activate`'s return — closes that
// gap; 20 * 0.1s is generous slack for a focus transition that normally
// completes in well under that.
//
// Returns immediately once the write fires — no confirm-poll inside this
// script at all (see pasteIntoSession's own comment for why that moved out).
// This means nothing enumerable is touched between the write and the
// return, so a caught error afterward can only mean the write itself never
// happened, which is what makes retrying this WHOLE script via
// runOsascriptWithTabListRaceRetry safe.
export function buildPasteIntoSessionWriteScript(sessionId: string, text: string): string {
  const escapedSessionId = escapeForAppleScriptString(sessionId)
  const escapedText = escapeForAppleScriptString(text)
  return `tell application "System Events"
  set frontApp to name of first application process whose frontmost is true
end tell

tell application "iTerm2"
  activate
  repeat with aWindow in windows
    tell aWindow
      repeat with aTab in tabs
        repeat with aSession in sessions of aTab
          if id of aSession is "${escapedSessionId}" then
            select aTab
            select aWindow
            repeat 20 times
              set isFront to false
              tell application "System Events"
                if (name of first application process whose frontmost is true) is "iTerm2" then set isFront to true
              end tell
              if isFront then exit repeat
              delay 0.1
            end repeat
            tell aSession
              write text "${escapedText}" newline no
              write text "" newline yes
            end tell
            tell application "System Events"
              tell application process frontApp to set frontmost to true
            end tell
            return "ok"
          end if
        end repeat
      end repeat
    end tell
  end repeat
end tell

tell application "System Events"
  tell application process frontApp to set frontmost to true
end tell

return "not-found"`
}

// Pure — builds the read-only AppleScript that reads back `sessionId`'s
// current contents, used only to CONFIRM a write already landed. Never
// mutates anything, so it is always safe to retry in full — including via
// runOsascriptWithTabListRaceRetry's whole-script retry, and via
// pasteIntoSession's own outer confirm-poll below.
function buildReadSessionContentsScript(sessionId: string): string {
  const escapedSessionId = escapeForAppleScriptString(sessionId)
  return `tell application "iTerm2"
  repeat with aWindow in windows
    tell aWindow
      repeat with aTab in tabs
        repeat with aSession in sessions of aTab
          if id of aSession is "${escapedSessionId}" then
            select aTab
            select aWindow
            return contents of aSession
          end if
        end repeat
      end repeat
    end tell
  end repeat
end tell
return ""`
}

export async function pasteIntoSession(sessionId: string, text: string): Promise<boolean> {
  // Step 1 — write. This is the ONLY place `write text` can fire, and the
  // script above returns the instant it does, so retrying this call (on a
  // tab-list race or any other transient osascript error) can only mean the
  // write itself never happened — never a second write on top of one that
  // already landed.
  //
  // An earlier version wrote and confirmed inside ONE script, ending in a
  // shared `return` reached only after unwinding — or, in a version that
  // moved the `return` up but kept the confirm-poll ahead of it — after
  // finishing a 20-iteration confirm-poll that itself reads `contents of
  // aSession` repeatedly. Either shape leaves a window, between the write
  // firing and the script's return, where something can still throw (the
  // enclosing loops' live tab/window re-enumeration, or the confirm-poll's
  // own repeated reads under real multi-session AppleEvent load) —
  // and runOsascriptWithTabListRaceRetry then retries the WHOLE script,
  // including a fresh `write text`, even though the first write had already
  // landed. Reproduced: auto mode double-dispatching `/pipelinely-cr` into the
  // orchestrator session while other tasks churned concurrently
  // (e2e/integration/orchestrator-auto-mode.spec.ts's "dispatches exactly
  // once" case) — the double landed even after moving the return ahead of
  // the confirm-poll (a first fix attempt, commit 29f2a0f), because the
  // confirm-poll was still ahead of that return, not after it. The write and
  // the confirm are now two separate osascript invocations: nothing at all
  // can execute between the write firing and this script exiting.
  const writeScript = buildPasteIntoSessionWriteScript(sessionId, text)
  let writeResult: string
  try {
    writeResult = (await runOsascriptWithTabListRaceRetry(writeScript)).trim()
  } catch (error) {
    console.error('Failed to paste into iTerm session:', error)
    return false
  }
  if (writeResult !== 'ok') return false

  // Step 2 — confirm, entirely separately and read-only. Polls Node-side
  // (rather than looping inside one long-lived osascript process, as the
  // write+confirm-in-one-script version did) specifically so a transient
  // read failure can never be mistaken for "the write needs retrying" — it
  // can only ever mean "try the read again". Same 20 * 0.1s budget as
  // before. Compares against a whitespace-collapsed reading, not the raw
  // buffer: a message long enough to soft-wrap in the terminal gets a real
  // line break inserted into the buffer mid-string, which an exact substring
  // check can never match (see normalizeWhitespace's own comment).
  const normalizedTarget = normalizeWhitespace(text)
  const readScript = buildReadSessionContentsScript(sessionId)
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const { stdout } = await execa('osascript', ['-e', readScript])
      if (normalizeWhitespace(stdout).includes(normalizedTarget)) return true
    } catch {
      // Transient read failure (e.g. the same live tab-list race) — the next
      // iteration just tries the read again. Never touches `write text`.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  console.error(`pasteIntoSession: wrote to session ${sessionId} but its content never confirmed the text landed`)
  return false
}

// Sibling to pasteIntoSession — same session lookup, but appends
// `newline no` (confirmed against iTerm2.sdef's `write` command) so the
// command sits at the prompt for the developer to review before running it.
// Every /cockpit-<stage> invocation this dashboard stages goes through this
// — never pasteIntoSession — since each one spawns a worktree, a tab, or a
// PR and must never auto-confirm.
//
// Keeps `activate` (focus: true) — every "Start <stage>" click on the
// dashboard stages its command here, unsent, specifically so the developer
// reviews it before it runs. A staged-but-unsent command the developer can't
// find is useless, so this must bring the terminal forward, same as
// focusITermTab. (An earlier version of this fix removed `activate` here
// too, treating it as background noise like openNewTabRunning — wrong: this
// one is a direct, single, explicit button click, not automation firing
// repeatedly and unattended. Confirmed wrong by real usage: "Start plan
// review" stopped focusing the terminal, which is the whole point of
// staging instead of auto-submitting.)
export async function stageInSession(sessionId: string, text: string): Promise<boolean> {
  return writeToSession(sessionId, text, { submit: false, focus: true })
}

// Sibling to pasteIntoSession: writes the text and submits it (the Return
// sent as its own `write text` call, same split and for the same reason), but
// never `activate`s iTerm2.
//
// This is the auto-submitted remote/mobile stage-dispatch path. It fires
// unattended — triggered from the developer's phone while they may be working
// in a completely unrelated app on the desktop — so it must not raise iTerm2
// to the OS foreground. pasteIntoSession's activate-then-restore round trip
// is not good enough here: the restore puts focus back, but the jump itself is
// still visible, which is the exact symptom its own comment above describes
// ("observed live as iTerm2 windows 'jumping' forward").
//
// A manual "Start <stage>" click is unaffected and still uses stageInSession
// with focus: true — a human who just clicked a button wants the terminal
// brought forward. Only the unattended path is quiet.
//
// `select aTab`/`select aWindow` still run (buildSessionWriteScript emits them
// regardless of `focus`): they are what makes delivery reliable, and unlike
// `activate` they do not raise iTerm2 to the OS foreground. Deliberately no
// confirm-by-readback — this is the same { submit: true, focus: false } shape
// pasteIntoTrackedSession uses for its own submit:true callers without a
// reported delivery problem, so it follows that precedent rather than
// pasteIntoSession's heavier frontmost-poll-and-read-back loop, which exists
// specifically to close a race that only `activate` creates.
export async function pasteIntoSessionQuiet(sessionId: string, text: string): Promise<boolean> {
  return writeToSession(sessionId, text, { submit: true, focus: false })
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
export async function getLiveTmuxSessions(): Promise<Set<string> | null> {
  try {
    const { stdout } = await execa('tmux', ['ls', '-F', '#{session_name}'])
    return new Set(stdout.split('\n').map((s) => s.trim()).filter(Boolean))
  } catch {
    return null
  }
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
// session with that id is currently open / iTerm2 scripting fails. Exported
// for sessionIsClientOf (see Change 4 in tech-design.md), which needs it to
// check whether a specific tab is a client of a specific tmux session.
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
  // No `activate`, and no early `return` from inside the iTerm2 block — see
  // pasteIntoSession's comment for why (an AppleScript `return` inside a
  // `tell` exits the whole script, which would skip the focus restore).
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

export type TrackedSessionPasteResult =
  | { status: 'ok'; reattached: boolean }
  | { status: 'reattach-paste-failed' }
  | { status: 'no-session'; hadRecordedSession: boolean }

// Resolves a task's own recorded session to something writable and pastes
// `message` into it: paste into the recorded iTerm session; failing that (tab
// closed), reattach its detached-but-alive tmux session into a fresh tab,
// re-record the new id at target.sessionFilePath, and retry once. Used by
// POST /pipelinely-handover/:slug so a task's own session gets the same reattach-and-retry
// resilience /stage-skill's orchestrator-target branch already has via
// writeToOrchestrator — /stage-skill's own-session branch currently has none
// (`sessionId = task.itermSessionId ?? ''`, dead tab is a flat 503).
//
// Deliberately does not carry writeToOrchestrator's stray-shell-detection or
// adopt-already-attached-tab steps: those exist because the orchestrator's
// tmux pane can silently fall back to a shell after an unrelated crash, and
// because the orchestrator's tab is opened once and expected to live for a
// whole session. A task's own session doesn't share either failure mode in
// the same way, and `TrackedSessionPasteResult` has no 'stray-process'
// status — folding that check in here would need a status this feature's
// callers have nothing to do with.
export async function pasteIntoTrackedSession(
  target: { sessionId: string | null; tmuxSession: string | null; sessionFilePath: string },
  message: string,
  options?: Partial<SessionWriteOptions>,
): Promise<TrackedSessionPasteResult> {
  const writeOptions: SessionWriteOptions = { submit: true, focus: false, ...options }

  if (target.sessionId && await writeToSession(target.sessionId, message, writeOptions)) {
    return { status: 'ok', reattached: false }
  }

  if (!target.tmuxSession || !(await tmuxSessionExists(target.tmuxSession))) {
    return { status: 'no-session', hadRecordedSession: !!target.sessionId }
  }

  const newSessionId = await reattachAndRecord(target.tmuxSession, target.sessionFilePath)
  if (!newSessionId) {
    return { status: 'no-session', hadRecordedSession: true }
  }

  if (await writeToSession(newSessionId, message, writeOptions)) {
    return { status: 'ok', reattached: true }
  }
  return { status: 'reattach-paste-failed' }
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
// deny-list at worst lets a write reach some non-shell leftover, which is
// exactly the behavior shipping today.
const STRAY_SHELL_COMMANDS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'tcsh', 'csh', 'login',
])

// Returns the foreground command of `tmuxSession`'s ACTIVE pane, or null if
// the session is gone / tmux isn't running / the call failed. The active
// pane is deliberately the target rather than every pane in the session
// (`list-panes`): it is where keystrokes sent by an attached client actually
// land, which is precisely what this check is about. `=` forces exact
// session-name matching — same guard, same reason, as tmuxSessionExists' own
// comment about tmux's prefix-matching fallback. The trailing `:` (empty
// window/pane) is required, not decorative: measured on this machine (tmux
// 3.7b), `display-message -t '=name'` with no window/pane part fails to
// resolve to any pane at all (empty output, no error) — only session-level
// commands (has-session, list-clients, kill-session) tolerate a bare
// `=name`. `=name:` resolves to that session's current window's active pane,
// which is exactly what's wanted, while still refusing a same-prefixed
// session name (`=foo:` never matches session `foobar`).
async function getTmuxPaneCommand(tmuxSession: string): Promise<string | null> {
  try {
    const { stdout } = await execa('tmux', [
      'display-message', '-p', '-t', `=${tmuxSession}:`, '#{pane_current_command}',
    ])
    return stdout.trim() || null
  } catch {
    return null
  }
}

// Pure. `null` counts as stray, i.e. this gate fails CLOSED: it only ever
// runs after tmuxSessionExists has already confirmed the session is there,
// so a null here is a real tmux failure, not a normal state — and the whole
// point is to not type into a destination we could not verify.
export function isStrayShellCommand(paneCommand: string | null): boolean {
  return paneCommand === null || STRAY_SHELL_COMMANDS.has(paneCommand)
}

// Whether tmuxSession's active pane has fallen back to a shell — the claude
// REPL that used to own it is gone, even though the session and its attached
// clients still look perfectly healthy. Owns the console.error for the stray
// case: it is the only scope that has the offending pane command to name,
// and both call sites in writeToOrchestrator would otherwise duplicate the
// same log line.
export async function tmuxPaneIsStrayShell(tmuxSession: string): Promise<boolean> {
  const paneCommand = await getTmuxPaneCommand(tmuxSession)
  const stray = isStrayShellCommand(paneCommand)
  if (stray) {
    console.error(
      `ORCHESTRATOR_TMUX session "${tmuxSession}" is alive but its pane is at a shell prompt (${paneCommand ?? 'unreadable'}) — claude is not running there; refusing to type into it`,
    )
  }
  return stray
}

// Whether the recorded iTerm2 tab is currently an attached client of
// `tmuxSession` — i.e. text sent to that tab lands in that tmux pane.
// Composed from the primitives that already exist in this file (getSessionTty
// + getTmuxClientTtys + the pure isTtyAttached, the same trio
// waitForTmuxAttach polls on).
export async function sessionIsClientOf(sessionId: string, tmuxSession: string): Promise<boolean> {
  const tty = await getSessionTty(sessionId)
  const clientTtys = await getTmuxClientTtys(tmuxSession)
  return isTtyAttached(tty, clientTtys)
}
