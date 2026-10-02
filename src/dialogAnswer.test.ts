import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { readSessionDialog } from './approvalWatch.js'
import type { ApprovalPrompt } from './approvalPrompt.js'
import {
  answerDialog,
  keysForChoice,
  CONFIRM_ATTEMPTS,
  type DialogAnswerContext,
  type DialogAnswerDeps,
  type DialogAnswerInput,
  type DialogAuditEntry,
} from './dialogAnswer.js'

const SESSION = 'worker-foo'
const PANE_ID = '%7'
const FIXED_NOW = new Date('2026-10-02T12:00:00.000Z')

const dialogPane = (overrides: { above?: string[]; question?: string; optionCount?: number; pointerRow?: number } = {}) => {
  const labels = ['Yes', "Yes, and don't ask again", 'No']
  const optionCount = overrides.optionCount ?? 3
  const pointerRow = overrides.pointerRow ?? 1
  return [
    ...(overrides.above ?? ['some output']),
    '─'.repeat(40),
    ' Bash command',
    '',
    '   npm test',
    '',
    ` ${overrides.question ?? 'Do you want to proceed?'}`,
    ...labels.slice(0, optionCount).map((label, i) => `${i + 1 === pointerRow ? ' ❯' : '  '} ${i + 1}. ${label}`),
    '',
    ' Esc to cancel',
  ].join('\n')
}
const QUIET_PANE = '❯ \n  ? for shortcuts'

const publishedFrom = async (paneText: string, session = SESSION): Promise<ApprovalPrompt> => {
  const prompt = await readSessionDialog('%x', session, { capturePane: async () => paneText })
  if (!prompt) throw new Error('fixture pane is not a dialog')
  return prompt
}

type PaneStep = string | Error

describe('keysForChoice', () => {
  const prompt = { options: [{ number: 1, label: 'Yes' }, { number: 3, label: 'No' }] } as ApprovalPrompt

  it('types a visible option number as literal text', () => {
    expect(keysForChoice(3, prompt)).toEqual(['-l', '3'])
  })

  it('maps cancel to Escape', () => {
    expect(keysForChoice('cancel', prompt)).toEqual(['Escape'])
  })

  it.each([2, 4, 0, -1, 1.5, Number.NaN])('refuses %s, which is not a visible option', (choice) => {
    expect(keysForChoice(choice, prompt)).toBeNull()
  })

  it('never produces Enter or more than one key', () => {
    for (const choice of [1, 3, 'cancel'] as const) {
      const keys = keysForChoice(choice, prompt)!
      expect(keys.join(' ')).not.toMatch(/enter|return|\bC-m\b|\n|\r/i)
      expect(keys.filter((key) => key !== '-l')).toHaveLength(1)
    }
  })
})

