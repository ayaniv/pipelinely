import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import { rawHttpRequest } from './testNetwork.js'

// POST /answer-dialog/:slug proven at the production wiring level. No case can
// reach a real terminal multiplexer: execa is mocked wholesale (the poll's
// capture-pane goes through it), and the two focusTab functions that write or
// pin a pane are mocks that record their calls.

const SESSION = 'worker-answer-demo'
const SLUG = 'answer-demo'
const OTHER_SLUG = 'answer-quiet'
// A done task whose leftover review session only the shorter active slug's prefix would match.
const SHORT_SLUG = 'answer-own'
const FINISHED_SLUG = 'answer-own-bar'
const FINISHED_REVIEW_SESSION = `worker-${FINISHED_SLUG}-cr`
const PANE_ID = '%7'
const TOKEN = 'answer-dialog-token-0123456789abcdefghijklmnopqrstu'

const DIALOG_PANE = [
  'some earlier output',
  '─'.repeat(40),
  ' Bash command',
  '',
  '   npm test',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and don\'t ask again',
  '   3. No',
  '',
  ' Esc to cancel',
].join('\n')
const QUIET_PANE = '❯ \n  ? for shortcuts'

const state = vi.hoisted(() => ({
  paneText: '',
  liveSessions: new Set<string>(),
  sendKeysCalls: [] as { paneId: string; keys: readonly string[] }[],
  resolvePaneCalls: [] as string[],
  execaCalls: [] as string[][],
  clearDialogOnSend: true,
  // While true, the poll's captures (session targets, `=name:`) never settle, so
  // the prompts it last published stay put; the route's own `%N` captures are unaffected.
  isPollHeld: false,
  heldPollCaptures: [] as (() => void)[],
}))

vi.mock('execa', () => ({
  execa: vi.fn(async (command: string, args: string[]) => {
    state.execaCalls.push([command, ...args])
    if (command === 'tmux' && args[0] === 'capture-pane') {
      const target = args[args.indexOf('-t') + 1]
      if (state.isPollHeld && target.startsWith('=')) {
        await new Promise<void>((resolve) => state.heldPollCaptures.push(resolve))
      }
      return { stdout: state.paneText }
    }
    throw new Error(`unexpected process in the answer-dialog test: ${command} ${args.join(' ')}`)
  }),
}))

vi.mock('./focusTab.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./focusTab.js')>()),
  sendKeysToPane: vi.fn(async (paneId: string, keys: readonly string[]) => {
    state.sendKeysCalls.push({ paneId, keys })
    if (state.clearDialogOnSend) state.paneText = QUIET_PANE
  }),
  resolveActivePaneId: vi.fn(async (session: string) => {
    state.resolvePaneCalls.push(session)
    return PANE_ID
  }),
  getLiveTmuxSessions: vi.fn(async () => state.liveSessions),
  getLiveSessionIds: vi.fn(async () => null),
  getSessionTty: vi.fn(async () => null),
  tmuxSessionExists: vi.fn(async () => false),
  tmuxPaneIsStrayShell: vi.fn(async () => false),
  sessionIsClientOf: vi.fn(async () => false),
  findSessionAttachedToTmux: vi.fn(async () => null),
  reattachAndRecord: vi.fn(async () => null),
  reattachTmuxSession: vi.fn(async () => null),
  reattachOrFocus: vi.fn(async () => 'none' as const),
  pasteIntoSession: vi.fn(async () => true),
  pasteIntoSessionQuiet: vi.fn(async () => true),
  stageInSession: vi.fn(async () => true),
  focusITermTab: vi.fn(async () => false),
}))

interface TaskView {
  slug: string
  approvalPrompt?: { session: string; fingerprint: string; options: { number: number }[] } | null
}

let tmpDir: string
let baseUrl: string
let port: number
let server: Server
let REMOTE_SESSION_COOKIE: string
let dialogPaneFingerprint: string

async function fetchTasks(): Promise<TaskView[]> {
  const res = await fetch(`${baseUrl}/api/tasks`)
  return ((await res.json()) as { tasks: TaskView[] }).tasks
}

