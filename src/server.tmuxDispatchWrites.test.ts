import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { startTestServer, stopTestServer, type TestServerHandle } from './serverTestHarness.js'

// The server half of tech-design.md (tmux-dispatch-writes-plan): every route
// that types into a session writes through writeTextToTmuxSession and NEVER
// through an AppleScript keystroke writer — not even as a fallback when the
// tmux path refuses or fails, and there is no flag to turn that off. Same
// main()-based harness and seed hook as server.handover.test.ts; focusTab and
// tmuxPaneWrite are both mocked, so no osascript and no tmux can run.
// focusTab's mock deliberately has NO keystroke writers: if the server still
// imported one, the call would throw rather than quietly type.

const SLUG = 'tmux-write-task'
const SLUG_WITHOUT_TMUX = 'tab-only-task'
const ORCHESTRATOR_TMUX_NAME = 'orchestrator'

vi.mock('./tmuxPaneWrite.js', () => ({
  writeTextToTmuxSession: vi.fn(async (_session: string, _text: string, _options: { submit: boolean }) => ({ status: 'ok', paneId: '%7' })),
}))

vi.mock('./focusTab.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./focusTab.js')>()
  return {
    focusITermTab: vi.fn(async () => undefined),
    tmuxSessionExists: vi.fn(async () => true),
    findSessionAttachedToTmux: vi.fn(async () => 'attached-tab-id'),
    reattachAndRecord: vi.fn(async () => null),
    reattachOrFocus: vi.fn(async () => 'none' as const),
    openVSCode: vi.fn(async () => undefined),
    openBrowserUrl: vi.fn(async () => undefined),
    openAnnotationSession: vi.fn(async () => ({ status: 'error' as const, error: 'not exercised in this suite' })),
    getLiveSessionIds: vi.fn(async () => null),
    getLiveTmuxSessions: vi.fn(async () => new Set<string>()),
    normalizeWhitespace: actual.normalizeWhitespace,
    SAFE_TMUX_SESSION_NAME: actual.SAFE_TMUX_SESSION_NAME,
  }
})

let handle: TestServerHandle
let baseUrl: string

async function seedTask(tmpDir: string, slug: string, tmuxSession: string | null): Promise<void> {
  const dir = path.join(tmpDir, slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'TASK.md'), `# ${slug}\n`)
  await fs.writeFile(path.join(dir, 'STATUS'), 'waiting: needs input\n')
  await fs.writeFile(path.join(dir, 'ITERM_SESSION'), `${slug}-tab-id`)
  if (tmuxSession) await fs.writeFile(path.join(dir, 'TMUX_SESSION'), tmuxSession)
}

beforeAll(async () => {
  handle = await startTestServer({ COCKPIT_DISPATCH_ENABLED: '1' }, async (tmpDir) => {
    await seedTask(tmpDir, SLUG, `worker-${SLUG}`)
    await seedTask(tmpDir, SLUG_WITHOUT_TMUX, null)
  })
  baseUrl = `http://127.0.0.1:${handle.boundPort}`
})

afterAll(async () => {
  await stopTestServer(handle, ['COCKPIT_DISPATCH_ENABLED'])
})

beforeEach(async () => {
  const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
  vi.mocked(writeTextToTmuxSession).mockClear()
  const { focusITermTab, findSessionAttachedToTmux, reattachAndRecord } = await import('./focusTab.js')
  vi.mocked(focusITermTab).mockClear()
  vi.mocked(findSessionAttachedToTmux).mockClear()
  vi.mocked(reattachAndRecord).mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  await fs.writeFile(path.join(handle.tmpDir, 'ORCHESTRATOR_SESSION'), 'recorded-tab-id')
  await fs.writeFile(path.join(handle.tmpDir, 'ORCHESTRATOR_TMUX'), ORCHESTRATOR_TMUX_NAME)
})

