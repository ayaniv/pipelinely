import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execaMock = vi.hoisted(() => vi.fn())
vi.mock('execa', () => ({ execa: execaMock }))

import { TMUX_WRITE_TIMEOUT_MS } from './focusTab.js'
import { writeTextToTmuxSession } from './tmuxPaneWrite.js'

// The tmux dispatch writer (tech-design.md, tmux-dispatch-writes-plan). Every
// case runs against FakeTmux below, an in-memory stand-in installed as the
// execa mock: nothing here can reach a real tmux server. FakeTmux models the
// commands the writer is allowed to issue (display-message, capture-pane,
// load-buffer, paste-buffer, delete-buffer, send-keys) the way tmux 3.7b
// behaves — measured on a private `-L` socket while planning and again in
// plan review — and records what the pane would actually receive, so
// assertions are about delivered input, not argv trivia:
//   - a `-t '=name:'` that matches no session exits 0 with EMPTY output (the
//     silent false negative the writer must catch itself);
//   - `paste-buffer -p` wraps the buffer in bracketed-paste markers only when
//     the pane's app turned bracketed paste on;
//   - `paste-buffer -d` deletes the buffer once pasted;
//   - `paste-buffer -d` that FAILS (e.g. the pane died) leaves the buffer
//     behind, so the writer must `delete-buffer` it itself;
//   - without `-S`, `paste-buffer` itself rewrites ESC and DEL as visible
//     `^[`/`^?` (vis(3)) — a second layer behind the writer's own unsafe-text
//     refusal, which is why the writer must never pass `-S`;
//   - `send-keys Enter` is one CR keystroke, separate from the paste.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIALOG_PANE_FIXTURE = path.join(__dirname, '..', 'e2e', 'fixtures', 'panes', 'worker-answer-dialog-perm.txt')

interface FakePane {
  id: string
  currentCommand: string
  bracketedPaste: boolean
  inMode: boolean
  screen: string
}

type Delivered =
  | { kind: 'paste'; text: string; bracketed: boolean }
  | { kind: 'key'; key: string }

interface ExecaOptions { timeout?: number; input?: string; shell?: unknown }

class FakeTmux {
  sessions = new Map<string, FakePane>()
  buffers = new Map<string, string>()
  delivered = new Map<string, Delivered[]>()
  calls: { args: string[]; options: ExecaOptions }[] = []
  failOn: { sub: string; error: Error } | null = null
  // Runs after a paste lands, to model the pane changing under the writer
  // (e.g. a mid-turn claude opening a permission dialog).
  afterPaste: ((pane: FakePane) => void) | null = null

  addSession(name: string, pane: Partial<FakePane> = {}): FakePane {
    const full: FakePane = {
      id: `%${this.sessions.size + 7}`,
      currentCommand: '2.1.251',
      bracketedPaste: true,
      inMode: false,
      screen: '> ',
      ...pane,
    }
    this.sessions.set(name, full)
    this.delivered.set(full.id, [])
    return full
  }

  private paneByTarget(target: string): FakePane | null {
    if (target.startsWith('%')) return [...this.sessions.values()].find((p) => p.id === target) ?? null
    const exact = /^=([^:]+):$/.exec(target)
    return exact ? this.sessions.get(exact[1]) ?? null : null
  }

  private flag(args: string[], name: string): string | null {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : null
  }

