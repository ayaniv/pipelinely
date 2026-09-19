import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { startTestServer, stopTestServer, type TestServerHandle } from './serverTestHarness.js'

// Proves the server half of tech-design.md's "stage, don't send" decision:
// both new routes write through the staging-shaped primitives
// (pasteIntoTrackedSession/stageInSession with submit:false), never the
// sending ones (pasteIntoSession), on every case including the failure
// paths — the same safety property server.batchDispatch.test.ts proves for
// /batch-dispatch.
//
// Harness: main() (not a bare app.listen — POST /pipelinely-handover/:slug needs
// currentTasks populated by main()'s own startup refreshTasks(), which
// server.batchDispatch.test.ts's routes never touch) via startTestServer's
// seed hook, which writes a task dir before server.js is imported.

const SLUG = 'handover-task'

const pasteCalls: { sessionId: string; text: string }[] = []
const stageCalls: { sessionId: string; text: string }[] = []
const trackedPasteCalls: { target: unknown; text: string; options: unknown }[] = []

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
  pasteIntoTrackedSession: vi.fn((target: unknown, text: string, options: unknown) => {
    trackedPasteCalls.push({ target, text, options })
    return Promise.resolve({ status: 'no-session' as const, hadRecordedSession: false })
  }),
  // main() -> refreshTasks -> parseAllTasks calls these two directly
  // (src/taskParser.ts) — the batchDispatch-shaped mock above omits them
  // because that suite never calls main().
  getLiveSessionIds: vi.fn(async () => null),
  getLiveTmuxSessions: vi.fn(async () => new Set<string>()),
  normalizeWhitespace: (value: string) => value.replace(/\s+/g, ' ').trim(),
}))

let handle: TestServerHandle
let baseUrl: string
let taskDir: string

beforeAll(async () => {
  // POST /orchestrator/pipelinely-handover goes through writeToOrchestrator, so this
  // suite runs as the canonical instance throughout — canonical-instance
  // gating itself is server.canonicalGate.test.ts's job, not this file's.
  handle = await startTestServer({ COCKPIT_DISPATCH_ENABLED: '1' }, async (tmpDir) => {
    taskDir = path.join(tmpDir, SLUG)
    await fs.mkdir(taskDir, { recursive: true })
    await fs.writeFile(path.join(taskDir, 'TASK.md'), '# Handover test task\n')
    // /pipelinely-handover/:slug has no status gate (tech-design.md's own decision), so
    // any STATUS is fine for its tests below.
    await fs.writeFile(path.join(taskDir, 'STATUS'), 'waiting: needs input on approach\n')
    await fs.writeFile(path.join(taskDir, 'ITERM_SESSION'), 'task-tab-id')
    await fs.writeFile(path.join(taskDir, 'TMUX_SESSION'), 'worker-handover-task')
  })
  baseUrl = `http://127.0.0.1:${handle.boundPort}`
})

afterAll(async () => {
  await stopTestServer(handle, ['COCKPIT_DISPATCH_ENABLED'])
})

beforeEach(async () => {
  pasteCalls.length = 0
  stageCalls.length = 0
  trackedPasteCalls.length = 0
  const { pasteIntoTrackedSession, stageInSession } = await import('./focusTab.js')
  vi.mocked(pasteIntoTrackedSession).mockReset()
  vi.mocked(pasteIntoTrackedSession).mockImplementation((target: unknown, text: string, options: unknown) => {
    trackedPasteCalls.push({ target, text, options })
    return Promise.resolve({ status: 'no-session' as const, hadRecordedSession: false })
  })
  vi.mocked(stageInSession).mockClear()
  await fs.rm(path.join(handle.tmpDir, 'ORCHESTRATOR_SESSION'), { force: true })
  await fs.rm(path.join(handle.tmpDir, 'ORCHESTRATOR_TMUX'), { force: true })
})

function postHandover(slug: string) {
  return fetch(`${baseUrl}/pipelinely-handover/${encodeURIComponent(slug)}`, { method: 'POST' })
}

function postOrchestratorHandover() {
  return fetch(`${baseUrl}/orchestrator/pipelinely-handover`, { method: 'POST' })
}

