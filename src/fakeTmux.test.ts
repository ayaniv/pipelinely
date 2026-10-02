import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The e2e fake tmux must refuse every write AND leave a record of it (and of nothing else), so a spec can
// prove "nothing was sent" instead of trusting a response body. The script
// locates its panes and its record relative to itself, so each case runs a
// copy inside a throwaway fixtures tree: the real record is never touched.

const REAL_FAKE_TMUX = path.join(__dirname, '..', 'e2e', 'fixtures', 'bin', 'tmux')

let fixturesDir: string
let tmuxPath: string
let writeAttemptsLog: string

const runTmux = (...args: string[]) => spawnSync('bash', [tmuxPath, ...args], { encoding: 'utf8' })

beforeEach(() => {
  fixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-tmux-test-'))
  fs.mkdirSync(path.join(fixturesDir, 'bin'))
  fs.mkdirSync(path.join(fixturesDir, 'panes'))
  fs.writeFileSync(path.join(fixturesDir, 'panes', 'worker-x.txt'), 'pane text\n')
  tmuxPath = path.join(fixturesDir, 'bin', 'tmux')
  fs.copyFileSync(REAL_FAKE_TMUX, tmuxPath)
  writeAttemptsLog = path.join(fixturesDir, 'fake-mux', 'write-attempts.log')
})

afterEach(() => {
  fs.rmSync(fixturesDir, { recursive: true, force: true })
})

describe('e2e fake tmux', () => {
  it('still serves the read commands, and records nothing for them', () => {
    expect(runTmux('ls').stdout).toBe('worker-x\n')
    expect(runTmux('capture-pane', '-p', '-J', '-t', '=worker-x:').stdout).toBe('pane text\n')
    expect(fs.existsSync(writeAttemptsLog)).toBe(false)
  })

  it('refuses send-keys with a failure and records the attempt with its arguments', () => {
    const result = runTmux('send-keys', '-t', '%7', '-l', '1')
    expect(result.status).not.toBe(0)
    expect(fs.readFileSync(writeAttemptsLog, 'utf8')).toBe('send-keys -t %7 -l 1\n')
  })

  it.each(['kill-session', 'new-session', 'attach-session', 'resize-window', 'paste-buffer'])('refuses and records the unsupported write %s', (subcommand) => {
    expect(runTmux(subcommand, '-t', '=worker-x:').status).not.toBe(0)
    expect(fs.readFileSync(writeAttemptsLog, 'utf8')).toBe(`${subcommand} -t =worker-x:\n`)
  })

  // A /focus click on another spec's fixture issues these while the answer
  // spec runs; logging them would fail its "nothing was sent" check.
  it.each([
    ['display-message', '-p', '-t', '=worker-x:', '#{pane_id}'],
    ['display-message', '-p', '-t', '=worker-x:', '#{pane_current_command}'],
    ['list-clients', '-t', '=worker-x:'],
    ['list-panes', '-t', '=worker-x:'],
  ])('refuses the unmodelled read %s without recording it', (...args) => {
    expect(runTmux(...args).status).not.toBe(0)
    expect(fs.existsSync(writeAttemptsLog)).toBe(false)
  })

  it('appends one line per attempt', () => {
    runTmux('send-keys', '-t', '%7', 'Escape')
    runTmux('send-keys', '-t', '%7', 'Escape')
    expect(fs.readFileSync(writeAttemptsLog, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('has a bash syntax that parses', () => {
    expect(() => execFileSync('bash', ['-n', REAL_FAKE_TMUX])).not.toThrow()
  })
})
