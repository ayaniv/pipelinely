import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  decideReattachAction,
  buildTmuxAttachCommand,
  isTtyAttached,
  isStrayShellCommand,
  reattachAndRecord,
  getLiveTmuxSessions,
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

// Dispatch writes go through the tmux pane writer only; the iTerm2 module
// keeps focusing, enumerating and opening tabs, none of which types into an
// existing window.
describe('the AppleScript write path is gone', () => {
  it.each([
    'pasteIntoSession',
    'pasteIntoSessionQuiet',
    'stageInSession',
    'pasteIntoTrackedSession',
    'buildSessionWriteScript',
    'buildPasteIntoSessionWriteScript',
    'sessionIsClientOf',
    'tmuxPaneIsStrayShell',
  ])('does not export %s', async (name) => {
    const focusTab = await import('./focusTab.js')
    expect(Object.keys(focusTab)).not.toContain(name)
  })

  it('still exports the non-typing tab helpers', async () => {
    const focusTab = await import('./focusTab.js')
    for (const name of ['focusITermTab', 'findSessionAttachedToTmux', 'reattachAndRecord', 'reattachOrFocus', 'readPaneState', 'sendKeysToPane']) {
      expect(Object.keys(focusTab)).toContain(name)
    }
  })
})

describe('getLiveTmuxSessions', () => {
  let binDir: string
  let originalPath: string | undefined

  beforeEach(async () => {
    binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-fake-tmux-'))
    originalPath = process.env.PATH
    process.env.PATH = `${binDir}:${originalPath}`
  })

  afterEach(async () => {
    process.env.PATH = originalPath
    await fs.rm(binDir, { recursive: true, force: true })
  })

  async function installFakeTmux(script: string): Promise<void> {
    await fs.writeFile(path.join(binDir, 'tmux'), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  }

  it('returns the live session names', async () => {
    await installFakeTmux('printf "worker-a\\nworker-b\\n"')
    expect(await getLiveTmuxSessions({ timeoutMs: 2000 })).toEqual(new Set(['worker-a', 'worker-b']))
  })

  it('rejects when tmux hangs past the timeout, so the caller can log it', async () => {
    await installFakeTmux('sleep 5')
    await expect(getLiveTmuxSessions({ timeoutMs: 100 })).rejects.toMatchObject({ timedOut: true })
  })

  it('returns null when tmux fails', async () => {
    await installFakeTmux('exit 1')
    expect(await getLiveTmuxSessions()).toBeNull()
  })
})
