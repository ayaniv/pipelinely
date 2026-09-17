import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  decideReattachAction,
  buildTmuxAttachCommand,
  isTtyAttached,
  isStrayShellCommand,
  reattachAndRecord,
  buildSessionWriteScript,
  buildPasteIntoSessionWriteScript,
  pasteIntoTrackedSession,
} from './focusTab.js'

describe('decideReattachAction', () => {
  it('focuses when the iTerm session is live', () => {
    expect(decideReattachAction('iterm-1', new Set(['iterm-1']), 'worker-foo', true)).toBe('focus')
  })

  it('reattaches when the iTerm session is dead but the tmux session is live', () => {
    expect(decideReattachAction('iterm-1', new Set(), 'worker-foo', true)).toBe('reattach')
  })

  it('does nothing when both the iTerm session and tmux session are dead', () => {
    expect(decideReattachAction('iterm-1', new Set(), 'worker-foo', false)).toBe('none')
  })

  it('does nothing when there is no tmux session on record and iTerm is dead', () => {
    expect(decideReattachAction('iterm-1', new Set(), null, false)).toBe('none')
  })

  it('does nothing when liveIds is null (iTerm scripting unavailable) and there is no tmux session', () => {
    expect(decideReattachAction('iterm-1', null, null, false)).toBe('none')
  })

  it('reattaches when liveIds is null but the tmux session is confirmed live', () => {
    expect(decideReattachAction('iterm-1', null, 'worker-foo', true)).toBe('reattach')
  })
})

describe('buildTmuxAttachCommand', () => {
  it('single-quotes the =-prefixed target so zsh does not equals-expand it', () => {
    // Regression test: an unquoted `=orchestrator-s2` is expanded by zsh's
    // EQUALS option (default-on in interactive shells) to the path of an
    // executable literally named "orchestrator-s2" before tmux ever sees it,
    // which is what caused "zsh: orchestrator-s2 not found" even though the
    // tmux session existed. Single-quoting the whole `=name` token suppresses
    // that expansion while tmux still receives the literal exact-match target.
    expect(buildTmuxAttachCommand('orchestrator-s2')).toBe("tmux attach -d -t '=orchestrator-s2'")
  })

  it('accepts worker/orchestrator slugs built from letters, digits, dots, underscores and hyphens', () => {
    expect(buildTmuxAttachCommand('worker-fix-reattach-tmux-equals-quoting')).toBe(
      "tmux attach -d -t '=worker-fix-reattach-tmux-equals-quoting'"
    )
  })

  it('refuses a session name containing a single quote, rather than risk breaking out of the shell string', () => {
    expect(buildTmuxAttachCommand("worker-foo'; rm -rf ~")).toBeNull()
  })

  it('refuses a session name containing whitespace or shell metacharacters', () => {
    expect(buildTmuxAttachCommand('worker-foo; echo pwned')).toBeNull()
    expect(buildTmuxAttachCommand('worker foo')).toBeNull()
  })
})

describe('isTtyAttached', () => {
  // Regression test for the reattach-verification gap: reattachTmuxSession
  // used to return the new tab's session id as soon as the tab existed,
  // without confirming the `tmux attach` command typed into it actually
  // succeeded — so a shell-level failure (e.g. the equals-quoting bug fixed
  // separately) still got recorded as the new "live" orchestrator session.
  it('is attached when the tty is among the tmux session\'s client ttys', () => {
    expect(isTtyAttached('/dev/ttys031', new Set(['/dev/ttys031', '/dev/ttys002']))).toBe(true)
  })

  it('is not attached when the tty is absent from the client list', () => {
    expect(isTtyAttached('/dev/ttys031', new Set(['/dev/ttys002']))).toBe(false)
  })

  it('is not attached when there are no tmux clients at all', () => {
    expect(isTtyAttached('/dev/ttys031', new Set())).toBe(false)
  })

  it('is not attached when the client list is unavailable (tmux query failed)', () => {
    expect(isTtyAttached('/dev/ttys031', null)).toBe(false)
  })

  it('is not attached when the iTerm session itself was never found (no tty)', () => {
    expect(isTtyAttached(null, new Set(['/dev/ttys031']))).toBe(false)
  })
})

