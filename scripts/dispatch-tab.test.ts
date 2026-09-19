import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execa } from 'execa'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SCRIPT = path.join(import.meta.dirname, 'dispatch-tab.sh')
const SLUG = 'some-task'
const TMUX_NAME = `worker-${SLUG}`
const FAKE_ITERM_SESSION_ID = 'FAKE-ITERM-SESSION-ID'
const EXIT_BAD_ARGS = 2
const EXIT_COLLISION = 3

// Fake tmux/osascript go first on PATH so the real script runs end to end
// without touching the developer's real iTerm2 or tmux server. Each logs its
// argv (and osascript its stdin — the AppleScript source) so tests can
// assert exactly what would have been sent. FAKE_TAB_OUTCOME picks what the
// typed command did in the new tab — each one a real-world outcome QA hit:
// - launch-runs (default): our tmux session is up and ran our command, so the
//   session exists and the dispatch's ack file (osascript's 4th arg) exists.
// - launch-exits-immediately: our command ran, but the session is already gone.
// - command-never-runs: `write text` arrived corrupted; nothing happened.
// - name-taken-by-racer: another session grabbed the name after the collision
//   check, so ours failed — a session by that name exists, but no ack.
function writeFakeBin(binDir: string, name: string, body: string): void {
  const binPath = path.join(binDir, name)
  fs.writeFileSync(binPath, `#!/bin/bash\n${body}\n`)
  fs.chmodSync(binPath, 0o755)
}

