import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { startTestServer, stopTestServer, type TestServerHandle } from './serverTestHarness.js'

// Proves the server half of tech-design-help-feedback-tab.md's "stage,
// don't send" decision and its newline decision: POST /help/pipelinely-feedback stages
// (submit:false) through writeTextToTmuxSession into ORCHESTRATOR_TMUX,
// composes `/pipelinely-feedback <message>` with normalizeWhitespace applied to the
// message, and validates the body the way /backlog/dispatch does — same
// harness shape as server.handover.test.ts.

const ORCHESTRATOR_TMUX_NAME = 'orchestrator'

vi.mock('./tmuxPaneWrite.js', () => ({
  writeTextToTmuxSession: vi.fn(async (_session: string, _text: string, _options: { submit: boolean }) => ({ status: 'ok', paneId: '%7' })),
}))

vi.mock('./focusTab.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./focusTab.js')>()
  return {
    tmuxSessionExists: vi.fn(async () => true),
    findSessionAttachedToTmux: vi.fn(async () => 'attached-tab-id'),
    focusITermTab: vi.fn(async () => undefined),
    reattachAndRecord: vi.fn(async () => null),
    reattachOrFocus: vi.fn(async () => 'none' as const),
    openVSCode: vi.fn(async () => undefined),
    openBrowserUrl: vi.fn(async () => undefined),
    openAnnotationSession: vi.fn(async () => ({ status: 'error' as const, error: 'not exercised in this suite' })),
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
  const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
  vi.mocked(writeTextToTmuxSession).mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  await fs.writeFile(path.join(handle.tmpDir, 'ORCHESTRATOR_TMUX'), ORCHESTRATOR_TMUX_NAME)
})

async function tmuxWriteCalls() {
  const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
  return vi.mocked(writeTextToTmuxSession).mock.calls
}

function postFeedback(message: unknown) {
  return fetch(`${baseUrl}/help/pipelinely-feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })
}

describe('POST /help/pipelinely-feedback', () => {
  it('200: stages /pipelinely-feedback <message> (submit:false) into the recorded tmux session, exactly once', async () => {
    const res = await postFeedback('the stepper collapses the wrong node')
    expect(res.status).toBe(200)
    expect(await tmuxWriteCalls()).toEqual([[ORCHESTRATOR_TMUX_NAME, '/pipelinely-feedback the stepper collapses the wrong node', { submit: false }]])
  })

  it.each([
    ['a newline', 'line one\nline two', '/pipelinely-feedback line one line two'],
    ['a CRLF', 'line one\r\nline two', '/pipelinely-feedback line one line two'],
    ['a tab', 'a\tb', '/pipelinely-feedback a b'],
    ['runs of spaces', 'a    b', '/pipelinely-feedback a b'],
  ])('collapses %s into one single-space-joined line before staging', async (_label, message, expected) => {
    const res = await postFeedback(message)
    expect(res.status).toBe(200)
    expect((await tmuxWriteCalls())[0][1]).toBe(expected)
  })

  it.each([
    ['missing', undefined],
    ['non-string', 42],
    ['empty', ''],
    ['whitespace-only', '   \n  '],
  ])('400 for a %s message; nothing written', async (_label, message) => {
    const res = await postFeedback(message)
    expect(res.status).toBe(400)
    expect(await tmuxWriteCalls()).toEqual([])
  })

  it('503 with no ORCHESTRATOR_TMUX recorded; nothing written, and logged', async () => {
    await fs.rm(path.join(handle.tmpDir, 'ORCHESTRATOR_TMUX'), { force: true })
    const res = await postFeedback('a message')
    expect(res.status).toBe(503)
    expect(await tmuxWriteCalls()).toEqual([])
    expect(console.error).toHaveBeenCalled()
  })

  it('409 naming the reason when the pane is showing a dialog', async () => {
    const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
    vi.mocked(writeTextToTmuxSession).mockResolvedValueOnce({ status: 'refused', reason: 'dialog-open' })

    const res = await postFeedback('a message')
    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe('dialog-open')
  })

  it('500 when writeTextToTmuxSession rejects, and logs it', async () => {
    const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
    vi.mocked(writeTextToTmuxSession).mockRejectedValueOnce(new Error('boom'))

    const res = await postFeedback('a message')
    expect(res.status).toBe(500)
    expect(console.error).toHaveBeenCalled()
  })
})
