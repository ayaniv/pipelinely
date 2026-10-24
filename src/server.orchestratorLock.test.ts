import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'

// Regression coverage for FINDINGS.md's "Mechanism A" at the production
// wiring level — not just the lock primitive (see orchestratorLock.test.ts)
// but writeToOrchestrator and POST /orchestrator/tab as actually called
// through the real Express app. Both read the orchestrator pointer files and
// can rewrite ORCHESTRATOR_SESSION; without mutual exclusion, two concurrent
// HTTP requests (two dashboard clicks close together, a backlog-batch
// dispatch racing an unrelated focus-fallback, two browser tabs of the
// dashboard) could interleave their own tmux/osascript calls and their own
// pointer-file write. This is exactly the scenario
// e2e/fixtures/orchestratorSessionLock.ts's own comment describes actually
// happening between parallel Playwright *workers* — but that lock only
// protects the *fixture* copies of these files from *test* interference; it
// proves nothing about whether the production code path is actually safe
// under concurrent real requests. This suite exercises the production route
// handlers directly (mocking only the tmux/osascript-touching functions,
// never route logic) to prove that.
//
// The mocked tmux write and focusTab functions route every call through
// enterCriticalSection, which tracks how many are "in flight" at once and
// adds a real delay — standing in for the real tmux/osascript round trip that
// gave the original race its window. If writeToOrchestrator/POST
// /orchestrator/tab were not correctly holding withOrchestratorLock around
// their full read-decide-write body, two concurrent requests would show more
// than one call in flight at once.

let concurrentCriticalSectionEntries = 0
let maxConcurrentCriticalSectionEntries = 0
const writeCalls: { session: string; text: string; submit: boolean }[] = []

async function enterCriticalSection<T>(fn: () => Promise<T>): Promise<T> {
  concurrentCriticalSectionEntries++
  maxConcurrentCriticalSectionEntries = Math.max(maxConcurrentCriticalSectionEntries, concurrentCriticalSectionEntries)
  try {
    // Stands in for a real tmux/osascript round trip's wall-clock cost —
    // without this, two calls could "overlap" only in theory, never in
    // practice, and the assertions below would pass by accident.
    await new Promise((resolve) => setTimeout(resolve, 15))
    return await fn()
  } finally {
    concurrentCriticalSectionEntries--
  }
}

vi.mock('./tmuxPaneWrite.js', () => ({
  writeTextToTmuxSession: vi.fn((session: string, text: string, options: { submit: boolean }) =>
    enterCriticalSection(async () => {
      writeCalls.push({ session, text, submit: options.submit })
      return { status: 'ok' as const, paneId: '%7' }
    }),
  ),
}))

// ORCHESTRATOR_SESSION starts at a stale id ('stale-id') while a different
// tab ('live-tab-id') is the one really attached to the tmux session, so
// every write's follow-up findSessionAttachedToTmux re-records the pointer
// file inside the lock — the pointer-rewriting step the lock exists to
// protect.
vi.mock('./focusTab.js', () => ({
  focusITermTab: vi.fn(() => enterCriticalSection(async () => undefined)),
  tmuxSessionExists: vi.fn(() => enterCriticalSection(async () => true)),
  findSessionAttachedToTmux: vi.fn(() => enterCriticalSection(async () => 'live-tab-id')),
  reattachAndRecord: vi.fn(() => enterCriticalSection(async () => null)),
  reattachOrFocus: vi.fn(() => enterCriticalSection(async () => 'none' as const)),
  openVSCode: vi.fn(async () => undefined),
  openBrowserUrl: vi.fn(async () => undefined),
  openAnnotationSession: vi.fn(async () => ({ status: 'error' as const, error: 'not exercised in this suite' })),
  normalizeWhitespace: (value: string) => value.replace(/\s+/g, ' ').trim(),
}))

let tmpDir: string
let baseUrl: string
let server: Server
let ORCHESTRATOR_SESSION_PATH: string
let ORCHESTRATOR_TMUX_PATH: string

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-orchestrator-race-test-'))
  process.env.TASKS_DIR = tmpDir
  // This suite is about the pointer-file lock, not the canonical-instance
  // gate (see server.canonicalGate.test.ts for that) — every dispatch here
  // must reach writeToOrchestratorLocked for the race assertions to mean
  // anything, so it opts into canonical mode for its own duration.
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
  concurrentCriticalSectionEntries = 0
  maxConcurrentCriticalSectionEntries = 0
  writeCalls.length = 0
  await fs.writeFile(ORCHESTRATOR_SESSION_PATH, 'stale-id')
  await fs.writeFile(ORCHESTRATOR_TMUX_PATH, 'orchestrator')
})