describe('scripts/dispatch-tab.sh', () => {
  let rootDir: string
  let tasksDir: string
  let taskDir: string
  let launchScript: string
  let logDir: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-tab-'))
    tasksDir = path.join(rootDir, 'tasks')
    taskDir = path.join(tasksDir, SLUG)
    logDir = path.join(rootDir, 'log')
    const binDir = path.join(rootDir, 'bin')
    fs.mkdirSync(taskDir, { recursive: true })
    fs.mkdirSync(logDir)
    fs.mkdirSync(binDir)
    launchScript = path.join(taskDir, 'launch.sh')
    fs.writeFileSync(launchScript, '#!/bin/bash\n')
    fs.writeFileSync(path.join(taskDir, 'STATUS'), 'waiting: plan ready for review\n')

    writeFakeBin(binDir, 'tmux', [
      `printf '%s\\n' "$*" >> '${logDir}/tmux.args'`,
      'if [ -n "${FAKE_TMUX_HAS_SESSION_EXIT:-}" ]; then exit "$FAKE_TMUX_HAS_SESSION_EXIT"; fi',
      `[ -f '${logDir}/session-started' ]`,
    ].join('\n'))
    writeFakeBin(binDir, 'osascript', [
      `printf '%s\\n' "$@" > '${logDir}/osascript.args'`,
      `cat > '${logDir}/osascript.stdin'`,
      'if [ "${FAKE_OSASCRIPT_EXIT:-0}" != 0 ]; then echo "fake osascript failure" >&2; exit "$FAKE_OSASCRIPT_EXIT"; fi',
      'case "${FAKE_TAB_OUTCOME:-launch-runs}" in',
      `  launch-runs) touch '${logDir}/session-started' "$4" ;;`,
      '  launch-exits-immediately) touch "$4" ;;',
      `  name-taken-by-racer) touch '${logDir}/session-started' ;;`,
      'esac',
      `echo '${FAKE_ITERM_SESSION_ID}'`,
    ].join('\n'))

    env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      DISPATCH_TAB_SESSION_TIMEOUT_SECONDS: '1',
    }
  })

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  function validArgs(claimPointers: 'yes' | 'no'): string[] {
    return [
      '--tasks-dir', tasksDir,
      '--slug', SLUG,
      '--tmux-name', TMUX_NAME,
      '--launch-script', launchScript,
      '--claim-pointers', claimPointers,
    ]
  }

  function runScript(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
    return execa('bash', [SCRIPT, ...args], { env: { ...env, ...extraEnv }, reject: false })
  }

  const readTaskFile = (name: string) => fs.readFileSync(path.join(taskDir, name), 'utf8')
  const wasCalled = (bin: 'tmux' | 'osascript') => fs.existsSync(path.join(logDir, `${bin}.args`))

  describe('argument validation', () => {
    const withOverride = (flag: string, value: string) => {
      const args = validArgs('yes')
      args[args.indexOf(flag) + 1] = value
      return args
    }

    it.each([
      ['a missing flag', () => validArgs('yes').slice(2)],
      ['an unknown flag', () => [...validArgs('yes'), '--bogus', 'x']],
      ['a --claim-pointers value other than yes/no', () => withOverride('--claim-pointers', 'true')],
      ['a relative --tasks-dir', () => withOverride('--tasks-dir', 'tasks')],
      ['a relative --launch-script', () => withOverride('--launch-script', 'launch.sh')],
      ['a task dir that does not exist', () => withOverride('--slug', 'no-such-task')],
      ['a launch script that does not exist', () => withOverride('--launch-script', path.join(taskDir, 'missing.sh'))],
      ['a quote character in a value', () => withOverride('--tmux-name', `worker-"${SLUG}`)],
    ])('rejects %s without running tmux, osascript, or touching STATUS', async (_label, buildArgs) => {
      const result = await runScript(buildArgs())

      expect(result.exitCode).toBe(EXIT_BAD_ARGS)
      expect(result.stderr).not.toBe('')
      expect(wasCalled('tmux')).toBe(false)
      expect(wasCalled('osascript')).toBe(false)
      expect(readTaskFile('STATUS')).toBe('waiting: plan ready for review\n')
    })
  })

  describe('collision', () => {
    it('exits non-zero naming the collision and changes nothing', async () => {
      fs.writeFileSync(path.join(taskDir, 'ITERM_SESSION'), 'DEV-TAB-ID\n')

      const result = await runScript(validArgs('yes'), { FAKE_TMUX_HAS_SESSION_EXIT: '0' })

      expect(result.exitCode).toBe(EXIT_COLLISION)
      expect(result.stderr).toContain('COLLISION')
      expect(result.stderr).toContain(TMUX_NAME)
      expect(fs.readFileSync(path.join(logDir, 'tmux.args'), 'utf8')).toBe(`has-session -t =${TMUX_NAME}\n`)
      expect(wasCalled('osascript')).toBe(false)
      expect(readTaskFile('STATUS')).toBe('waiting: plan ready for review\n')
      expect(readTaskFile('ITERM_SESSION')).toBe('DEV-TAB-ID\n')
    })
  })

  describe('when no session owns the name', () => {
    it('writes STATUS=working, opens the tab, and claims both pointers', async () => {
      const result = await runScript(validArgs('yes'))

      expect(result.exitCode).toBe(0)
      expect(readTaskFile('STATUS')).toBe('working\n')
      const [stdinMarker, tmuxName, launchPath, ackPath] =
        fs.readFileSync(path.join(logDir, 'osascript.args'), 'utf8').split('\n')
      expect([stdinMarker, tmuxName, launchPath]).toEqual(['-', TMUX_NAME, launchScript])
      expect(fs.existsSync(ackPath)).toBe(false)
      expect(fs.readFileSync(path.join(logDir, 'osascript.stdin'), 'utf8')).toContain('COCKPIT_TMUX_COLLISION')
      expect(readTaskFile('ITERM_SESSION')).toBe(`${FAKE_ITERM_SESSION_ID}\n`)
      expect(readTaskFile('TMUX_SESSION')).toBe(`${TMUX_NAME}\n`)
    })

    it('never passes -A to tmux new-session, so a racing same-name session fails loudly', async () => {
      await runScript(validArgs('yes'))

      const appleScript = fs.readFileSync(path.join(logDir, 'osascript.stdin'), 'utf8')
      expect(appleScript).toContain('tmux new-session -s ')
      expect(appleScript).not.toMatch(/new-session[^\n]*-A/)
    })

    it('leaves the existing pointers alone when not claiming them', async () => {
      fs.writeFileSync(path.join(taskDir, 'ITERM_SESSION'), 'DEV-TAB-ID\n')
      fs.writeFileSync(path.join(taskDir, 'TMUX_SESSION'), `${TMUX_NAME}\n`)
      const args = validArgs('no')
      args[args.indexOf('--tmux-name') + 1] = `${TMUX_NAME}-cr`

      const result = await runScript(args)

      expect(result.exitCode).toBe(0)
      expect(readTaskFile('STATUS')).toBe('working\n')
      expect(readTaskFile('ITERM_SESSION')).toBe('DEV-TAB-ID\n')
      expect(readTaskFile('TMUX_SESSION')).toBe(`${TMUX_NAME}\n`)
    })
  })

  describe('when the tab opens but this dispatch\'s command never runs', () => {
    const expectNothingClaimed = () => {
      expect(readTaskFile('STATUS')).toBe('waiting: plan ready for review\n')
      expect(fs.existsSync(path.join(taskDir, 'ITERM_SESSION'))).toBe(false)
      expect(fs.existsSync(path.join(taskDir, 'TMUX_SESSION'))).toBe(false)
    }

    it('reports a corrupted command when no session by that name ever appears', async () => {
      const result = await runScript(validArgs('yes'), { FAKE_TAB_OUTCOME: 'command-never-runs' })

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain(TMUX_NAME)
      expect(result.stderr).toContain(FAKE_ITERM_SESSION_ID)
      expect(result.stderr).toContain('corrupted')
      expectNothingClaimed()
    })

    it('reports a lost race, not success, when another session took the name first', async () => {
      const result = await runScript(validArgs('yes'), { FAKE_TAB_OUTCOME: 'name-taken-by-racer' })

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('COLLISION')
      expect(result.stderr).toContain(TMUX_NAME)
      expectNothingClaimed()
    })
  })

  describe('when the launch script exits almost immediately', () => {
    it('still counts as a successful dispatch, because this dispatch\'s command did run', async () => {
      const result = await runScript(validArgs('yes'), { FAKE_TAB_OUTCOME: 'launch-exits-immediately' })

      expect(result.exitCode).toBe(0)
      expect(readTaskFile('STATUS')).toBe('working\n')
      expect(readTaskFile('TMUX_SESSION')).toBe(`${TMUX_NAME}\n`)
    })
  })

  describe('when osascript fails', () => {
    it('restores the previous STATUS, claims no pointers, and exits non-zero', async () => {
      const result = await runScript(validArgs('yes'), { FAKE_OSASCRIPT_EXIT: '1' })

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('fake osascript failure')
      expect(readTaskFile('STATUS')).toBe('waiting: plan ready for review\n')
      expect(fs.existsSync(path.join(taskDir, 'ITERM_SESSION'))).toBe(false)
      expect(fs.existsSync(path.join(taskDir, 'TMUX_SESSION'))).toBe(false)
    })

    it('removes STATUS again when there was no previous one', async () => {
      fs.rmSync(path.join(taskDir, 'STATUS'))

      const result = await runScript(validArgs('yes'), { FAKE_OSASCRIPT_EXIT: '1' })

      expect(result.exitCode).toBe(1)
      expect(fs.existsSync(path.join(taskDir, 'STATUS'))).toBe(false)
    })
  })
})
