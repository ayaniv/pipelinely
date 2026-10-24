import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'

// Regression coverage for TASK.md's canonical-dispatch-gate fix: any process
// running src/server.ts — a worktree's own local preview, an e2e webServer —
// used to default to the exact same real TASKS_DIR/ORCHESTRATOR_SESSION as
// the one real dashboard, with nothing stopping it from pasting real text
// and pressing Enter into the developer's live orchestrator terminal. This
// suite exercises the production route handlers directly (mocking only the
// tmux-writing and osascript-touching functions, never route logic) to
// prove writeToOrchestrator now refuses every write unless
// COCKPIT_DISPATCH_ENABLED=1 — the signal only the pipelinely skill's
// own dev-server launch step sets — covering the routes TASK.md names (POST
// /backlog/dispatch, POST /focus/:slug's dead-session fallback) plus POST
// /batch-dispatch (which replaced the since-deleted POST /pipelinely-dev/:slug
// as the wave-batch dispatch path — see batchDispatch.ts) and POST
// /stage-skill/:slug's orchestrator-target branch, proving the guard living
// inside writeToOrchestrator itself really does cover every caller, not just
// the ones that motivated it.

const ORCHESTRATOR_TMUX_NAME = 'orchestrator'

vi.mock('./tmuxPaneWrite.js', () => ({
  writeTextToTmuxSession: vi.fn(async (_session: string, _text: string, _options: { submit: boolean }) => ({ status: 'ok', paneId: '%7' })),
}))

vi.mock('./focusTab.js', () => ({
  focusITermTab: vi.fn(async () => undefined),
  tmuxSessionExists: vi.fn(async () => false),
  findSessionAttachedToTmux: vi.fn(async () => null),
  reattachAndRecord: vi.fn(async () => null),
  // parseAllTasks (taskParser.ts) calls these to mark each task's own
  // session live/dead — not exercised by this suite's fixture task, which
  // deliberately has no ITERM_SESSION/TMUX_SESSION recorded.
  getLiveSessionIds: vi.fn(async () => null),
  getLiveTmuxSessions: vi.fn(async () => null),
  // 'none' — neither the task's iTerm session nor its tmux session is
  // alive — is exactly the outcome that sends POST /focus/:slug down its
  // writeToOrchestrator fallback path (see server.ts's own comment there).
  reattachOrFocus: vi.fn(async () => 'none' as const),
  openVSCode: vi.fn(async () => undefined),
  openBrowserUrl: vi.fn(async () => undefined),
  openAnnotationSession: vi.fn(async () => ({ status: 'error' as const, error: 'not exercised in this suite' })),
  normalizeWhitespace: (value: string) => value.replace(/\s+/g, ' ').trim(),
}))

let tmpDir: string
let baseUrl: string
let server: Server
let ORCHESTRATOR_TMUX_PATH: string

// The dead-tmux-session fixture task /focus/:slug's fallback needs. Only
// picked up by currentTasks once chokidar's watcher fires off its STATUS
// write below — server.ts never runs main()'s initial refreshTasks() under
// VITEST — so callers poll /api/tasks rather than assuming it's immediate.
const DEAD_SESSION_SLUG = 'canonical-gate-dead-session'

async function waitForTaskVisible(slug: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/api/tasks`)
    const { tasks } = (await res.json()) as { tasks: { slug: string }[] }
    if (tasks.some((t) => t.slug === slug)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`task ${slug} never appeared in currentTasks — chokidar refresh timed out`)
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-canonical-gate-test-'))
  process.env.TASKS_DIR = tmpDir
  ORCHESTRATOR_TMUX_PATH = path.join(tmpDir, 'ORCHESTRATOR_TMUX')
  const { app } = await import('./server.js')
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a network address')
  baseUrl = `http://127.0.0.1:${address.port}`

  // The chokidar watcher (constructed at module import time, above) needs a
  // moment to finish its initial scan before it reliably reports new files
  // — writing the fixture immediately after import can race that scan and
  // silently miss the 'add' event it depends on.
  await new Promise((resolve) => setTimeout(resolve, 300))
  await fs.mkdir(path.join(tmpDir, DEAD_SESSION_SLUG), { recursive: true })
  await fs.writeFile(path.join(tmpDir, DEAD_SESSION_SLUG, 'STATUS'), 'working\n')
  await waitForTaskVisible(DEAD_SESSION_SLUG)
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
  await fs.rm(tmpDir, { recursive: true, force: true })
})

