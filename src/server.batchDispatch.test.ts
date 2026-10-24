import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'

// Proves the safety property this whole task exists for, at the one point
// it can be proved by npx vitest run alone: POST /batch-dispatch writes with
// writeTextToTmuxSession({submit:false}) on every case — a batch is only
// ever staged, never sent — and writes nothing on the failure paths. See
// tech-design.md's "What is actually runnable" for why this, plus the tmux
// writer's own unit coverage, is the full chain: no real tmux needed to know
// no batch path can ever press Return.
//
// Harness copied from server.orchestratorLock.test.ts: mocks only the
// tmux/osascript-touching functions, exercising the real Express route
// handlers.

const ORCHESTRATOR_TMUX_NAME = 'orchestrator'

vi.mock('./tmuxPaneWrite.js', () => ({
  writeTextToTmuxSession: vi.fn(async (_session: string, _text: string, _options: { submit: boolean }) => ({ status: 'ok', paneId: '%7' })),
}))

vi.mock('./focusTab.js', () => ({
  focusITermTab: vi.fn(async () => undefined),
  tmuxSessionExists: vi.fn(async () => false),
  findSessionAttachedToTmux: vi.fn(async () => null),
  reattachAndRecord: vi.fn(async () => null),
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

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-batch-dispatch-test-'))
  process.env.TASKS_DIR = tmpDir
  // This suite is about writeToOrchestrator's own lock/stray-shell
  // handling, not canonical-instance gating (that's server.canonicalGate.test.ts's
  // job) — so it runs as the canonical instance throughout.
  process.env.COCKPIT_DISPATCH_ENABLED = '1'
  ORCHESTRATOR_TMUX_PATH = path.join(tmpDir, 'ORCHESTRATOR_TMUX')
  const { app } = await import('./server.js')
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a network address')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
  await fs.rm(tmpDir, { recursive: true, force: true })
  delete process.env.COCKPIT_DISPATCH_ENABLED
})

beforeEach(async () => {
  const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
  vi.mocked(writeTextToTmuxSession).mockClear()
  await fs.writeFile(ORCHESTRATOR_TMUX_PATH, ORCHESTRATOR_TMUX_NAME)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

async function tmuxWriteCalls() {
  const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
  return vi.mocked(writeTextToTmuxSession).mock.calls
}

function postBatch(body: unknown) {
  return fetch(`${baseUrl}/batch-dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /batch-dispatch', () => {
  it('stages a 3-milestone wave batch: 200, one unsent write, all 3 slugs in the text', async () => {
    const res = await postBatch({ kind: 'wave', slugs: ['parent-m1', 'parent-m2', 'parent-m3'] })
    expect(res.status).toBe(200)
    const calls = await tmuxWriteCalls()
    expect(calls).toHaveLength(1)
    const [session, text, options] = calls[0]
    expect(session).toBe(ORCHESTRATOR_TMUX_NAME)
    expect(options).toEqual({ submit: false })
    expect(text).toContain('/pipelinely-dev parent-m1')
    expect(text).toContain('/pipelinely-dev parent-m2')
    expect(text).toContain('/pipelinely-dev parent-m3')
  })

  it('stages a 3-item backlog batch: 200, one unsent write, all 3 descriptions in the text', async () => {
    const res = await postBatch({
      kind: 'backlog',
      items: [{ description: 'Item A' }, { description: 'Item B' }, { description: 'Item C' }],
    })
    expect(res.status).toBe(200)
    const calls = await tmuxWriteCalls()
    expect(calls).toHaveLength(1)
    const [, text, options] = calls[0]
    expect(options).toEqual({ submit: false })
    expect(text).toContain('Item A')
    expect(text).toContain('Item B')
    expect(text).toContain('Item C')
  })

  it('two batches back-to-back: two writes, both unsent — the concatenation stays unsent', async () => {
    const resA = await postBatch({ kind: 'wave', slugs: ['parent-m1'] })
    const resB = await postBatch({ kind: 'backlog', items: [{ description: 'Item A' }] })
    expect(resA.status).toBe(200)
    expect(resB.status).toBe(200)
    const calls = await tmuxWriteCalls()
    expect(calls).toHaveLength(2)
    expect(calls.map((call) => call[2])).toEqual([{ submit: false }, { submit: false }])
  })

  it('503s with no orchestrator tmux session recorded, and types nothing', async () => {
    await fs.rm(ORCHESTRATOR_TMUX_PATH, { force: true })
    const res = await postBatch({ kind: 'wave', slugs: ['parent-m1'] })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toBeTruthy()
    expect(await tmuxWriteCalls()).toEqual([])
  })

  it('503s when the tmux pane is a stray shell', async () => {
    const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
    vi.mocked(writeTextToTmuxSession).mockResolvedValueOnce({ status: 'refused', reason: 'stray-shell' })

    const res = await postBatch({ kind: 'wave', slugs: ['parent-m1'] })
    expect(res.status).toBe(503)
  })

  it('400s and writes nothing for a malformed body', async () => {
    const res = await postBatch({ kind: 'bogus' })
    expect(res.status).toBe(400)
    expect(await tmuxWriteCalls()).toEqual([])
  })

  it('400s and writes nothing for an empty batch', async () => {
    const res = await postBatch({ kind: 'wave', slugs: [] })
    expect(res.status).toBe(400)
    expect(await tmuxWriteCalls()).toEqual([])
  })

  it('400s and writes nothing for a slug failing SAFE_TOKEN', async () => {
    const res = await postBatch({ kind: 'wave', slugs: ['not a valid slug'] })
    expect(res.status).toBe(400)
    expect(await tmuxWriteCalls()).toEqual([])
  })

  it('404s POST /pipelinely-dev/:slug — the auto-submit route is gone', async () => {
    const res = await fetch(`${baseUrl}/pipelinely-dev/some-milestone`, { method: 'POST' })
    expect(res.status).toBe(404)
  })
})
