import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'

// Proves the safety property this whole task exists for, at the one point
// it can be proved by npx vitest run alone: POST /batch-dispatch writes with
// stageInSession — never pasteIntoSession — on every case, including the
// failure paths. See tech-design.md's "What is actually runnable" for why
// this, plus stageInSession's own submit:false and buildSessionWriteScript's
// existing unit coverage, is the full chain: no VM/real-osascript needed to
// know no batch path can ever press Return.
//
// Harness copied from server.orchestratorLock.test.ts: mocks only the
// osascript/tmux-touching functions in focusTab.js, exercising the real
// Express route handlers.

const pasteCalls: { sessionId: string; text: string }[] = []
const stageCalls: { sessionId: string; text: string }[] = []

vi.mock('./focusTab.js', () => ({
  pasteIntoSession: vi.fn((sessionId: string, text: string) => {
    pasteCalls.push({ sessionId, text })
    return Promise.resolve(sessionId === 'live-tab-id')
  }),
  stageInSession: vi.fn((sessionId: string, text: string) => {
    stageCalls.push({ sessionId, text })
    return Promise.resolve(sessionId === 'live-tab-id')
  }),
  tmuxSessionExists: vi.fn(async () => false),
  tmuxPaneIsStrayShell: vi.fn(async () => false),
  sessionIsClientOf: vi.fn(async () => false),
  findSessionAttachedToTmux: vi.fn(async () => null),
  reattachAndRecord: vi.fn(async () => null),
  reattachOrFocus: vi.fn(async () => 'none' as const),
  openVSCode: vi.fn(async () => undefined),
  openBrowserUrl: vi.fn(async () => undefined),
  openAnnotationSession: vi.fn(async () => ({ status: 'error' as const, error: 'not exercised in this suite' })),
  pasteIntoTrackedSession: vi.fn(async () => ({ status: 'no-session' as const, hadRecordedSession: false })),
  normalizeWhitespace: (value: string) => value.replace(/\s+/g, ' ').trim(),
}))

let tmpDir: string
let baseUrl: string
let server: Server
let ORCHESTRATOR_SESSION_PATH: string
let ORCHESTRATOR_TMUX_PATH: string

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-batch-dispatch-test-'))
  process.env.TASKS_DIR = tmpDir
  // This suite is about writeToOrchestrator's own healing/lock/stray-shell
  // logic, not canonical-instance gating (that's server.canonicalGate.test.ts's
  // job) — so it runs as the canonical instance throughout.
  process.env.COCKPIT_DISPATCH_ENABLED = '1'
  ORCHESTRATOR_SESSION_PATH = path.join(tmpDir, 'ORCHESTRATOR_SESSION')
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
  pasteCalls.length = 0
  stageCalls.length = 0
  await fs.writeFile(ORCHESTRATOR_SESSION_PATH, 'live-tab-id')
  await fs.rm(ORCHESTRATOR_TMUX_PATH, { force: true })
})

function postBatch(body: unknown) {
  return fetch(`${baseUrl}/batch-dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /batch-dispatch', () => {
  it('stages a 3-milestone wave batch: 200, one stage call, zero paste calls, all 3 slugs in the text', async () => {
    const res = await postBatch({ kind: 'wave', slugs: ['parent-m1', 'parent-m2', 'parent-m3'] })
    expect(res.status).toBe(200)
    expect(stageCalls).toHaveLength(1)
    expect(pasteCalls).toHaveLength(0)
    expect(stageCalls[0].text).toContain('/pipelinely-dev parent-m1')
    expect(stageCalls[0].text).toContain('/pipelinely-dev parent-m2')
    expect(stageCalls[0].text).toContain('/pipelinely-dev parent-m3')
  })

  it('stages a 3-item backlog batch: 200, one stage call, zero paste calls, all 3 descriptions in the text', async () => {
    const res = await postBatch({
      kind: 'backlog',
      items: [{ description: 'Item A' }, { description: 'Item B' }, { description: 'Item C' }],
    })
    expect(res.status).toBe(200)
    expect(stageCalls).toHaveLength(1)
    expect(pasteCalls).toHaveLength(0)
    expect(stageCalls[0].text).toContain('Item A')
    expect(stageCalls[0].text).toContain('Item B')
    expect(stageCalls[0].text).toContain('Item C')
  })

  it('two batches back-to-back: two stage calls, still zero paste calls — the concatenation stays unsent', async () => {
    const resA = await postBatch({ kind: 'wave', slugs: ['parent-m1'] })
    const resB = await postBatch({ kind: 'backlog', items: [{ description: 'Item A' }] })
    expect(resA.status).toBe(200)
    expect(resB.status).toBe(200)
    expect(stageCalls).toHaveLength(2)
    expect(pasteCalls).toHaveLength(0)
  })

  it('503s with no orchestrator session recorded, and never pastes', async () => {
    await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
    const res = await postBatch({ kind: 'wave', slugs: ['parent-m1'] })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toBeTruthy()
    expect(pasteCalls).toHaveLength(0)
  })

  it('503s when the tmux pane is a stray shell', async () => {
    await fs.writeFile(ORCHESTRATOR_TMUX_PATH, 'orchestrator')
    const { tmuxSessionExists, sessionIsClientOf, tmuxPaneIsStrayShell } = await import('./focusTab.js')
    vi.mocked(tmuxSessionExists).mockResolvedValueOnce(true)
    vi.mocked(sessionIsClientOf).mockResolvedValueOnce(true)
    vi.mocked(tmuxPaneIsStrayShell).mockResolvedValueOnce(true)

    const res = await postBatch({ kind: 'wave', slugs: ['parent-m1'] })
    expect(res.status).toBe(503)
    expect(pasteCalls).toHaveLength(0)
    expect(stageCalls).toHaveLength(0)
  })

  it('400s and writes nothing for a malformed body', async () => {
    const res = await postBatch({ kind: 'bogus' })
    expect(res.status).toBe(400)
    expect(stageCalls).toHaveLength(0)
    expect(pasteCalls).toHaveLength(0)
  })

  it('400s and writes nothing for an empty batch', async () => {
    const res = await postBatch({ kind: 'wave', slugs: [] })
    expect(res.status).toBe(400)
    expect(stageCalls).toHaveLength(0)
  })

  it('400s and writes nothing for a slug failing SAFE_TOKEN', async () => {
    const res = await postBatch({ kind: 'wave', slugs: ['not a valid slug'] })
    expect(res.status).toBe(400)
    expect(stageCalls).toHaveLength(0)
  })

  it('404s POST /pipelinely-dev/:slug — the auto-submit route is gone', async () => {
    const res = await fetch(`${baseUrl}/pipelinely-dev/some-milestone`, { method: 'POST' })
    expect(res.status).toBe(404)
  })
})