async function waitFor<T>(read: () => Promise<T | null | undefined | false>, what: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${what}`)
}

// Waits for DIALOG_PANE's own fingerprint, not just any prompt: a case that
// changed the pane leaves its dialog published until the next poll tick.
const waitForPrompt = () => waitFor(async () => {
  const prompt = (await fetchTasks()).find((task) => task.slug === SLUG)?.approvalPrompt
  return prompt?.fingerprint === dialogPaneFingerprint ? prompt : null
}, 'the published approval prompt')

function releaseHeldPoll(): void {
  state.isPollHeld = false
  for (const release of state.heldPollCaptures.splice(0)) release()
}

async function writeTask(slug: string, files: Record<string, string>): Promise<void> {
  await fs.mkdir(path.join(tmpDir, slug), { recursive: true })
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(tmpDir, slug, name), content)
}

async function readAuditLines(): Promise<Record<string, unknown>[]> {
  try {
    const text = await fs.readFile(path.join(tmpDir, SLUG, 'DIALOG_ANSWERS.jsonl'), 'utf-8')
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

function postAnswer(slug: string, body: unknown, headers: Record<string, string> = {}, contentType = 'application/json') {
  return fetch(`${baseUrl}/answer-dialog/${slug}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeAll(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-answer-dialog-test-')))
  process.env.TASKS_DIR = tmpDir
  process.env.COCKPIT_APPROVAL_POLL_MS = '40'
  process.env.PIPELINELY_REMOTE_TOKEN_FILE = path.join(tmpDir, 'config', 'remote-token')
  state.liveSessions = new Set([SESSION])
  state.paneText = DIALOG_PANE
  REMOTE_SESSION_COOKIE = (await import('./remoteAuth.js')).REMOTE_SESSION_COOKIE
  const { readSessionDialog } = await import('./approvalWatch.js')
  dialogPaneFingerprint = (await readSessionDialog(`=${SESSION}:`, SESSION, { capturePane: async () => DIALOG_PANE }))!.fingerprint

  const { app } = await import('./server.js')
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a network address')
  port = address.port
  baseUrl = `http://localhost:${port}`
  // The chokidar watcher needs a moment to finish its initial scan before it reports new files.
  await new Promise((resolve) => setTimeout(resolve, 300))
  await writeTask(SLUG, { STATUS: 'working\n', TMUX_SESSION: SESSION })
  await writeTask(OTHER_SLUG, { STATUS: 'working\n' })
  await waitForPrompt()
}, 30_000)

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  await fs.rm(tmpDir, { recursive: true, force: true })
  delete process.env.COCKPIT_APPROVAL_POLL_MS
  delete process.env.PIPELINELY_REMOTE_TOKEN_FILE
  delete process.env.COCKPIT_DISPATCH_ENABLED
})

beforeEach(async () => {
  state.sendKeysCalls.length = 0
  state.resolvePaneCalls.length = 0
  state.clearDialogOnSend = true
  state.paneText = DIALOG_PANE
  state.liveSessions = new Set([SESSION])
  await fs.rm(path.join(tmpDir, SLUG, 'DIALOG_ANSWERS.jsonl'), { force: true })
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  await waitForPrompt()
})

afterEach(() => {
  delete process.env.COCKPIT_DISPATCH_ENABLED
  vi.restoreAllMocks()
})