  async run(file: string, args: string[], options: ExecaOptions = {}): Promise<{ stdout: string }> {
    if (file !== 'tmux') throw new Error(`FakeTmux: unexpected binary ${file}`)
    this.calls.push({ args, options })
    const [sub, ...rest] = args
    if (this.failOn?.sub === sub) throw this.failOn.error

    switch (sub) {
      case 'display-message': {
        const pane = this.paneByTarget(this.flag(rest, '-t') ?? '')
        const format = rest[rest.length - 1]
        if (!pane) return { stdout: '' }
        return {
          stdout: format
            .replace(/#\{pane_id\}/g, pane.id)
            .replace(/#\{pane_current_command\}/g, pane.currentCommand)
            .replace(/#\{bracket_paste_flag\}/g, pane.bracketedPaste ? '1' : '0')
            .replace(/#\{pane_in_mode\}/g, pane.inMode ? '1' : '0'),
        }
      }
      case 'capture-pane': {
        const pane = this.paneByTarget(this.flag(rest, '-t') ?? '')
        if (!pane) throw new Error("can't find pane")
        return { stdout: pane.screen }
      }
      case 'load-buffer': {
        const name = this.flag(rest, '-b')
        if (!name || rest[rest.length - 1] !== '-') throw new Error('FakeTmux: load-buffer must be -b <name> -')
        this.buffers.set(name, options.input ?? '')
        return { stdout: '' }
      }
      case 'paste-buffer': {
        const name = this.flag(rest, '-b')
        const pane = this.paneByTarget(this.flag(rest, '-t') ?? '')
        if (!name || !this.buffers.has(name)) throw new Error('no buffer')
        if (!pane) throw new Error("can't find pane")
        const raw = this.buffers.get(name) as string
        const text = rest.includes('-r') ? raw : raw.replace(/\n/g, '\r')
        this.delivered.get(pane.id)?.push({ kind: 'paste', text, bracketed: rest.includes('-p') && pane.bracketedPaste })
        if (rest.includes('-d')) this.buffers.delete(name)
        this.afterPaste?.(pane)
        return { stdout: '' }
      }
      case 'delete-buffer': {
        const name = this.flag(rest, '-b')
        if (!name || !this.buffers.has(name)) throw new Error('no buffer')
        this.buffers.delete(name)
        return { stdout: '' }
      }
      case 'send-keys': {
        const pane = this.paneByTarget(this.flag(rest, '-t') ?? '')
        if (!pane) throw new Error("can't find pane")
        const keys = rest.slice(rest.indexOf(this.flag(rest, '-t') as string) + 1)
        for (const key of keys) this.delivered.get(pane.id)?.push({ kind: 'key', key })
        return { stdout: '' }
      }
      default:
        throw new Error(`FakeTmux: the writer must not issue ${sub}`)
    }
  }

  deliveredTo(session: string): Delivered[] {
    const pane = this.sessions.get(session)
    return pane ? this.delivered.get(pane.id) ?? [] : []
  }

  writeCalls(): string[][] {
    return this.calls.map((c) => c.args).filter(([sub]) => ['load-buffer', 'paste-buffer', 'send-keys'].includes(sub))
  }
}

let tmux: FakeTmux

beforeEach(() => {
  tmux = new FakeTmux()
  execaMock.mockReset()
  execaMock.mockImplementation((file: string, args: string[], options?: ExecaOptions) => tmux.run(file, args, options))
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('writeTextToTmuxSession — delivery', () => {
  it('stages: pastes the text as ONE bracketed paste into the exact session\'s pane and presses nothing', async () => {
    tmux.addSession('orchestrator')
    const result = await writeTextToTmuxSession('orchestrator', '/pipelinely-dev some-task', { submit: false })
    expect(result).toEqual({ status: 'ok', paneId: '%7' })
    expect(tmux.deliveredTo('orchestrator')).toEqual([{ kind: 'paste', text: '/pipelinely-dev some-task', bracketed: true }])
  })

  it('submits: the same paste, then Enter as its own keystroke after it', async () => {
    tmux.addSession('orchestrator')
    const result = await writeTextToTmuxSession('orchestrator', "Let's do this backlog item: x", { submit: true })
    expect(result.status).toBe('ok')
    expect(tmux.deliveredTo('orchestrator')).toEqual([
      { kind: 'paste', text: "Let's do this backlog item: x", bracketed: true },
      { kind: 'key', key: 'Enter' },
    ])
  })

  it('delivers multi-line text, quotes, $, backticks and ; verbatim, through stdin and never through argv', async () => {
    tmux.addSession('orchestrator')
    const text = 'line one "q" $HOME `x`\nline two ; rm -rf ~'
    await writeTextToTmuxSession('orchestrator', text, { submit: false })
    expect(tmux.deliveredTo('orchestrator')).toEqual([{ kind: 'paste', text, bracketed: true }])
    for (const { args } of tmux.calls) {
      expect(args.join(' ')).not.toContain('rm -rf')
    }
  })

  it('delivers a slash command with tabs and non-ASCII text (Hebrew, emoji) byte for byte', async () => {
    tmux.addSession('orchestrator')
    const text = '/pipelinely-dev x\tשלום עולם 🚀 é'
    await writeTextToTmuxSession('orchestrator', text, { submit: true })
    expect(tmux.deliveredTo('orchestrator')).toEqual([
      { kind: 'paste', text, bracketed: true },
      { kind: 'key', key: 'Enter' },
    ])
  })

  it('delivers a very long command intact', async () => {
    tmux.addSession('orchestrator')
    const text = `Dispatch these 40 backlog items in parallel: ${'(n) a fairly long item description; '.repeat(400)}`.trim()
    await writeTextToTmuxSession('orchestrator', text, { submit: false })
    expect(tmux.deliveredTo('orchestrator')).toEqual([{ kind: 'paste', text, bracketed: true }])
  })

  it('pins the pane once: every call after the lookup targets the %id, never the session name', async () => {
    tmux.addSession('orchestrator')
    await writeTextToTmuxSession('orchestrator', 'x', { submit: true })
    const [lookup, ...rest] = tmux.calls.map((c) => c.args)
    expect(lookup.slice(0, 4)).toEqual(['display-message', '-p', '-t', '=orchestrator:'])
    for (const args of rest) {
      const target = args[args.indexOf('-t') + 1]
      if (args.includes('-t')) expect(target).toBe('%7')
    }
  })

  it('runs every tmux call with the write timeout and without a shell', async () => {
    tmux.addSession('orchestrator')
    await writeTextToTmuxSession('orchestrator', 'x', { submit: true })
    expect(tmux.calls.length).toBeGreaterThan(0)
    for (const { options } of tmux.calls) {
      expect(options.timeout).toBe(TMUX_WRITE_TIMEOUT_MS)
      expect(options).not.toHaveProperty('shell')
    }
  })

  it('pastes with -p -r -d and never -S, so tmux keeps sanitizing control characters', async () => {
    tmux.addSession('orchestrator')
    await writeTextToTmuxSession('orchestrator', 'x', { submit: false })
    const paste = tmux.calls.find((c) => c.args[0] === 'paste-buffer')?.args ?? []
    expect(paste).toEqual(expect.arrayContaining(['-p', '-r', '-d']))
    expect(paste).not.toContain('-S')
  })

  it('uses a fresh, uniquely named paste buffer per write and leaves none behind', async () => {
    tmux.addSession('orchestrator')
    await writeTextToTmuxSession('orchestrator', 'first', { submit: false })
    await writeTextToTmuxSession('orchestrator', 'second', { submit: false })
    const bufferNames = tmux.calls.filter((c) => c.args[0] === 'load-buffer').map((c) => c.args[c.args.indexOf('-b') + 1])
    expect(bufferNames).toHaveLength(2)
    expect(new Set(bufferNames).size).toBe(2)
    expect(tmux.buffers.size).toBe(0)
  })
})

describe('writeTextToTmuxSession — refuses before typing anything', () => {
  it('refuses an unsafe session name without calling tmux', async () => {
    const result = await writeTextToTmuxSession("orch'; rm -rf ~", 'x', { submit: true })
    expect(result).toEqual({ status: 'refused', reason: 'unsafe-session-name' })
    expect(tmux.calls).toEqual([])
  })

  it('treats the exit-0-but-empty lookup of a missing session as no pane, not as success', async () => {
    tmux.addSession('orchestrator-old')
    const result = await writeTextToTmuxSession('orchestrator', 'x', { submit: true })
    expect(result).toEqual({ status: 'refused', reason: 'no-pane' })
    expect(tmux.writeCalls()).toEqual([])
    expect(console.error).toHaveBeenCalled()
  })

  it('never matches a same-prefixed session (`=name:` exact match)', async () => {
    tmux.addSession('worker-foo-followup')
    const result = await writeTextToTmuxSession('worker-foo', 'x', { submit: false })
    expect(result).toEqual({ status: 'refused', reason: 'no-pane' })
    expect(tmux.deliveredTo('worker-foo-followup')).toEqual([])
  })

  it.each(['zsh', 'bash', 'login'])('refuses a pane that fell back to a %s prompt', async (shell) => {
    tmux.addSession('orchestrator', { currentCommand: shell })
    const result = await writeTextToTmuxSession('orchestrator', '/pipelinely-dev x', { submit: true })
    expect(result).toEqual({ status: 'refused', reason: 'stray-shell' })
    expect(tmux.writeCalls()).toEqual([])
    expect(console.error).toHaveBeenCalled()
  })

  it('refuses a pane whose app has not turned bracketed paste on (a newline would be a submit)', async () => {
    tmux.addSession('orchestrator', { bracketedPaste: false })
    const result = await writeTextToTmuxSession('orchestrator', 'x', { submit: false })
    expect(result).toEqual({ status: 'refused', reason: 'no-bracketed-paste' })
    expect(tmux.writeCalls()).toEqual([])
  })

  it('refuses a pane in copy mode (Enter would be eaten by the mode, not the app)', async () => {
    tmux.addSession('orchestrator', { inMode: true })
    const result = await writeTextToTmuxSession('orchestrator', 'x', { submit: true })
    expect(result).toEqual({ status: 'refused', reason: 'pane-in-mode' })
    expect(tmux.writeCalls()).toEqual([])
  })

  it('refuses a pane showing a selection dialog (typed text and Enter would answer it)', async () => {
    tmux.addSession('orchestrator', { screen: await fs.readFile(DIALOG_PANE_FIXTURE, 'utf-8') })
    const result = await writeTextToTmuxSession('orchestrator', '1', { submit: true })
    expect(result).toEqual({ status: 'refused', reason: 'dialog-open' })
    expect(tmux.writeCalls()).toEqual([])
  })

  it.each([
    ['an ESC (could close the bracketed paste early)', 'x\u001b[201~\rrm -rf ~'],
    ['a bare CR', 'x\ry'],
    ['a NUL', 'x\u0000y'],
    ['a Ctrl-C', 'x\u0003'],
    ['a DEL', 'x\u007f'],
  ])('refuses text containing %s without calling tmux', async (_label, text) => {
    tmux.addSession('orchestrator')
    const result = await writeTextToTmuxSession('orchestrator', text, { submit: true })
    expect(result).toEqual({ status: 'refused', reason: 'unsafe-text' })
    expect(tmux.calls).toEqual([])
  })
})

describe('writeTextToTmuxSession — every refusal is logged', () => {
  const DIALOG_FIRST = async () => ({ screen: await fs.readFile(DIALOG_PANE_FIXTURE, 'utf-8') })

  it.each([
    ['dialog-open', async () => { tmux.addSession('orchestrator', await DIALOG_FIRST()) }, 'x'],
    ['pane-in-mode', async () => { tmux.addSession('orchestrator', { inMode: true }) }, 'x'],
    ['no-bracketed-paste', async () => { tmux.addSession('orchestrator', { bracketedPaste: false }) }, 'x'],
    ['unsafe-text', async () => { tmux.addSession('orchestrator') }, 'x\u001by'],
  ])('logs a %s refusal with the writer tag, so the server log is the signal', async (reason, setup, text) => {
    await setup()
    const result = await writeTextToTmuxSession('orchestrator', text, { submit: true })
    expect(result).toEqual({ status: 'refused', reason })
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`[tmuxPaneWrite] refused to write to orchestrator: ${reason}`))
  })

  it('logs an unsafe session name refusal', async () => {
    const result = await writeTextToTmuxSession("orch'; rm", 'x', { submit: true })
    expect(result).toEqual({ status: 'refused', reason: 'unsafe-session-name' })
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('unsafe-session-name'))
  })
})

describe('writeTextToTmuxSession — failures are observable', () => {
  it('a failed lookup is a logged failure, nothing typed', async () => {
    tmux.addSession('orchestrator')
    tmux.failOn = { sub: 'display-message', error: new Error('server exited unexpectedly') }
    const result = await writeTextToTmuxSession('orchestrator', 'x', { submit: true })
    expect(result).toMatchObject({ status: 'failed', step: 'resolve' })
    expect(tmux.writeCalls()).toEqual([])
    expect(console.error).toHaveBeenCalled()
  })

  it('a failed paste never goes on to press Enter, and is logged', async () => {
    tmux.addSession('orchestrator')
    tmux.failOn = { sub: 'paste-buffer', error: new Error("can't find pane: %7") }
    const result = await writeTextToTmuxSession('orchestrator', 'x', { submit: true })
    expect(result).toMatchObject({ status: 'failed', step: 'paste' })
    expect(tmux.deliveredTo('orchestrator')).toEqual([])
    expect(tmux.calls.some((c) => c.args[0] === 'send-keys')).toBe(false)
    expect(console.error).toHaveBeenCalled()
  })

  it('a failed paste deletes its named buffer itself (tmux keeps it when paste-buffer -d fails)', async () => {
    tmux.addSession('orchestrator')
    tmux.failOn = { sub: 'paste-buffer', error: new Error("can't find pane: %7") }
    await writeTextToTmuxSession('orchestrator', 'secret-ish command text', { submit: false })
    expect(tmux.calls.some((c) => c.args[0] === 'delete-buffer')).toBe(true)
    expect(tmux.buffers.size).toBe(0)
  })

  it('a failed Enter after a landed paste says so (staged, not sent) — distinct from a failed paste', async () => {
    tmux.addSession('orchestrator')
    tmux.failOn = { sub: 'send-keys', error: new Error('timed out') }
    const result = await writeTextToTmuxSession('orchestrator', 'x', { submit: true })
    expect(result).toMatchObject({ status: 'failed', step: 'submit' })
    expect(tmux.deliveredTo('orchestrator')).toEqual([{ kind: 'paste', text: 'x', bracketed: true }])
    expect(console.error).toHaveBeenCalled()
  })

  it('a dialog that opens between the paste and the Enter is not answered: Enter is withheld and it says so', async () => {
    const dialog = await fs.readFile(DIALOG_PANE_FIXTURE, 'utf-8')
    tmux.addSession('orchestrator')
    tmux.afterPaste = (pane) => { pane.screen = dialog }
    const result = await writeTextToTmuxSession('orchestrator', '/pipelinely-qa x', { submit: true })
    expect(result).toMatchObject({ status: 'failed', step: 'submit' })
    expect(tmux.deliveredTo('orchestrator')).toEqual([{ kind: 'paste', text: '/pipelinely-qa x', bracketed: true }])
    expect(console.error).toHaveBeenCalled()
  })

  it('a failed dialog re-check before Enter says Enter was definitely not pressed, not "may or may not"', async () => {
    tmux.addSession('orchestrator')
    tmux.afterPaste = () => { tmux.failOn = { sub: 'capture-pane', error: new Error('timed out') } }
    const result = await writeTextToTmuxSession('orchestrator', '/pipelinely-qa x', { submit: true })
    expect(result).toMatchObject({ status: 'failed', step: 'submit' })
    expect(tmux.deliveredTo('orchestrator')).toEqual([{ kind: 'paste', text: '/pipelinely-qa x', bracketed: true }])
    const logged = vi.mocked(console.error).mock.calls.map((call) => String(call[0])).join('\n')
    expect(logged).toContain('staged, not sent')
    expect(logged).not.toContain('may or may not')
  })

  it('a failed dialog capture fails closed: nothing typed', async () => {
    tmux.addSession('orchestrator')
    tmux.failOn = { sub: 'capture-pane', error: new Error('timed out') }
    const result = await writeTextToTmuxSession('orchestrator', 'x', { submit: true })
    expect(result).toMatchObject({ status: 'failed', step: 'capture' })
    expect(tmux.writeCalls()).toEqual([])
  })
})

describe('the rollout flag is gone', () => {
  it('does not export isTmuxDispatchWritesEnabled', async () => {
    const tmuxPaneWrite = await import('./tmuxPaneWrite.js')
    expect(Object.keys(tmuxPaneWrite)).not.toContain('isTmuxDispatchWritesEnabled')
  })
})
