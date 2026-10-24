import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { startTestServer, stopTestServer, type TestServerHandle } from './serverTestHarness.js'

// Proves the server half of tech-design.md's "stage, don't send" decision:
// both routes write through writeTextToTmuxSession with submit:false, on
// every case including the failure paths — the same safety property
// server.batchDispatch.test.ts proves for /batch-dispatch.
//
// Harness: main() (not a bare app.listen — POST /pipelinely-handover/:slug needs
// currentTasks populated by main()'s own startup refreshTasks(), which
// server.batchDispatch.test.ts's routes never touch) via startTestServer's
// seed hook, which writes a task dir before server.js is imported.

const SLUG = 'handover-task'
const SLUG_WITHOUT_TMUX = 'handover-tab-only-task'
const TASK_TMUX_NAME = 'worker-handover-task'
const ORCHESTRATOR_TMUX_NAME = 'orchestrator'

vi.mock('./tmuxPaneWrite.js', () => ({
  writeTextToTmuxSession: vi.fn(async (_session: string, _text: string, _options: { submit: boolean }) => ({ status: 'ok', paneId: '%7' })),
}))

vi.mock('./focusTab.js', () => ({
  tmuxSessionExists: vi.fn(async () => true),
  findSessionAttachedToTmux: vi.fn(async () => 'attached-tab-id'),
  focusITermTab: vi.fn(async () => undefined),
  reattachAndRecord: vi.fn(async () => null),
  reattachOrFocus: vi.fn(async () => 'none' as const),
  openVSCode: vi.fn(async () => undefined),
  openBrowserUrl: vi.fn(async () => undefined),
  openAnnotationSession: vi.fn(async () => ({ status: 'error' as const, error: 'not exercised in this suite' })),
  // main() -> refreshTasks -> parseAllTasks calls these two directly
  // (src/taskParser.ts) — the batchDispatch-shaped mock above omits them
  // because that suite never calls main().
  getLiveSessionIds: vi.fn(async () => null),
  getLiveTmuxSessions: vi.fn(async () => new Set<string>()),
  normalizeWhitespace: (value: string) => value.replace(/\s+/g, ' ').trim(),
}))

let handle: TestServerHandle
let baseUrl: string

beforeAll(async () => {
  // POST /orchestrator/pipelinely-handover goes through writeToOrchestrator, so this
  // suite runs as the canonical instance throughout — canonical-instance
  // gating itself is server.canonicalGate.test.ts's job, not this file's.
  handle = await startTestServer({ COCKPIT_DISPATCH_ENABLED: '1' }, async (tmpDir) => {
    // /pipelinely-handover/:slug has no status gate (tech-design.md's own decision), so
    // any STATUS is fine for its tests below.
    for (const [slug, tmuxSession] of [[SLUG, TASK_TMUX_NAME], [SLUG_WITHOUT_TMUX, null]] as const) {
      const taskDir = path.join(tmpDir, slug)
      await fs.mkdir(taskDir, { recursive: true })
      await fs.writeFile(path.join(taskDir, 'TASK.md'), '# Handover test task\n')
      await fs.writeFile(path.join(taskDir, 'STATUS'), 'waiting: needs input on approach\n')
      await fs.writeFile(path.join(taskDir, 'ITERM_SESSION'), `${slug}-tab-id`)
      if (tmuxSession) await fs.writeFile(path.join(taskDir, 'TMUX_SESSION'), tmuxSession)
    }
  })
  baseUrl = `http://127.0.0.1:${handle.boundPort}`
})

afterAll(async () => {
  await stopTestServer(handle, ['COCKPIT_DISPATCH_ENABLED'])
})

beforeEach(async () => {
  const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
  vi.mocked(writeTextToTmuxSession).mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  await fs.writeFile(path.join(handle.tmpDir, 'ORCHESTRATOR_TMUX'), ORCHESTRATOR_TMUX_NAME)
})

async function tmuxWriteCalls() {
  const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
  return vi.mocked(writeTextToTmuxSession).mock.calls
}

function postHandover(slug: string) {
  return fetch(`${baseUrl}/pipelinely-handover/${encodeURIComponent(slug)}`, { method: 'POST' })
}

function postOrchestratorHandover() {
  return fetch(`${baseUrl}/orchestrator/pipelinely-handover`, { method: 'POST' })
}

describe('POST /pipelinely-handover/:slug', () => {
  it('200: stages /pipelinely-handover (submit:false) into the task\'s own TMUX_SESSION, exactly once', async () => {
    const res = await postHandover(SLUG)
    expect(res.status).toBe(200)
    expect(await tmuxWriteCalls()).toEqual([[TASK_TMUX_NAME, '/pipelinely-handover', { submit: false }]])
  })

  it('503 and logs when the task has no TMUX_SESSION; nothing written', async () => {
    const res = await postHandover(SLUG_WITHOUT_TMUX)
    expect(res.status).toBe(503)
    expect(await tmuxWriteCalls()).toEqual([])
    expect(console.error).toHaveBeenCalled()
  })

  it('503 when the task\'s pane has fallen back to a shell', async () => {
    const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
    vi.mocked(writeTextToTmuxSession).mockResolvedValueOnce({ status: 'refused', reason: 'stray-shell' })

    const res = await postHandover(SLUG)
    expect(res.status).toBe(503)
  })

  it('409 naming the reason when the task\'s pane is showing a dialog', async () => {
    const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
    vi.mocked(writeTextToTmuxSession).mockResolvedValueOnce({ status: 'refused', reason: 'dialog-open' })

    const res = await postHandover(SLUG)
    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe('dialog-open')
  })

  it('404 for an unknown slug; nothing written', async () => {
    const res = await postHandover('no-such-task')
    expect(res.status).toBe(404)
    expect(await tmuxWriteCalls()).toEqual([])
  })

  it('500 when writeTextToTmuxSession rejects, and logs it', async () => {
    const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
    vi.mocked(writeTextToTmuxSession).mockRejectedValueOnce(new Error('boom'))

    const res = await postHandover(SLUG)
    expect(res.status).toBe(500)
    expect(console.error).toHaveBeenCalled()
  })
})

describe('POST /orchestrator/pipelinely-handover', () => {
  it('200: stages /pipelinely-handover (submit:false) into ORCHESTRATOR_TMUX, exactly once', async () => {
    const res = await postOrchestratorHandover()
    expect(res.status).toBe(200)
    expect(await tmuxWriteCalls()).toEqual([[ORCHESTRATOR_TMUX_NAME, '/pipelinely-handover', { submit: false }]])
  })

  it('503 with no ORCHESTRATOR_TMUX recorded; nothing written', async () => {
    await fs.rm(path.join(handle.tmpDir, 'ORCHESTRATOR_TMUX'), { force: true })
    const res = await postOrchestratorHandover()
    expect(res.status).toBe(503)
    expect(await tmuxWriteCalls()).toEqual([])
  })

  it('409 naming the reason when the pane is showing a dialog', async () => {
    const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
    vi.mocked(writeTextToTmuxSession).mockResolvedValueOnce({ status: 'refused', reason: 'dialog-open' })

    const res = await postOrchestratorHandover()
    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe('dialog-open')
  })

  it('503 stray-process when the tmux pane has fallen back to a shell', async () => {
    const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
    vi.mocked(writeTextToTmuxSession).mockResolvedValueOnce({ status: 'refused', reason: 'stray-shell' })

    const res = await postOrchestratorHandover()
    expect(res.status).toBe(503)
  })
})