describe('canonical instance', () => {
  beforeEach(() => {
    process.env.COCKPIT_DISPATCH_ENABLED = '1'
  })

  it('answers the dialog the card shows: one key sent to the pinned pane, two audit lines, 200', async () => {
    const prompt = (await waitForPrompt())!
    const res = await postAnswer(SLUG, { session: prompt.session, option: 2, fingerprint: prompt.fingerprint })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: 'answered' })
    expect(state.sendKeysCalls).toEqual([{ paneId: PANE_ID, keys: ['-l', '2'] }])
    const audit = await readAuditLines()
    expect(audit.map((entry) => entry.phase)).toEqual(['attempt', 'result'])
    expect(audit[0]).toMatchObject({ slug: SLUG, session: SESSION, choice: 2, keys: ['-l', '2'], fingerprint: prompt.fingerprint })
    expect(audit[1]).toMatchObject({ outcome: 'answered' })
  })

  it('sends Escape for cancel', async () => {
    const prompt = (await waitForPrompt())!
    const res = await postAnswer(SLUG, { session: prompt.session, option: 'cancel', fingerprint: prompt.fingerprint })
    expect(res.status).toBe(200)
    expect(state.sendKeysCalls).toEqual([{ paneId: PANE_ID, keys: ['Escape'] }])
  })

  it('reports 202 unconfirmed when the dialog is still showing after the key', async () => {
    state.clearDialogOnSend = false
    const prompt = (await waitForPrompt())!
    const res = await postAnswer(SLUG, { session: prompt.session, option: 1, fingerprint: prompt.fingerprint })
    expect(res.status).toBe(202)
    expect((await res.json()).outcome).toBe('unconfirmed')
    expect(state.sendKeysCalls).toHaveLength(1)
  })

  it('refuses a well-formed fingerprint that is not the one the card shows, with 409 dialog-changed and no tmux call', async () => {
    const prompt = (await waitForPrompt())!
    const res = await postAnswer(SLUG, { session: prompt.session, option: 1, fingerprint: '0123456789abcdef' })
    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe('dialog-changed')
    expect(state.sendKeysCalls).toEqual([])
    expect(state.resolvePaneCalls).toEqual([])
    expect(await readAuditLines()).toEqual([])
  })

  it('refuses when the pane changed after the card was drawn, and leaves the worker alone', async () => {
    const prompt = (await waitForPrompt())!
    state.paneText = DIALOG_PANE.replace('npm test', 'rm -rf build')
    const res = await postAnswer(SLUG, { session: prompt.session, option: 1, fingerprint: prompt.fingerprint })
    expect(res.status).toBe(409)
    expect(['dialog-changed', 'no-dialog']).toContain((await res.json()).reason)
    expect(state.sendKeysCalls).toEqual([])
  })

  it('answers a quick double click once: the second click is refused with 409 and sends no second key', async () => {
    const prompt = (await waitForPrompt())!
    const body = { session: prompt.session, option: 1, fingerprint: prompt.fingerprint }
    const first = await postAnswer(SLUG, body)
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ outcome: 'answered' })
    const second = await postAnswer(SLUG, body)
    expect(second.status).toBe(409)
    expect((await second.json()).reason).toBe('no-dialog')
    expect(state.sendKeysCalls).toEqual([{ paneId: PANE_ID, keys: ['-l', '1'] }])
  })

  it('refuses a task that has no published dialog with 409 no-dialog, before pinning any pane', async () => {
    const prompt = (await waitForPrompt())!
    const res = await postAnswer(OTHER_SLUG, { session: prompt.session, option: 1, fingerprint: prompt.fingerprint })
    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe('no-dialog')
    expect(state.resolvePaneCalls).toEqual([])
    expect(state.sendKeysCalls).toEqual([])
  })

  describe("a published prompt on a session the task no longer owns", () => {
    afterEach(async () => {
      releaseHeldPoll()
      await fs.rm(path.join(tmpDir, SHORT_SLUG), { recursive: true, force: true })
      await fs.rm(path.join(tmpDir, FINISHED_SLUG), { recursive: true, force: true })
    })

    it("refuses a done task's leftover review session with 400 session-not-owned, before pinning any pane", async () => {
      state.liveSessions = new Set([SESSION, FINISHED_REVIEW_SESSION])
      await writeTask(SHORT_SLUG, { STATUS: 'working\n' })
      const stale = await waitFor(
        async () => (await fetchTasks()).find((task) => task.slug === SHORT_SLUG)?.approvalPrompt,
        'the shorter slug to be shown the review session\'s dialog',
      )
      expect(stale.session).toBe(FINISHED_REVIEW_SESSION)

      // The poll can't correct the card before the click lands: exactly the window a real click races.
      state.isPollHeld = true
      await writeTask(FINISHED_SLUG, { STATUS: 'done\n' })
      await waitFor(async () => (await fetchTasks()).some((task) => task.slug === FINISHED_SLUG), 'the finished task to load')
      expect((await fetchTasks()).find((task) => task.slug === SHORT_SLUG)?.approvalPrompt?.fingerprint).toBe(stale.fingerprint)

      const res = await postAnswer(SHORT_SLUG, { session: FINISHED_REVIEW_SESSION, option: 1, fingerprint: stale.fingerprint })
      expect(res.status).toBe(400)
      expect((await res.json()).reason).toBe('session-not-owned')
      expect(state.resolvePaneCalls).toEqual([])
      expect(state.sendKeysCalls).toEqual([])
    })
  })

  it('refuses the orchestrator\'s own tmux session even when the task claims it', async () => {
    await fs.writeFile(path.join(tmpDir, 'ORCHESTRATOR_TMUX'), `${SESSION}\n`)
    try {
      const prompt = (await waitForPrompt())!
      const res = await postAnswer(SLUG, { session: prompt.session, option: 1, fingerprint: prompt.fingerprint })
      expect(res.status).toBe(400)
      expect((await res.json()).reason).toBe('session-not-owned')
      expect(state.sendKeysCalls).toEqual([])
    } finally {
      await fs.rm(path.join(tmpDir, 'ORCHESTRATOR_TMUX'), { force: true })
    }
  })

  it('answers 404 for an unknown task', async () => {
    const res = await postAnswer('no-such-task', { session: SESSION, option: 1, fingerprint: '0123456789abcdef' })
    expect(res.status).toBe(404)
    expect((await res.json()).reason).toBe('unknown-task')
  })

  it.each([
    ['a missing fingerprint', { session: SESSION, option: 1 }],
    ['a malformed fingerprint', { session: SESSION, option: 1, fingerprint: 'NOT-HEX' }],
    ['an option outside 1-9', { session: SESSION, option: 10, fingerprint: '0123456789abcdef' }],
    ['a non-integer option', { session: SESSION, option: 1.5, fingerprint: '0123456789abcdef' }],
    ['key text instead of an option', { session: SESSION, option: 'Enter', fingerprint: '0123456789abcdef' }],
    ['an unsafe session name', { session: 'worker; rm -rf /', option: 1, fingerprint: '0123456789abcdef' }],
    ['no body', {}],
  ])('answers 400 bad-request for %s and sends nothing', async (_label, body) => {
    const res = await postAnswer(SLUG, body)
    expect(res.status).toBe(400)
    expect((await res.json()).reason).toBe('bad-request')
    expect(state.sendKeysCalls).toEqual([])
  })

  it('refuses 415 for a text/plain body, the cross-site "simple" POST', async () => {
    const prompt = (await waitForPrompt())!
    const res = await postAnswer(SLUG, JSON.stringify({ session: prompt.session, option: 1, fingerprint: prompt.fingerprint }), {}, 'text/plain')
    expect(res.status).toBe(415)
    expect(state.sendKeysCalls).toEqual([])
  })

  it('refuses a cross-site Origin with 403 cross-site', async () => {
    const prompt = (await waitForPrompt())!
    const res = await postAnswer(SLUG, { session: prompt.session, option: 1, fingerprint: prompt.fingerprint }, { Origin: 'http://evil.example' })
    expect(res.status).toBe(403)
    expect((await res.json()).reason).toBe('cross-site')
    expect(state.sendKeysCalls).toEqual([])
  })

  it('refuses a rebound Host with 403 bad-host', async () => {
    // fetch cannot override Host, so this goes out as a raw request.
    const res = await rawHttpRequest(port, 'POST', `/answer-dialog/${SLUG}`, { Host: `evil.example:${port}`, 'Content-Type': 'application/json' })
    expect(res.status).toBe(403)
    expect(JSON.parse(res.body).reason).toBe('bad-host')
    expect(state.sendKeysCalls).toEqual([])
  })

  it('refuses a signed-in request that came through a proxy, with 403 remote', async () => {
    await fs.mkdir(path.join(tmpDir, 'config'), { recursive: true })
    await fs.writeFile(process.env.PIPELINELY_REMOTE_TOKEN_FILE!, TOKEN)
    try {
      const prompt = (await waitForPrompt())!
      const res = await postAnswer(
        SLUG,
        { session: prompt.session, option: 1, fingerprint: prompt.fingerprint },
        { 'X-Forwarded-For': '100.64.1.2', Cookie: `${REMOTE_SESSION_COOKIE}=${TOKEN}` },
      )
      expect(res.status).toBe(403)
      expect((await res.json()).reason).toBe('remote')
      expect(state.sendKeysCalls).toEqual([])
    } finally {
      await fs.rm(process.env.PIPELINELY_REMOTE_TOKEN_FILE!, { force: true })
    }
  })
})