describe('POST /pipelinely-handover/:slug', () => {
  it('200: calls pasteIntoTrackedSession once with /pipelinely-handover, submit:false/focus:true, and the task\'s recorded session/tmux/ITERM_SESSION path — never pasteIntoSession/stageInSession', async () => {
    const { pasteIntoTrackedSession } = await import('./focusTab.js')
    // mockImplementationOnce (not mockResolvedValueOnce), which would bypass
    // the trackedPasteCalls-recording body entirely and leave the assertions
    // below checking an array that was never appended to.
    vi.mocked(pasteIntoTrackedSession).mockImplementationOnce((target: unknown, text: string, options: unknown) => {
      trackedPasteCalls.push({ target, text, options })
      return Promise.resolve({ status: 'ok', reattached: false })
    })

    const res = await postHandover(SLUG)
    expect(res.status).toBe(200)
    expect(trackedPasteCalls).toHaveLength(1)
    expect(trackedPasteCalls[0].text).toBe('/pipelinely-handover')
    expect(trackedPasteCalls[0].options).toEqual({ submit: false, focus: true })
    expect(trackedPasteCalls[0].target).toEqual({
      sessionId: 'task-tab-id',
      tmuxSession: 'worker-handover-task',
      sessionFilePath: path.join(taskDir, 'ITERM_SESSION'),
    })
    expect(pasteCalls).toHaveLength(0)
    expect(stageCalls).toHaveLength(0)
  })

  it('200 when the result is { status: "ok", reattached: true }', async () => {
    const { pasteIntoTrackedSession } = await import('./focusTab.js')
    vi.mocked(pasteIntoTrackedSession).mockResolvedValueOnce({ status: 'ok', reattached: true })

    const res = await postHandover(SLUG)
    expect(res.status).toBe(200)
  })

  it('409 with { reattached: true } on reattach-paste-failed, and logs it', async () => {
    const { pasteIntoTrackedSession } = await import('./focusTab.js')
    vi.mocked(pasteIntoTrackedSession).mockResolvedValueOnce({ status: 'reattach-paste-failed' })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const res = await postHandover(SLUG)
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.reattached).toBe(true)
      expect(body.error).toContain('the handover command still failed to stage')
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('503 on no-session, with hadRecordedSession=true wording', async () => {
    const { pasteIntoTrackedSession } = await import('./focusTab.js')
    vi.mocked(pasteIntoTrackedSession).mockResolvedValueOnce({ status: 'no-session', hadRecordedSession: true })

    const res = await postHandover(SLUG)
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toContain("own tab not found")
  })

  it('503 on no-session, with hadRecordedSession=false wording', async () => {
    const { pasteIntoTrackedSession } = await import('./focusTab.js')
    vi.mocked(pasteIntoTrackedSession).mockResolvedValueOnce({ status: 'no-session', hadRecordedSession: false })

    const res = await postHandover(SLUG)
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toContain('has no recorded session to stage into')
  })

  it('404 for an unknown slug; no write function called', async () => {
    const res = await postHandover('no-such-task')
    expect(res.status).toBe(404)
    expect(trackedPasteCalls).toHaveLength(0)
  })

  it('500 when pasteIntoTrackedSession rejects, and logs it', async () => {
    const { pasteIntoTrackedSession } = await import('./focusTab.js')
    vi.mocked(pasteIntoTrackedSession).mockRejectedValueOnce(new Error('boom'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const res = await postHandover(SLUG)
      expect(res.status).toBe(500)
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('POST /orchestrator/pipelinely-handover', () => {
  it('200: calls stageInSession once with the recorded session id and /pipelinely-handover; pasteIntoSession never called', async () => {
    await fs.writeFile(path.join(handle.tmpDir, 'ORCHESTRATOR_SESSION'), 'live-tab-id')

    const res = await postOrchestratorHandover()
    expect(res.status).toBe(200)
    expect(stageCalls).toHaveLength(1)
    expect(stageCalls[0]).toEqual({ sessionId: 'live-tab-id', text: '/pipelinely-handover' })
    expect(pasteCalls).toHaveLength(0)
  })

  it('503 with no ORCHESTRATOR_SESSION recorded; no write function called', async () => {
    const res = await postOrchestratorHandover()
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

    const res = await postOrchestratorHandover()
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.reattached).toBe(true)
  })

  it('503 stray-process when the tmux pane has fallen back to a shell', async () => {
    await fs.writeFile(path.join(handle.tmpDir, 'ORCHESTRATOR_SESSION'), 'live-tab-id')
    await fs.writeFile(path.join(handle.tmpDir, 'ORCHESTRATOR_TMUX'), 'orchestrator')
    const { tmuxSessionExists, sessionIsClientOf, tmuxPaneIsStrayShell } = await import('./focusTab.js')
    vi.mocked(tmuxSessionExists).mockResolvedValueOnce(true)
    vi.mocked(sessionIsClientOf).mockResolvedValueOnce(true)
    vi.mocked(tmuxPaneIsStrayShell).mockResolvedValueOnce(true)

    const res = await postOrchestratorHandover()
    expect(res.status).toBe(503)
    expect(stageCalls).toHaveLength(0)
  })
})