describe('isStrayShellCommand', () => {
  // These are the cases that would have caught the earlier draft's bug: an
  // exact-match allow-list (`paneCommand === 'claude'`) looks right until you
  // measure what a real installed CLI actually reports (see Change 4 in
  // tech-design.md) — a version-named executable, not the literal `claude`.
  it.each(['zsh', 'bash', 'sh', 'fish', 'login'])('treats %s as a stray shell', (shell) => {
    expect(isStrayShellCommand(shell)).toBe(true)
  })

  it('treats null (tmux query failed) as stray — this gate fails closed', () => {
    expect(isStrayShellCommand(null)).toBe(true)
  })

  it('does not treat "claude" itself as stray', () => {
    expect(isStrayShellCommand('claude')).toBe(false)
  })

  it('does not treat a version-named executable as stray — what the real installed CLI actually reports to pane_current_command, since ~/.local/bin/claude is a symlink to a version-named file and tmux resolves the symlink before naming the process', () => {
    expect(isStrayShellCommand('2.1.251')).toBe(false)
  })
})

describe('reattachAndRecord', () => {
  it('returns null and leaves the pointer file untouched when reattachTmuxSession fails', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-focustab-test-'))
    const pointerPath = path.join(tmpDir, 'POINTER')
    await fs.writeFile(pointerPath, 'original-session-id')
    try {
      // An unsafe session name makes reattachTmuxSession refuse before it
      // ever shells out to osascript/tmux (see buildTmuxAttachCommand), so
      // this is a real failure path with no live automation required.
      const result = await reattachAndRecord("worker-foo'; rm -rf ~", pointerPath)
      expect(result).toBeNull()
      expect(await fs.readFile(pointerPath, 'utf-8')).toBe('original-session-id')
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('buildSessionWriteScript', () => {
  it('submit: true sends the text unterminated, then a second empty write with newline yes', () => {
    const script = buildSessionWriteScript('sess-1', 'hello', { submit: true, focus: true })
    expect(script).toContain('write text "hello" newline no')
    expect(script).toContain('write text "" newline yes')
  })

  it('submit: false omits the trailing Return write entirely', () => {
    const script = buildSessionWriteScript('sess-1', 'hello', { submit: false, focus: true })
    expect(script).toContain('write text "hello" newline no')
    expect(script).not.toContain('newline yes')
  })

  it('focus: true includes activate and select', () => {
    const script = buildSessionWriteScript('sess-1', 'hello', { submit: true, focus: true })
    expect(script).toContain('activate')
    expect(script).toContain('select aTab')
    expect(script).toContain('select aWindow')
  })

  // This exact option pair is pasteIntoSessionQuiet's — the auto-submitted
  // mobile stage-dispatch path. All four assertions matter together: it must
  // really submit (both write lines) while really not activating, since the
  // whole reason that export exists is to run unattended without jumping the
  // developer's windows. `select` stays either way — it is what makes
  // delivery reliable, and unlike `activate` it never raises iTerm2 to the OS
  // foreground.
  it('focus: false omits activate (must not steal OS focus) but still selects the tab/window (needed for reliable delivery — see this function\'s own comment) and still submits', () => {
    const script = buildSessionWriteScript('sess-1', 'hello', { submit: true, focus: false })
    expect(script).not.toContain('activate')
    expect(script).toContain('select aTab')
    expect(script).toContain('select aWindow')
    expect(script).toContain('write text "hello" newline no')
    expect(script).toContain('write text "" newline yes')
  })

  it('escapes a backslash and a double quote in the text so the literal is not terminated early', () => {
    const script = buildSessionWriteScript('sess-1', 'say "hi" \\ bye', { submit: true, focus: true })
    expect(script).toContain('write text "say \\"hi\\" \\\\ bye" newline no')
  })

  it('escapes a backslash and a double quote in the session id', () => {
    const script = buildSessionWriteScript('sess"1\\x', 'hello', { submit: true, focus: true })
    expect(script).toContain('id of aSession is "sess\\"1\\\\x"')
  })

  it('escapes an embedded \\n as the two-character AppleScript escape rather than a raw line break', () => {
    const script = buildSessionWriteScript('sess-1', 'line one\nline two', { submit: true, focus: true })
    expect(script).toContain('write text "line one\\nline two" newline no')
    expect(script.split('\n').some((line) => line.includes('line one') && !line.includes('line two'))).toBe(false)
  })

  it('escapes an embedded \\r\\n the same way as a bare \\n', () => {
    const script = buildSessionWriteScript('sess-1', 'line one\r\nline two', { submit: true, focus: true })
    expect(script).toContain('write text "line one\\nline two" newline no')
  })
})

describe('buildPasteIntoSessionWriteScript', () => {
  // Regression test for a real double-dispatch: auto mode landed
  // `/pipelinely-cr` twice in the orchestrator session while other tasks
  // churned concurrently (e2e/integration/orchestrator-auto-mode.spec.ts's
  // "dispatches exactly once, even as other tasks churn" case). Root cause —
  // a first fix attempt (commit 29f2a0f) moved the `return` up to right
  // after a write+confirm-poll branch, but the confirm-poll itself was still
  // AHEAD of that return: it repeatedly reads `contents of aSession`, which
  // can throw under real multi-session AppleEvent load exactly like the
  // enclosing loops' live tab/window re-enumeration this file's header
  // comment documents ("Can't get item N ... Invalid index" when a sibling
  // session opens/closes a tab mid-walk). Any throw between the write firing
  // and the script's return — whichever loop it comes from — makes
  // runOsascriptWithTabListRaceRetry blindly retry the WHOLE script,
  // including a fresh `write text`, even though the first write had already
  // landed. The write script now contains no confirm-poll at all: nothing
  // enumerable, and nothing that reads iTerm2 state more than once, sits
  // between the write firing and the return.
  it('returns immediately once the write fires — nothing else executes between the write and the return', () => {
    const script = buildPasteIntoSessionWriteScript('sess-1', 'hello')
    const writeIndex = script.indexOf('write text "hello" newline no')
    expect(writeIndex).toBeGreaterThan(-1)

    const returnIndex = script.indexOf('return "ok"', writeIndex)
    expect(returnIndex).toBeGreaterThan(-1)

    const tailToReturn = script.slice(writeIndex, returnIndex)
    expect(tailToReturn).not.toMatch(/\brepeat\b/)
    expect(tailToReturn).not.toContain('contents of aSession')
    expect(tailToReturn).toContain('tell application process frontApp to set frontmost to true')
  })

  it('the not-found path (no matching session) still restores frontmost and returns — safe to retry, since no write occurred', () => {
    const script = buildPasteIntoSessionWriteScript('sess-1', 'hello')
    // The write only ever fires inside the `if id of aSession is ...` match
    // branch, which this same script's own "ok" test already pins down —
    // this test just confirms the OUTER not-found path (the id never
    // matching anything) still ends in its own restore + return, reached
    // only if that branch's `return "ok"` never fired.
    expect(script.trim().endsWith('return "not-found"')).toBe(true)
    const lastReturnIndex = script.lastIndexOf('return "not-found"')
    const precedingLines = script.slice(0, lastReturnIndex).trimEnd()
    expect(precedingLines.endsWith('end tell')).toBe(true)
    expect(precedingLines).toContain('tell application process frontApp to set frontmost to true')
  })

  it('escapes a backslash and a double quote in the text so the literal is not terminated early', () => {
    const script = buildPasteIntoSessionWriteScript('sess-1', 'say "hi" \\ bye')
    expect(script).toContain('write text "say \\"hi\\" \\\\ bye" newline no')
  })

  it('escapes a backslash and a double quote in the session id', () => {
    const script = buildPasteIntoSessionWriteScript('sess"1\\x', 'hello')
    expect(script).toContain('id of aSession is "sess\\"1\\\\x"')
  })
})

describe('pasteIntoTrackedSession', () => {
  // Pure exit: no sessionId means the paste attempt is skipped outright (no
  // osascript call), and no tmuxSession means there is nothing to reattach
  // either — no execa call of any kind, so this needs no live iTerm2/tmux.
  it('reports no-session, hadRecordedSession: false when neither a session nor a tmux session is recorded', async () => {
    const result = await pasteIntoTrackedSession(
      { sessionId: null, tmuxSession: null, sessionFilePath: '/tmp/unused-pointer' },
      'irrelevant message',
    )
    expect(result).toEqual({ status: 'no-session', hadRecordedSession: false })
  })
})