describe('non-canonical instance', () => {
  it('refuses 403 not-canonical before any tmux call, even for a valid request', async () => {
    const prompt = (await waitForPrompt())!
    const resolveCallsBefore = state.resolvePaneCalls.length
    const res = await postAnswer(SLUG, { session: prompt.session, option: 1, fingerprint: prompt.fingerprint })
    expect(res.status).toBe(403)
    expect((await res.json()).reason).toBe('not-canonical')
    expect(state.sendKeysCalls).toEqual([])
    expect(state.resolvePaneCalls).toHaveLength(resolveCallsBefore)
    expect(await readAuditLines()).toEqual([])
  })
})

describe('S1: only an explicit click', () => {
  it('a GET never answers and sends nothing', async () => {
    process.env.COCKPIT_DISPATCH_ENABLED = '1'
    const res = await fetch(`${baseUrl}/answer-dialog/${SLUG}`)
    expect(res.status).not.toBe(200)
    expect(res.headers.get('content-type') ?? '').not.toContain('application/json')
    expect(state.sendKeysCalls).toEqual([])
  })

  it('auto mode and a handoff on a blocked task do not press any key', async () => {
    process.env.COCKPIT_DISPATCH_ENABLED = '1'
    await fs.writeFile(path.join(tmpDir, 'SETTINGS.json'), JSON.stringify({ autoMode: true }))
    try {
      await waitFor(async () => (await (await fetch(`${baseUrl}/api/tasks`)).json()).settings.autoMode === true, 'auto mode to load')
      await fs.writeFile(path.join(tmpDir, SLUG, 'STATUS'), 'waiting: PR open, ready for CR\n')
      await waitFor(async () => (await fetchTasks()).some((task) => task.slug === SLUG), 'the refresh after the handoff')
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(state.sendKeysCalls).toEqual([])
      expect(state.resolvePaneCalls).toEqual([])
    } finally {
      await fs.writeFile(path.join(tmpDir, 'SETTINGS.json'), JSON.stringify({ autoMode: false }))
      await fs.writeFile(path.join(tmpDir, SLUG, 'STATUS'), 'working\n')
    }
  })
})