describe('answerDialog', () => {
  let paneSteps: PaneStep[]
  let calls: string[]
  let audit: DialogAuditEntry[]
  let deps: DialogAnswerDeps
  let sendKeys: Mock<DialogAnswerDeps['sendKeys']>
  let appendAudit: Mock<DialogAnswerDeps['appendAudit']>
  let capturePane: Mock<DialogAnswerDeps['capturePane']>
  let logInfo: Mock<DialogAnswerDeps['logInfo']>
  let logError: Mock<DialogAnswerDeps['logError']>
  let liveSessions: Set<string> | null
  let orchestratorTmux: string | Error | null
  let resolvedPane: string | null
  let published: ApprovalPrompt
  let task: DialogAnswerContext['tasks'][number]
  let context: DialogAnswerContext
  let input: DialogAnswerInput

  // The last scripted step repeats, so "the dialog stays" needs one entry.
  const nextPane = async (): Promise<string> => {
    const step = paneSteps.length > 1 ? paneSteps.shift()! : paneSteps[0]
    if (step instanceof Error) throw step
    return step
  }

  beforeEach(async () => {
    calls = []
    audit = []
    paneSteps = [dialogPane()]
    liveSessions = new Set([SESSION])
    orchestratorTmux = 'claude-orchestrator'
    resolvedPane = PANE_ID
    task = { slug: 'foo', status: 'working', tmuxSession: null }
    published = await publishedFrom(dialogPane())
    context = { publishedPrompt: published, tasks: [task] }
    input = { slug: 'foo', session: SESSION, choice: 2, fingerprint: published.fingerprint, peer: '127.0.0.1', userAgent: 'vitest' }
    sendKeys = vi.fn<DialogAnswerDeps['sendKeys']>(async () => { calls.push('send') })
    appendAudit = vi.fn<DialogAnswerDeps['appendAudit']>(async (_slug, entry) => { calls.push(`audit:${entry.phase}`); audit.push(entry) })
    capturePane = vi.fn<DialogAnswerDeps['capturePane']>(async () => { calls.push('capture'); return nextPane() })
    logInfo = vi.fn<DialogAnswerDeps['logInfo']>()
    logError = vi.fn<DialogAnswerDeps['logError']>()
    deps = {
      listSessions: async () => liveSessions,
      readOrchestratorTmux: async () => {
        if (orchestratorTmux instanceof Error) throw orchestratorTmux
        return orchestratorTmux
      },
      resolvePane: async () => resolvedPane,
      capturePane,
      sendKeys,
      appendAudit,
      logInfo,
      logError,
      waitForPane: async () => undefined,
      now: () => FIXED_NOW,
    }
  })

  const run = () => answerDialog(task, input, context, deps)

  describe('happy path', () => {
    it('sends exactly the chosen digit to the pinned pane and reports answered once the dialog is gone', async () => {
      paneSteps = [dialogPane(), QUIET_PANE]
      expect(await run()).toEqual({ outcome: 'answered' })
      expect(sendKeys).toHaveBeenCalledTimes(1)
      expect(sendKeys).toHaveBeenCalledWith(PANE_ID, ['-l', '2'])
    })

    it('captures the pinned pane id, not the session name', async () => {
      paneSteps = [dialogPane(), QUIET_PANE]
      await run()
      expect(capturePane.mock.calls.map(([target]) => target)).toEqual([PANE_ID, PANE_ID])
    })

    it('sends exactly Escape for cancel', async () => {
      paneSteps = [dialogPane(), QUIET_PANE]
      input = { ...input, choice: 'cancel' }
      expect(await run()).toEqual({ outcome: 'answered' })
      expect(sendKeys).toHaveBeenCalledWith(PANE_ID, ['Escape'])
    })

    it('answers a secondary session the task owns', async () => {
      const secondary = 'worker-foo-cr2'
      liveSessions = new Set([secondary])
      published = await publishedFrom(dialogPane(), secondary)
      context = { publishedPrompt: published, tasks: [task] }
      input = { ...input, session: secondary, fingerprint: published.fingerprint }
      paneSteps = [dialogPane(), QUIET_PANE]
      expect(await run()).toEqual({ outcome: 'answered' })
    })

    it('reports answered when the next dialog has a different fingerprint', async () => {
      paneSteps = [dialogPane(), dialogPane({ question: 'Do you want to make this edit?' })]
      expect(await run()).toEqual({ outcome: 'answered' })
    })

    it('answers a task whose TMUX_SESSION names the session exactly', async () => {
      const custom = 'my-own-session'
      task = { slug: 'foo', status: 'working', tmuxSession: custom }
      liveSessions = new Set([custom])
      published = await publishedFrom(dialogPane(), custom)
      context = { publishedPrompt: published, tasks: [task] }
      input = { ...input, session: custom, fingerprint: published.fingerprint }
      paneSteps = [dialogPane(), QUIET_PANE]
      expect(await run()).toEqual({ outcome: 'answered' })
    })
  })

  describe('S2: only the dialog the user saw', () => {
    it('refuses with no-dialog when the server publishes none for the task', async () => {
      context = { ...context, publishedPrompt: null }
      expect(await run()).toEqual({ outcome: 'refused', reason: 'no-dialog' })
      expect(capturePane).not.toHaveBeenCalled()
      expect(sendKeys).not.toHaveBeenCalled()
    })

    it('refuses with dialog-changed when the published prompt is for another session', async () => {
      context = { ...context, publishedPrompt: { ...published, session: 'worker-foo-cr2' } }
      expect(await run()).toEqual({ outcome: 'refused', reason: 'dialog-changed' })
      expect(capturePane).not.toHaveBeenCalled()
      expect(sendKeys).not.toHaveBeenCalled()
    })

    it('refuses with dialog-changed when the click carries a different fingerprint', async () => {
      input = { ...input, fingerprint: '0000000000000000' }
      expect(await run()).toEqual({ outcome: 'refused', reason: 'dialog-changed' })
      expect(capturePane).not.toHaveBeenCalled()
      expect(sendKeys).not.toHaveBeenCalled()
    })

    it('refuses with dialog-changed when the pane now asks a different question', async () => {
      paneSteps = [dialogPane({ question: 'Do you want to delete everything?' })]
      expect(await run()).toEqual({ outcome: 'refused', reason: 'dialog-changed' })
      expect(sendKeys).not.toHaveBeenCalled()
    })

    it('refuses an identical dialog whose transcript context changed (the same question asked again later)', async () => {
      paneSteps = [dialogPane({ above: ['new tool output'] })]
      expect(await run()).toEqual({ outcome: 'refused', reason: 'dialog-changed' })
      expect(sendKeys).not.toHaveBeenCalled()
    })

    it('refuses with no-dialog when the pane no longer shows a dialog', async () => {
      paneSteps = [QUIET_PANE]
      expect(await run()).toEqual({ outcome: 'refused', reason: 'no-dialog' })
      expect(sendKeys).not.toHaveBeenCalled()
    })

    it('refuses with no-dialog when the active pane cannot be resolved', async () => {
      resolvedPane = null
      expect(await run()).toEqual({ outcome: 'refused', reason: 'no-dialog' })
      expect(capturePane).not.toHaveBeenCalled()
      expect(sendKeys).not.toHaveBeenCalled()
    })
  })

  describe('S3: exactly the chosen key', () => {
    it('refuses an option number the re-captured dialog does not show', async () => {
      input = { ...input, choice: 4 }
      expect(await run()).toEqual({ outcome: 'refused', reason: 'unknown-option' })
      expect(sendKeys).not.toHaveBeenCalled()
    })
  })

  describe('S13: only this task\'s worker', () => {
    const expectNothingTouched = () => {
      expect(capturePane).not.toHaveBeenCalled()
      expect(sendKeys).not.toHaveBeenCalled()
      expect(appendAudit).not.toHaveBeenCalled()
    }

    it("refuses another task's session", async () => {
      const other = { slug: 'bar', status: 'working' as const, tmuxSession: null }
      context = { ...context, tasks: [task, other] }
      liveSessions = new Set(['worker-bar'])
      published = await publishedFrom(dialogPane(), 'worker-bar')
      context = { ...context, publishedPrompt: published }
      input = { ...input, session: 'worker-bar', fingerprint: published.fingerprint }
      expect(await run()).toEqual({ outcome: 'refused', reason: 'session-not-owned' })
      expectNothingTouched()
    })

    it("does not mistake a longer slug's worker for the shorter slug's", async () => {
      const longer = { slug: 'foo-bar', status: 'working' as const, tmuxSession: null }
      context = { ...context, tasks: [task, longer] }
      liveSessions = new Set(['worker-foo-bar'])
      published = await publishedFrom(dialogPane(), 'worker-foo-bar')
      context = { ...context, publishedPrompt: published }
      input = { ...input, session: 'worker-foo-bar', fingerprint: published.fingerprint }
      expect(await run()).toEqual({ outcome: 'refused', reason: 'session-not-owned' })
      expectNothingTouched()
    })

    it("refuses a done task's lingering session that only a shorter active slug would claim", async () => {
      const finished = { slug: 'foo-bar', status: 'done' as const, tmuxSession: null }
      context = { ...context, tasks: [task, finished] }
      liveSessions = new Set(['worker-foo-bar-cr'])
      published = await publishedFrom(dialogPane(), 'worker-foo-bar-cr')
      context = { ...context, publishedPrompt: published }
      input = { ...input, session: 'worker-foo-bar-cr', fingerprint: published.fingerprint }
      expect(await run()).toEqual({ outcome: 'refused', reason: 'session-not-owned' })
      expectNothingTouched()
    })

    it('refuses the orchestrator session even when a task claims it as its TMUX_SESSION', async () => {
      task = { slug: 'foo', status: 'working', tmuxSession: 'claude-orchestrator' }
      liveSessions = new Set(['claude-orchestrator'])
      published = await publishedFrom(dialogPane(), 'claude-orchestrator')
      context = { publishedPrompt: published, tasks: [task] }
      input = { ...input, session: 'claude-orchestrator', fingerprint: published.fingerprint }
      expect(await run()).toEqual({ outcome: 'refused', reason: 'session-not-owned' })
      expectNothingTouched()
    })

    it('fails closed and logs when ORCHESTRATOR_TMUX cannot be read', async () => {
      orchestratorTmux = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      expect(await run()).toMatchObject({ outcome: 'failed', reason: 'capture-failed' })
      expect(logError).toHaveBeenCalled()
      expectNothingTouched()
    })

    it('answers when ORCHESTRATOR_TMUX is absent', async () => {
      orchestratorTmux = null
      paneSteps = [dialogPane(), QUIET_PANE]
      expect(await run()).toEqual({ outcome: 'answered' })
    })

    it('refuses an orchestrator-like claude-* session that belongs to no task', async () => {
      liveSessions = new Set(['claude-12'])
      published = await publishedFrom(dialogPane(), 'claude-12')
      context = { ...context, publishedPrompt: published }
      input = { ...input, session: 'claude-12', fingerprint: published.fingerprint }
      expect(await run()).toEqual({ outcome: 'refused', reason: 'session-not-owned' })
      expectNothingTouched()
    })

    it('refuses a session that is not live', async () => {
      liveSessions = new Set()
      expect(await run()).toEqual({ outcome: 'refused', reason: 'session-not-owned' })
      expectNothingTouched()
    })

    it('refuses when tmux has no server', async () => {
      liveSessions = null
      expect(await run()).toEqual({ outcome: 'refused', reason: 'session-not-owned' })
      expectNothingTouched()
    })

    it.each(['done', 'shelved'] as const)('refuses a %s task', async (status) => {
      task = { ...task, status }
      context = { ...context, tasks: [] }
      expect(await run()).toEqual({ outcome: 'refused', reason: 'session-not-owned' })
      expectNothingTouched()
    })
  })

  describe('S9: one send per session at a time', () => {
    it('lets one of two concurrent answers through and reports the other busy', async () => {
      paneSteps = [dialogPane(), QUIET_PANE]
      const [first, second] = await Promise.all([run(), run()])
      expect([first.outcome, second.outcome].sort()).toEqual(['answered', 'refused'])
      expect([first, second]).toContainEqual({ outcome: 'refused', reason: 'busy' })
      expect(sendKeys).toHaveBeenCalledTimes(1)
    })

    it('releases the session afterwards, even after a failure', async () => {
      sendKeys.mockRejectedValueOnce(new Error('boom'))
      expect(await run()).toMatchObject({ outcome: 'failed', reason: 'send-failed' })
      paneSteps = [dialogPane(), QUIET_PANE]
      expect(await run()).toEqual({ outcome: 'answered' })
    })
  })

  describe('S10: every request is logged, and a send follows a durable log entry', () => {
    it('writes the attempt, then the result, and logs one line', async () => {
      paneSteps = [dialogPane(), QUIET_PANE]
      await run()
      expect(audit.map((entry) => entry.phase)).toEqual(['attempt', 'result'])
      expect(audit[0]).toMatchObject({
        at: FIXED_NOW.toISOString(), slug: 'foo', session: SESSION, paneId: PANE_ID, choice: 2, keys: ['-l', '2'],
        question: 'Do you want to proceed?', fingerprint: published.fingerprint, peer: '127.0.0.1', userAgent: 'vitest',
      })
      expect(audit[1]).toMatchObject({ phase: 'result', outcome: 'answered' })
      expect(appendAudit).toHaveBeenCalledWith('foo', expect.anything())
      expect(logInfo).toHaveBeenCalledTimes(1)
      expect(logInfo.mock.calls[0][0]).toContain('[answerDialog]')
      expect(logInfo.mock.calls[0][0]).toContain(SESSION)
    })

    it('appends the attempt before the re-check capture and the send', async () => {
      paneSteps = [dialogPane(), QUIET_PANE]
      await run()
      expect(calls.slice(0, 3)).toEqual(['audit:attempt', 'capture', 'send'])
      expect(calls[calls.length - 1]).toBe('audit:result')
    })

    it('sends nothing when the attempt cannot be written', async () => {
      appendAudit.mockRejectedValueOnce(new Error('disk full'))
      expect(await run()).toMatchObject({ outcome: 'failed', reason: 'audit-failed' })
      expect(capturePane).not.toHaveBeenCalled()
      expect(sendKeys).not.toHaveBeenCalled()
      expect(logError).toHaveBeenCalled()
    })

    it('still returns the real outcome when the result entry cannot be written, and logs it', async () => {
      paneSteps = [dialogPane(), QUIET_PANE]
      appendAudit.mockImplementation(async (_slug, entry) => {
        if (entry.phase === 'result') throw new Error('disk full')
        audit.push(entry)
      })
      expect(await run()).toEqual({ outcome: 'answered' })
      expect(logError).toHaveBeenCalled()
    })

    it('stamps the result entry with when the outcome happened, not when the attempt began', async () => {
      const resultAt = new Date('2026-10-02T12:00:01.500Z')
      const now = vi.fn<DialogAnswerDeps['now']>().mockReturnValueOnce(FIXED_NOW).mockReturnValue(resultAt)
      deps = { ...deps, now }
      paneSteps = [dialogPane(), QUIET_PANE]
      await run()
      expect(audit.map((entry) => entry.at)).toEqual([FIXED_NOW.toISOString(), resultAt.toISOString()])
    })

    it('records the refusal reason on the result entry', async () => {
      paneSteps = [QUIET_PANE]
      await run()
      expect(audit[1]).toMatchObject({ phase: 'result', outcome: 'refused', reason: 'no-dialog' })
    })

    it('logs a refusal that never reached the audit log', async () => {
      context = { ...context, publishedPrompt: null }
      await run()
      expect(appendAudit).not.toHaveBeenCalled()
      expect(logInfo).toHaveBeenCalledTimes(1)
      expect(logInfo.mock.calls[0][0]).toContain('no-dialog')
    })
  })

  describe('S11: a failed or ambiguous send leaves the worker alone and says so', () => {
    it('reports send-failed after one send and never retries', async () => {
      sendKeys.mockRejectedValue(new Error('tmux: no such pane'))
      const result = await run()
      expect(result).toMatchObject({ outcome: 'failed', reason: 'send-failed' })
      expect(sendKeys).toHaveBeenCalledTimes(1)
      expect(logError).toHaveBeenCalled()
      expect(audit[1]).toMatchObject({ phase: 'result', outcome: 'failed', reason: 'send-failed' })
    })

    it('says the key may have been typed when the send times out', async () => {
      sendKeys.mockRejectedValue(Object.assign(new Error('Command timed out'), { timedOut: true }))
      const result = await run()
      expect(result).toMatchObject({ outcome: 'failed', reason: 'send-failed' })
      expect(result.outcome === 'failed' && result.error).toMatch(/may or may not have been typed/)
      expect(sendKeys).toHaveBeenCalledTimes(1)
    })

    it('reports unconfirmed, with no second send, when the same dialog is still showing after the confirm window', async () => {
      paneSteps = [dialogPane(), dialogPane({ pointerRow: 2 })]
      expect(await run()).toEqual({ outcome: 'unconfirmed' })
      expect(sendKeys).toHaveBeenCalledTimes(1)
      // one re-check capture plus the whole confirm window
      expect(capturePane).toHaveBeenCalledTimes(1 + CONFIRM_ATTEMPTS)
    })

    it('reports capture-failed and sends nothing when the re-check capture throws', async () => {
      paneSteps = [new Error('tmux timed out')]
      expect(await run()).toMatchObject({ outcome: 'failed', reason: 'capture-failed' })
      expect(sendKeys).not.toHaveBeenCalled()
      expect(logError).toHaveBeenCalled()
    })

    it('never reports answered when the capture fails during confirmation', async () => {
      paneSteps = [dialogPane(), new Error('pane vanished')]
      expect(await run()).toEqual({ outcome: 'unconfirmed' })
      expect(sendKeys).toHaveBeenCalledTimes(1)
    })

    it('reports unconfirmed, never "nothing was sent", when a step after the send throws', async () => {
      deps = { ...deps, waitForPane: async () => { throw new Error('timer failed') } }
      expect(await run()).toEqual({ outcome: 'unconfirmed' })
      expect(sendKeys).toHaveBeenCalledTimes(1)
      expect(logError).toHaveBeenCalledWith(expect.stringContaining('timer failed'))
      expect(audit[1]).toMatchObject({ phase: 'result', outcome: 'unconfirmed' })
    })

    it('still reports capture-failed for a throw before the send', async () => {
      deps = { ...deps, resolvePane: async () => { throw new Error('tmux gone') } }
      expect(await run()).toMatchObject({ outcome: 'failed', reason: 'capture-failed' })
      expect(sendKeys).not.toHaveBeenCalled()
    })

    it('waits between confirm captures', async () => {
      const waitForPane = vi.fn(async () => undefined)
      deps = { ...deps, waitForPane }
      paneSteps = [dialogPane(), QUIET_PANE]
      await run()
      expect(waitForPane).toHaveBeenCalledTimes(1)
    })
  })
})
