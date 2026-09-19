import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'

// Regression coverage for FINDINGS.md's "Mechanism A" at the production
// wiring level — not just the lock primitive (see orchestratorLock.test.ts)
// but writeToOrchestrator and POST /orchestrator/tab as actually called
// through the real Express app. Before the fix, both read
// ORCHESTRATOR_SESSION/ORCHESTRATOR_TMUX, decided how to heal them, and
// (sometimes) rewrote ORCHESTRATOR_SESSION with no mutual exclusion — so two
// concurrent HTTP requests (two dashboard clicks close together, a
// backlog-batch dispatch racing an unrelated focus-fallback, two browser
// tabs of the dashboard) could interleave their own osascript/tmux calls and
// their own pointer-file write. This is exactly the scenario
// e2e/fixtures/orchestratorSessionLock.ts's own comment describes actually
// happening between parallel Playwright *workers* — but that lock only
// protects the *fixture* copies of these files from *test* interference; it
// proves nothing about whether the production code path is actually safe
// under concurrent real requests. This suite exercises the production route
// handlers directly (mocking only the osascript/tmux-touching functions in
// focusTab.js, never route logic) to prove that.
//
// The mocked focusTab functions route every call through
// enterCriticalSection, which tracks how many are "in flight" at once and
// adds a real delay — standing in for the real `execa('osascript'|'tmux',
// ...)` round trip that gave the original race its window. If
// writeToOrchestrator/POST /orchestrator/tab were not correctly holding
// withOrchestratorLock around their full read-decide-write body, two
// concurrent requests would show more than one call in flight at once.

let concurrentCriticalSectionEntries = 0
let maxConcurrentCriticalSectionEntries = 0
const pasteCalls: { sessionId: string; text: string }[] = []
const stageCalls: { sessionId: string; text: string }[] = []

async function enterCriticalSection<T>(fn: () => Promise<T>): Promise<T> {
  concurrentCriticalSectionEntries++
  maxConcurrentCriticalSectionEntries = Math.max(maxConcurrentCriticalSectionEntries, concurrentCriticalSectionEntries)
  try {
    // Stands in for a real osascript/tmux round trip's wall-clock cost —
    // without this, two calls could "overlap" only in theory, never in
    // practice, and the assertions below would pass by accident.
    await new Promise((resolve) => setTimeout(resolve, 15))
    return await fn()
  } finally {
    concurrentCriticalSectionEntries--
  }
}

// Simulates: ORCHESTRATOR_SESSION points at a closed tab ('stale-id'), but
// ORCHESTRATOR_TMUX names a still-alive tmux session that a different,
// already-open iTerm2 tab ('live-tab-id') happens to be attached to — the
// "recorded id went stale while the real tab stayed open" case
// writeToOrchestrator's adopt branch exists for (server.ts's own comment on
// findSessionAttachedToTmux). This is deliberately the branch with the most
// osascript/tmux calls in it (tmuxSessionExists, tmuxPaneIsStrayShell x2,
// sessionIsClientOf, findSessionAttachedToTmux), i.e. the widest possible
// unlocked race window.
vi.mock('./focusTab.js', () => ({
  pasteIntoSession: vi.fn((sessionId: string, text: string) =>
    enterCriticalSection(async () => {
      pasteCalls.push({ sessionId, text })
      return sessionId === 'live-tab-id'
    }),
  ),
  stageInSession: vi.fn((sessionId: string, text: string) =>
    enterCriticalSection(async () => {
      stageCalls.push({ sessionId, text })
      return sessionId === 'live-tab-id'
    }),
  ),
  tmuxSessionExists: vi.fn(() => enterCriticalSection(async () => true)),
  tmuxPaneIsStrayShell: vi.fn(() => enterCriticalSection(async () => false)),
  // Only 'live-tab-id' is really attached to the tmux session — 'stale-id'
  // (the initial ORCHESTRATOR_SESSION value in beforeEach) is not, which is
  // what routes the first request past the fast path and into the adopt
  // branch below, exactly like a real stale-recorded-tab would.
  sessionIsClientOf: vi.fn((sessionId: string) => enterCriticalSection(async () => sessionId === 'live-tab-id')),
  findSessionAttachedToTmux: vi.fn(() => enterCriticalSection(async () => 'live-tab-id')),
  reattachAndRecord: vi.fn(() => enterCriticalSection(async () => null)),
  reattachOrFocus: vi.fn(() => enterCriticalSection(async () => 'none' as const)),
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
  pasteCalls.length = 0
  stageCalls.length = 0
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
    // requests' mocked osascript/tmux calls genuinely overlapping in time,
    // given enterCriticalSection's real 15ms delay) instead of 1.
    expect(maxConcurrentCriticalSectionEntries).toBe(1)

    // Both dispatches actually landed, addressed to the one real (adopted)
    // session, each carrying its own distinct text — not merged, not
    // dropped, not each other's. Whichever request's critical section runs
    // first finds ORCHESTRATOR_SESSION at the stale value; the identity
    // check (sessionIsClientOf mocked false for 'stale-id') routes it past
    // the fast path without ever calling write() into that dead end, straight
    // to the adopt heal onto 'live-tab-id'. Because the lock makes the two
    // fully serialized, the second request's critical section always starts
    // *after* the first one's write, so it reads the now-healed
    // 'live-tab-id' straight away, passes the identity check
    // (sessionIsClientOf mocked true for it), and succeeds on the fast path
    // — 2 calls total, both landing on the adopted session, and never a
    // wasted 'stale-id' attempt.
    const liveCalls = pasteCalls.filter((c) => c.sessionId === 'live-tab-id')
    const staleCalls = pasteCalls.filter((c) => c.sessionId === 'stale-id')
    expect(pasteCalls).toHaveLength(2)
    expect(staleCalls).toHaveLength(0)
    expect(liveCalls).toHaveLength(2)
    const texts = liveCalls.map((c) => c.text).sort()
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
    // Same reasoning as the previous test: one request hits the stale
    // pointer first, fails identity, and heals via adopt (1 call); the other
    // observes the already-healed pointer and passes identity straight away
    // (1 call). The two routes now use different writers — /backlog/dispatch
    // pastes, /batch-dispatch stages — so each writer sees exactly one call,
    // both landing on the adopted session.
    expect(pasteCalls).toHaveLength(1)
    expect(pasteCalls.filter((c) => c.sessionId === 'live-tab-id')).toHaveLength(1)
    expect(stageCalls).toHaveLength(1)
    expect(stageCalls.filter((c) => c.sessionId === 'live-tab-id')).toHaveLength(1)
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
  it('pastes the project clause when a valid project is given', async () => {
    const res = await fetch(`${baseUrl}/backlog/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'item C', context: null, project: 'cockpit-ai' }),
    })
    expect(res.status).toBe(200)
    const call = pasteCalls.find((c) => c.text.includes('item C'))
    expect(call?.text).toBe("Let's do this backlog item (project: cockpit-ai): item C")
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