function post(route: string, body?: unknown) {
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function tmuxWriteCalls() {
  const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
  return vi.mocked(writeTextToTmuxSession).mock.calls
}

describe('orchestrator routes write through tmux only', () => {
  it('/backlog/dispatch submits into ORCHESTRATOR_TMUX, and does not steal focus', async () => {
    const res = await post('/backlog/dispatch', { description: 'fix the thing' })
    expect(res.status).toBe(200)
    expect(await tmuxWriteCalls()).toEqual([[ORCHESTRATOR_TMUX_NAME, "Let's do this backlog item: fix the thing", { submit: true }]])
    const { focusITermTab } = await import('./focusTab.js')
    expect(focusITermTab).not.toHaveBeenCalled()
  })

  it('/help/pipelinely-feedback stages (submit:false) and then brings the tab attached to that tmux session forward, re-recording it', async () => {
    const res = await post('/help/pipelinely-feedback', { message: 'a note' })
    expect(res.status).toBe(200)
    expect(await tmuxWriteCalls()).toEqual([[ORCHESTRATOR_TMUX_NAME, '/pipelinely-feedback a note', { submit: false }]])
    const { focusITermTab } = await import('./focusTab.js')
    expect(vi.mocked(focusITermTab).mock.calls.map((call) => call[1])).toEqual(['attached-tab-id'])
    expect((await fs.readFile(path.join(handle.tmpDir, 'ORCHESTRATOR_SESSION'), 'utf-8')).trim()).toBe('attached-tab-id')
  })

  it('/orchestrator/pipelinely-handover stages /pipelinely-handover through tmux', async () => {
    const res = await post('/orchestrator/pipelinely-handover')
    expect(res.status).toBe(200)
    expect(await tmuxWriteCalls()).toEqual([[ORCHESTRATOR_TMUX_NAME, '/pipelinely-handover', { submit: false }]])
  })

  // The route behind every "Start <stage>" click, including the Fix conflicts
  // CTA's merge-conflicts stage (#150) — the one orchestrator stage auto mode
  // never dispatches, so this click is its only path.
  it('/stage-skill/:slug (orchestrator target, merge-conflicts) stages through tmux and focuses the attached tab', async () => {
    const res = await post('/stage-skill/conflicting-task', { stage: 'merge-conflicts' })
    expect(res.status).toBe(200)
    expect(await tmuxWriteCalls()).toEqual([[ORCHESTRATOR_TMUX_NAME, '/pipelinely-merge-conflicts conflicting-task', { submit: false }]])
    const { focusITermTab } = await import('./focusTab.js')
    expect(vi.mocked(focusITermTab).mock.calls.map((call) => call[1])).toEqual(['attached-tab-id'])
  })

  it('writes while holding the orchestrator pointer lock', async () => {
    const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
    let lockHeldDuringWrite = false
    vi.mocked(writeTextToTmuxSession).mockImplementationOnce(async () => {
      lockHeldDuringWrite = await fs.access(path.join(handle.tmpDir, '.orchestrator-pointer.lock')).then(() => true, () => false)
      return { status: 'ok', paneId: '%7' }
    })
    const res = await post('/backlog/dispatch', { description: 'locked' })
    expect(res.status).toBe(200)
    expect(lockHeldDuringWrite).toBe(true)
  })

  it('no ORCHESTRATOR_TMUX recorded: refuses with 503 and logs', async () => {
    await fs.rm(path.join(handle.tmpDir, 'ORCHESTRATOR_TMUX'), { force: true })
    const res = await post('/backlog/dispatch', { description: 'no tmux' })
    expect(res.status).toBe(503)
    expect(await tmuxWriteCalls()).toEqual([])
    expect(console.error).toHaveBeenCalled()
  })

  it('a pane that fell back to a shell maps to the existing stray-process 503', async () => {
    const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
    vi.mocked(writeTextToTmuxSession).mockResolvedValueOnce({ status: 'refused', reason: 'stray-shell' })
    const res = await post('/backlog/dispatch', { description: 'stray' })
    expect(res.status).toBe(503)
  })

  it('a pane showing a dialog is a 409 naming the reason', async () => {
    const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
    vi.mocked(writeTextToTmuxSession).mockResolvedValueOnce({ status: 'refused', reason: 'dialog-open' })
    const res = await post('/help/pipelinely-feedback', { message: 'during a dialog' })
    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe('dialog-open')
  })

  it.each(['unsafe-text', 'unsafe-session-name'] as const)('a %s refusal is a non-retryable 500 naming the reason, not a "click again" 409', async (reason) => {
    const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
    vi.mocked(writeTextToTmuxSession).mockResolvedValueOnce({ status: 'refused', reason })
    const res = await post('/backlog/dispatch', { description: 'bad input' })
    expect(res.status).toBe(500)
    expect((await res.json()).reason).toBe(reason)
    expect(console.error).toHaveBeenCalled()
  })

  it('a missing pane is a 503', async () => {
    const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
    vi.mocked(writeTextToTmuxSession).mockResolvedValueOnce({ status: 'refused', reason: 'no-pane' })
    const res = await post('/backlog/dispatch', { description: 'gone' })
    expect(res.status).toBe(503)
  })

  it('a paste that landed but whose Enter failed is a 500 naming the step, logged, with no retry', async () => {
    const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
    vi.mocked(writeTextToTmuxSession).mockResolvedValueOnce({ status: 'failed', step: 'submit', error: 'timed out' })
    const res = await post('/backlog/dispatch', { description: 'half' })
    expect(res.status).toBe(500)
    expect((await res.json()).step).toBe('submit')
    expect(await tmuxWriteCalls()).toHaveLength(1)
    expect(console.error).toHaveBeenCalled()
  })
})

describe('orchestrator routes — the rest of the write surface', () => {
  it('/batch-dispatch stages the combined command (submit:false) and focuses the attached tab', async () => {
    const res = await post('/batch-dispatch', { kind: 'wave', slugs: ['parent-m1', 'parent-m2'] })
    expect(res.status).toBe(200)
    const calls = await tmuxWriteCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe(ORCHESTRATOR_TMUX_NAME)
    expect(calls[0][1]).toContain('/pipelinely-dev parent-m1')
    expect(calls[0][2]).toEqual({ submit: false })
    const { focusITermTab } = await import('./focusTab.js')
    expect(vi.mocked(focusITermTab).mock.calls.map((call) => call[1])).toEqual(['attached-tab-id'])
  })

  it('the /focus/:slug fallback (session and tmux session both gone) sends into the orchestrator without focusing', async () => {
    const res = await post(`/focus/${SLUG}`)
    expect(res.status).toBe(202)
    const calls = await tmuxWriteCalls()
    expect(calls.map((call) => [call[0], call[2]])).toEqual([[ORCHESTRATOR_TMUX_NAME, { submit: true }]])
    const { focusITermTab } = await import('./focusTab.js')
    expect(focusITermTab).not.toHaveBeenCalled()
  })

  it('writes even when no ORCHESTRATOR_SESSION is recorded: the tmux session is the identity, not the iTerm tab id', async () => {
    await fs.rm(path.join(handle.tmpDir, 'ORCHESTRATOR_SESSION'), { force: true })
    const res = await post('/backlog/dispatch', { description: 'no tab recorded' })
    expect(res.status).toBe(200)
    expect(await tmuxWriteCalls()).toHaveLength(1)
  })

  it('a recorded tab id that is not attached to the tmux session is never written to or reattached', async () => {
    const { findSessionAttachedToTmux, reattachAndRecord } = await import('./focusTab.js')
    vi.mocked(findSessionAttachedToTmux).mockResolvedValueOnce(null)
    const res = await post('/backlog/dispatch', { description: 'no attached tab' })
    expect(res.status).toBe(200)
    expect(reattachAndRecord).not.toHaveBeenCalled()
  })

  it('text that landed but whose tab could not be surfaced is still a 200, and the failure is logged', async () => {
    const { findSessionAttachedToTmux } = await import('./focusTab.js')
    vi.mocked(findSessionAttachedToTmux).mockRejectedValueOnce(new Error('osascript blew up'))
    const res = await post('/help/pipelinely-feedback', { message: 'tab lookup fails' })
    expect(res.status).toBe(200)
    expect(await tmuxWriteCalls()).toHaveLength(1)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('could not surface its tab'), expect.any(Error))
  })

  it('COCKPIT_TMUX_DISPATCH_WRITES no longer selects a backend: set to 0 it still writes through tmux', async () => {
    vi.stubEnv('COCKPIT_TMUX_DISPATCH_WRITES', '0')
    try {
      const res = await post('/backlog/dispatch', { description: 'flag is gone' })
      expect(res.status).toBe(200)
      expect(await tmuxWriteCalls()).toHaveLength(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('a not-tmux-backed 503 names tmux but no longer a flag', async () => {
    await fs.rm(path.join(handle.tmpDir, 'ORCHESTRATOR_TMUX'), { force: true })
    const res = await post('/backlog/dispatch', { description: 'no tmux' })
    expect(res.status).toBe(503)
    const { error } = await res.json()
    expect(error).toContain('tmux')
    expect(error).not.toContain('COCKPIT_TMUX_DISPATCH_WRITES')
  })
})

describe('a task\'s own session writes through its TMUX_SESSION', () => {
  it('/pipelinely-handover/:slug stages into the task\'s tmux session', async () => {
    const res = await post(`/pipelinely-handover/${SLUG}`)
    expect(res.status).toBe(200)
    expect(await tmuxWriteCalls()).toEqual([[`worker-${SLUG}`, '/pipelinely-handover', { submit: false }]])
  })

  it('/stage-skill/:slug (own-session target, qa-fixes) stages into the task\'s tmux session', async () => {
    const res = await post(`/stage-skill/${SLUG}`, { stage: 'qa-fixes' })
    expect(res.status).toBe(200)
    expect(await tmuxWriteCalls()).toEqual([[`worker-${SLUG}`, '/pipelinely-qa-fixes', { submit: false }]])
  })

  it('a task pane that fell back to a shell is a 503 (the own-session stray-shell gap closes)', async () => {
    const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
    vi.mocked(writeTextToTmuxSession).mockResolvedValueOnce({ status: 'refused', reason: 'stray-shell' })
    const res = await post(`/stage-skill/${SLUG}`, { stage: 'qa-fixes' })
    expect(res.status).toBe(503)
  })

  it('a task with no TMUX_SESSION is refused with 503 — no keystroke fallback', async () => {
    const res = await post(`/pipelinely-handover/${SLUG_WITHOUT_TMUX}`)
    expect(res.status).toBe(503)
    expect(await tmuxWriteCalls()).toEqual([])
  })
})
