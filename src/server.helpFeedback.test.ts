import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { startTestServer, stopTestServer, type TestServerHandle } from './serverTestHarness.js'

// Proves the server half of tech-design-help-feedback-tab.md's "stage,
// don't send" decision and its newline decision: POST /help/pipelinely-feedback writes
// through stageInSession (never pasteIntoSession), composes
// `/pipelinely-feedback <message>` with normalizeWhitespace applied to the message, and
// validates the body the way /backlog/dispatch does — same harness shape as
// server.handover.test.ts.

const pasteCalls: { sessionId: string; text: string }[] = []
const stageCalls: { sessionId: string; text: string }[] = []

vi.mock('./focusTab.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./focusTab.js')>()
  return {
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
    getLiveSessionIds: vi.fn(async () => null),
    getLiveTmuxSessions: vi.fn(async () => new Set<string>()),
    // normalizeWhitespace is exercised for real — a mocked collapse would
    // make the newline assertions below meaningless (tech-design's own
    // instruction, "Tests" section).
    normalizeWhitespace: actual.normalizeWhitespace,
  }
})

let handle: TestServerHandle
let baseUrl: string

beforeAll(async () => {
  handle = await startTestServer({ COCKPIT_DISPATCH_ENABLED: '1' })
  baseUrl = `http://127.0.0.1:${handle.boundPort}`
})

afterAll(async () => {
  await stopTestServer(handle, ['COCKPIT_DISPATCH_ENABLED'])
})

beforeEach(async () => {
  pasteCalls.length = 0
  stageCalls.length = 0
  const { stageInSession } = await import('./focusTab.js')
  vi.mocked(stageInSession).mockClear()
  await fs.rm(path.join(handle.tmpDir, 'ORCHESTRATOR_SESSION'), { force: true })
  await fs.rm(path.join(handle.tmpDir, 'ORCHESTRATOR_TMUX'), { force: true })
})

function postFeedback(message: unknown) {
  return fetch(`${baseUrl}/help/pipelinely-feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })
}

describe('POST /help/pipelinely-feedback', () => {
  it('200: calls stageInSession once with the recorded session id and /pipelinely-feedback <message>; pasteIntoSession never called', async () => {
    await fs.writeFile(path.join(handle.tmpDir, 'ORCHESTRATOR_SESSION'), 'live-tab-id')

    const res = await postFeedback('the stepper collapses the wrong node')
    expect(res.status).toBe(200)
    expect(stageCalls).toHaveLength(1)
    expect(stageCalls[0]).toEqual({ sessionId: 'live-tab-id', text: '/pipelinely-feedback the stepper collapses the wrong node' })
    expect(pasteCalls).toHaveLength(0)
  })

  it.each([
    ['a newline', 'line one\nline two', '/pipelinely-feedback line one line two'],
    ['a CRLF', 'line one\r\nline two', '/pipelinely-feedback line one line two'],
    ['a tab', 'a\tb', '/pipelinely-feedback a b'],
    ['runs of spaces', 'a    b', '/pipelinely-feedback a b'],
  ])('collapses %s into one single-space-joined line before staging', async (_label, message, expected) => {
    await fs.writeFile(path.join(handle.tmpDir, 'ORCHESTRATOR_SESSION'), 'live-tab-id')

    const res = await postFeedback(message)
    expect(res.status).toBe(200)
    expect(stageCalls[0].text).toBe(expected)
  })

  it.each([
    ['missing', undefined],
    ['non-string', 42],
    ['empty', ''],
    ['whitespace-only', '   \n  '],
  ])('400 for a %s message; no write function called', async (_label, message) => {
    const res = await postFeedback(message)
    expect(res.status).toBe(400)
    expect(stageCalls).toHaveLength(0)
    expect(pasteCalls).toHaveLength(0)
  })

  it('503 with no ORCHESTRATOR_SESSION recorded; no write function called', async () => {
    const res = await postFeedback('a message')
    expect(res.status).toBe(503)
    expect(stageCalls).toHaveLength(0)
    expect(pasteCalls).toHaveLength(0)
  })

  it('409 when the recorded tab is dead and the adopted/reattached write fails', async () => {
    await fs.writeFile(path.join(handle.tmpDir, 'ORCHESTRATOR_SESSION'), 'stale-id')
    await fs.writeFile(path.join(handle.tmpDir, 'ORCHESTRATOR_TMUX'), 'orchestrator')
    const { tmuxSessionExists, findSessionAttachedToTmux, stageInSession } = await import('./focusTab.js')
    vi.mocked(tmuxSessionExists).mockResolvedValueOnce(true)
    vi.mocked(findSessionAttachedToTmux).mockResolvedValueOnce('adopted-id')
    vi.mocked(stageInSession).mockResolvedValueOnce(false)

    const res = await postFeedback('a message')
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.reattached).toBe(true)
  })

  it('500 when stageInSession rejects, and logs it', async () => {
    await fs.writeFile(path.join(handle.tmpDir, 'ORCHESTRATOR_SESSION'), 'live-tab-id')
    const { stageInSession } = await import('./focusTab.js')
    vi.mocked(stageInSession).mockRejectedValueOnce(new Error('boom'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const res = await postFeedback('a message')
      expect(res.status).toBe(500)
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})
