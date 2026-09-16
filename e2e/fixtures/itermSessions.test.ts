import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'

vi.mock('execa', () => ({ execa: vi.fn() }))

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// itermSessions.ts calls assertIsolatedEnvironment() at its own module
// scope (see src/e2eIsolation.test.ts's "module-scope isolation guard
// placement" tests), so merely importing it here has to satisfy that guard
// for real — the same way scripts/e2e-integration/verify-consent.ts does —
// or every test in this file fails on import before it even runs. A static
// `import` is hoisted above any setup code, so the module is loaded
// dynamically in `beforeAll`, after a real (self-issued) consent token
// exists and the required env vars are set.
const TOKEN_PATH = path.join(os.tmpdir(), `itermSessions-test-consent-${process.pid}.json`)
const CONSENT_NONCE = 'itermSessions-test-nonce'
const ORIGINAL_ENV = { ...process.env }

let itermSessions: typeof import('./itermSessions.js')

beforeAll(async () => {
  fs.writeFileSync(
    TOKEN_PATH,
    JSON.stringify({ nonce: CONSENT_NONCE, issuedAt: Date.now(), runnerPid: process.pid }),
  )
  process.env.COCKPIT_E2E_CONSENT = CONSENT_NONCE
  process.env.COCKPIT_E2E_CONSENT_FILE = TOKEN_PATH
  process.env.TASKS_DIR = path.join(__dirname, 'tasks')
  itermSessions = await import('./itermSessions.js')
})

// Mirrors src/e2eIsolation.test.ts's try/finally teardown for the same kind
// of setup: beforeAll above mutates process.env and writes a real file to
// os.tmpdir(), neither of which vitest cleans up on its own.
afterAll(() => {
  process.env = ORIGINAL_ENV
  fs.rmSync(TOKEN_PATH, { force: true })
})

afterEach(() => {
  vi.mocked(execa).mockReset()
})

const REJECTION_MESSAGE = /not a scratch session this suite created/

// execa's real resolved type (`Result`) requires stdout, stderr, all, stdio,
// command, durationMs, and a dozen other fields — every call site here only
// reads `.stdout`, so supplying the rest would just be unused noise. `never`
// is the only cast that lets a partial `{ stdout }` stand in for the full
// type; centralizing it in one place (rather than repeating the same
// uncommented cast at every call site) is what makes that reasoning visible.
function mockExecaStdout(stdout: string): void {
  vi.mocked(execa).mockResolvedValueOnce({ stdout } as never)
}

describe('scratch session ownership guard', () => {
  it('rejects closeScratchSession for an id openScratchSession never returned', async () => {
    await expect(itermSessions.closeScratchSession('untracked-id')).rejects.toThrow(REJECTION_MESSAGE)
    expect(execa).not.toHaveBeenCalled()
  })

  it('rejects closeScratchTab for an id openScratchSession never returned', async () => {
    await expect(itermSessions.closeScratchTab('untracked-id')).rejects.toThrow(REJECTION_MESSAGE)
    expect(execa).not.toHaveBeenCalled()
  })

  it('rejects typeIntoSession for an id openScratchSession never returned', async () => {
    await expect(itermSessions.typeIntoSession('untracked-id', 'echo hi')).rejects.toThrow(REJECTION_MESSAGE)
    expect(execa).not.toHaveBeenCalled()
  })

  it('tracks an id returned by openScratchSession, and accepts it in the guarded functions', async () => {
    mockExecaStdout('session-abc\n')
    const sessionId = await itermSessions.openScratchSession()

    expect(sessionId).toBe('session-abc')
    expect(itermSessions.isTrackedScratchSession(sessionId)).toBe(true)

    mockExecaStdout('')
    await expect(itermSessions.typeIntoSession(sessionId, 'echo hi')).resolves.toBeUndefined()
    expect(execa).toHaveBeenCalledTimes(2)

    // Close it before the test ends — trackedScratchSessionIds is
    // module-scope state shared by every test in this file, and this is the
    // only test that tracks an id without also closing it, so leaving this
    // out would leak 'session-abc' into every later test.
    mockExecaStdout('')
    await itermSessions.closeScratchSession(sessionId)
  })

  it('drops the id once closeScratchSession closes it, rejecting a second call', async () => {
    mockExecaStdout('session-xyz\n')
    const sessionId = await itermSessions.openScratchSession()

    mockExecaStdout('')
    await itermSessions.closeScratchSession(sessionId)
    expect(itermSessions.isTrackedScratchSession(sessionId)).toBe(false)

    await expect(itermSessions.closeScratchSession(sessionId)).rejects.toThrow(REJECTION_MESSAGE)
  })

  it('drops the id once closeScratchTab closes it, rejecting a second call', async () => {
    mockExecaStdout('session-tab\n')
    const sessionId = await itermSessions.openScratchSession()

    mockExecaStdout('')
    await itermSessions.closeScratchTab(sessionId)
    expect(itermSessions.isTrackedScratchSession(sessionId)).toBe(false)

    await expect(itermSessions.closeScratchTab(sessionId)).rejects.toThrow(REJECTION_MESSAGE)
  })
})