beforeEach(async () => {
  const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
  vi.mocked(writeTextToTmuxSession).mockClear()
  await fs.writeFile(ORCHESTRATOR_TMUX_PATH, ORCHESTRATOR_TMUX_NAME)
})

async function tmuxWriteCalls() {
  const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
  return vi.mocked(writeTextToTmuxSession).mock.calls
}

afterEach(() => {
  delete process.env.COCKPIT_DISPATCH_ENABLED
})

describe('canonical instance (COCKPIT_DISPATCH_ENABLED=1)', () => {
  beforeEach(() => {
    process.env.COCKPIT_DISPATCH_ENABLED = '1'
  })

  it('POST /backlog/dispatch succeeds and sends into the orchestrator tmux session', async () => {
    const res = await fetch(`${baseUrl}/backlog/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'canonical item', context: null }),
    })
    expect(res.status).toBe(200)
    expect(await tmuxWriteCalls()).toEqual([[ORCHESTRATOR_TMUX_NAME, "Let's do this backlog item: canonical item", { submit: true }]])
  })

  it('POST /batch-dispatch succeeds and stages into the orchestrator tmux session', async () => {
    const res = await fetch(`${baseUrl}/batch-dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'wave', slugs: ['some-milestone-m1'] }),
    })
    expect(res.status).toBe(200)
    const calls = await tmuxWriteCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe(ORCHESTRATOR_TMUX_NAME)
    expect(calls[0][2]).toEqual({ submit: false })
  })

  it("POST /focus/:slug's dead-session fallback succeeds and sends the resume message", async () => {
    const res = await fetch(`${baseUrl}/focus/${DEAD_SESSION_SLUG}`, { method: 'POST' })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ fallback: true })
    const calls = await tmuxWriteCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe(ORCHESTRATOR_TMUX_NAME)
    expect(calls[0][1]).toContain(DEAD_SESSION_SLUG)
    expect(calls[0][2]).toEqual({ submit: true })
  })

  it('POST /stage-skill/:slug (an orchestrator-target stage) succeeds and stages into the orchestrator tmux session', async () => {
    const res = await fetch(`${baseUrl}/stage-skill/some-milestone-m1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'dev' }),
    })
    expect(res.status).toBe(200)
    const calls = await tmuxWriteCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe(ORCHESTRATOR_TMUX_NAME)
    expect(calls[0][2]).toEqual({ submit: false })
  })
})

describe('non-canonical instance (COCKPIT_DISPATCH_ENABLED unset)', () => {
  it('POST /backlog/dispatch is rejected with 403 and types nothing', async () => {
    const res = await fetch(`${baseUrl}/backlog/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'non-canonical item', context: null }),
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: expect.stringContaining('not the canonical orchestrator dashboard') })
    expect(await tmuxWriteCalls()).toEqual([])
  })

  it('POST /batch-dispatch is rejected with 403 and types nothing', async () => {
    const res = await fetch(`${baseUrl}/batch-dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'wave', slugs: ['some-milestone-m1'] }),
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: expect.stringContaining('not the canonical orchestrator dashboard') })
    expect(await tmuxWriteCalls()).toEqual([])
  })

  it("POST /focus/:slug's dead-session fallback is rejected with 403 and types nothing", async () => {
    const res = await fetch(`${baseUrl}/focus/${DEAD_SESSION_SLUG}`, { method: 'POST' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: expect.stringContaining('not the canonical orchestrator dashboard') })
    expect(await tmuxWriteCalls()).toEqual([])
  })

  it('POST /stage-skill/:slug (an orchestrator-target stage) is rejected with 403 and types nothing', async () => {
    const res = await fetch(`${baseUrl}/stage-skill/some-milestone-m1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'dev' }),
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: expect.stringContaining('not the canonical orchestrator dashboard') })
    expect(await tmuxWriteCalls()).toEqual([])
  })
})

describe('GET /api/tasks — isCanonical field', () => {
  it('reports true when COCKPIT_DISPATCH_ENABLED=1', async () => {
    process.env.COCKPIT_DISPATCH_ENABLED = '1'
    const res = await fetch(`${baseUrl}/api/tasks`)
    expect((await res.json()).isCanonical).toBe(true)
  })

  it('reports false when COCKPIT_DISPATCH_ENABLED is unset', async () => {
    delete process.env.COCKPIT_DISPATCH_ENABLED
    const res = await fetch(`${baseUrl}/api/tasks`)
    expect((await res.json()).isCanonical).toBe(false)
  })
})