describe('concurrent orchestrator-pointer operations serialize (writeToOrchestrator)', () => {
  it('two /backlog/dispatch requests fired concurrently never overlap their osascript/tmux window, and both messages land intact — neither is lost, corrupted, or crossed with the other', async () => {
    const [resA, resB] = await Promise.all([
      fetch(`${baseUrl}/backlog/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'item A', context: null }),
      }),
      fetch(`${baseUrl}/backlog/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'item B', context: null }),
      }),
    ])

    expect(resA.status).toBe(200)
    expect(resB.status).toBe(200)

    // The core regression assertion: if writeToOrchestratorLocked's body
    // weren't fully covered by withOrchestratorLock, this would be 2 (both
    // requests' mocked tmux/osascript calls genuinely overlapping in time,
    // given enterCriticalSection's real 15ms delay) instead of 1.
    expect(maxConcurrentCriticalSectionEntries).toBe(1)

    // Both dispatches actually landed, addressed to the recorded tmux
    // session, each carrying its own distinct text — not merged, not dropped,
    // not each other's.
    expect(writeCalls.map((c) => c.session)).toEqual(['orchestrator', 'orchestrator'])
    expect(writeCalls.every((c) => c.submit)).toBe(true)
    const texts = writeCalls.map((c) => c.text).sort()
    expect(texts).toEqual(["Let's do this backlog item: item A", "Let's do this backlog item: item B"].sort())

    // The pointer file ends up holding one consistent, valid value — not a
    // torn write from two overlapping writers.
    expect((await fs.readFile(ORCHESTRATOR_SESSION_PATH, 'utf-8')).trim()).toBe('live-tab-id')
  })

  it('a /backlog/dispatch and a /batch-dispatch request fired concurrently (different routes, same underlying writeToOrchestrator) still serialize', async () => {
    const [resDispatch, resBatch] = await Promise.all([
      fetch(`${baseUrl}/backlog/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'item A', context: null }),
      }),
      fetch(`${baseUrl}/batch-dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'wave', slugs: ['some-milestone-m1'] }),
      }),
    ])

    expect(resDispatch.status).toBe(200)
    expect(resBatch.status).toBe(200)
    expect(maxConcurrentCriticalSectionEntries).toBe(1)
    // /backlog/dispatch sends (submit:true), /batch-dispatch stages
    // (submit:false); each writes exactly once into the one recorded session.
    expect(writeCalls.map((c) => c.session)).toEqual(['orchestrator', 'orchestrator'])
    expect(writeCalls.filter((c) => c.submit)).toHaveLength(1)
    expect(writeCalls.filter((c) => !c.submit)).toHaveLength(1)
  })

  it('POST /orchestrator/tab (a distinct writer of the same pointer files) serializes against a concurrent /backlog/dispatch too', async () => {
    const [resTab, resDispatch] = await Promise.all([
      fetch(`${baseUrl}/orchestrator/tab`, { method: 'POST' }),
      fetch(`${baseUrl}/backlog/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'item A', context: null }),
      }),
    ])

    // reattachOrFocus is mocked to resolve 'none' — /orchestrator/tab's own
    // "neither tab nor tmux reachable" 503 branch — which is irrelevant
    // here; what matters is that its critical section (the mocked
    // reattachOrFocus call) never overlapped /backlog/dispatch's.
    expect(resTab.status).toBe(503)
    expect(resDispatch.status).toBe(200)
    expect(maxConcurrentCriticalSectionEntries).toBe(1)
  })
})

describe('POST /backlog/dispatch — project clause', () => {
  it('writes the project clause when a valid project is given', async () => {
    const res = await fetch(`${baseUrl}/backlog/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'item C', context: null, project: 'cockpit-ai' }),
    })
    expect(res.status).toBe(200)
    expect(writeCalls.map((c) => c.text)).toEqual(["Let's do this backlog item (project: cockpit-ai): item C"])
  })

  it('returns 400 for a non-token project', async () => {
    const res = await fetch(`${baseUrl}/backlog/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'item D', context: null, project: 'not a slug' }),
    })
    expect(res.status).toBe(400)
  })
})
