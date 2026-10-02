import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { createApprovalPollState, createApprovalTicker, fingerprintPrompt, pollApprovalPrompts, readSessionDialog, type ApprovalPollState, type ApprovalWatchDeps } from './approvalWatch.js'
import { detectApprovalPrompt, isApprovalPollable, type ApprovalPrompt } from './approvalPrompt.js'

const DIALOG_PANE = [
  '─'.repeat(40),
  ' Bash command',
  '',
  '   npm test',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  '',
  ' Esc to cancel',
].join('\n')
const QUIET_PANE = '❯ \n  ? for shortcuts'

type PollTask = Parameters<typeof pollApprovalPrompts>[0][number]
const task = (slug: string, overrides: Partial<PollTask> = {}): PollTask => ({ slug, status: 'working', tmuxSession: null, ...overrides })

describe('isApprovalPollable', () => {
  it.each(['done', 'shelved'] as const)('is false for a %s task', (status) => {
    expect(isApprovalPollable({ status })).toBe(false)
  })

  it.each(['working', 'waiting', 'paused', 'review', 'handover'] as const)('is true for a %s task', (status) => {
    expect(isApprovalPollable({ status })).toBe(true)
  })
})

const dialogPane = (overrides: { above?: string[]; question?: string; command?: string; pointerRow?: 1 | 2; below?: string[] } = {}) => [
  ...(overrides.above ?? ['some output']),
  '─'.repeat(40),
  ' Bash command',
  '',
  `   ${overrides.command ?? 'npm test'}`,
  '',
  ` ${overrides.question ?? 'Do you want to proceed?'}`,
  `${overrides.pointerRow === 2 ? '  ' : ' ❯'} 1. Yes`,
  `${overrides.pointerRow === 2 ? ' ❯' : '  '} 2. No`,
  '',
  ' Esc to cancel',
  ...(overrides.below ?? []),
].join('\n')

describe('fingerprintPrompt', () => {
  const fingerprintOf = (paneText: string, session = 'worker-foo') => {
    const detected = detectApprovalPrompt(paneText)!
    return fingerprintPrompt(session, detected)
  }

  it('is a 16-char hex string, stable for the same dialog', () => {
    expect(fingerprintOf(dialogPane())).toMatch(/^[0-9a-f]{16}$/)
    expect(fingerprintOf(dialogPane())).toBe(fingerprintOf(dialogPane()))
  })

  it.each([
    ['question', dialogPane({ question: 'Do you want to run it?' })],
    ['summary', dialogPane({ command: 'npm run build' })],
    ['transcript context above the dialog', dialogPane({ above: ['newer output'] })],
  ])('changes when the %s changes', (_what, changed) => {
    expect(fingerprintOf(changed)).not.toBe(fingerprintOf(dialogPane()))
  })

  it('changes when the session changes', () => {
    expect(fingerprintOf(dialogPane(), 'worker-bar')).not.toBe(fingerprintOf(dialogPane()))
  })

  it('changes when an option changes', () => {
    expect(fingerprintOf(dialogPane().replace('2. No', '2. No, and tell Claude why'))).not.toBe(fingerprintOf(dialogPane()))
  })

  it('does not change when only the ❯ pointer moves', () => {
    expect(fingerprintOf(dialogPane({ pointerRow: 2 }))).toBe(fingerprintOf(dialogPane()))
  })

  it('does not change when only the status lines below the footer change', () => {
    expect(fingerprintOf(dialogPane({ below: ['⏵⏵ auto mode on'] }))).toBe(fingerprintOf(dialogPane()))
  })
})

describe('readSessionDialog', () => {
  it('captures the given target and returns the dialog with options and a fingerprint', async () => {
    const capturePane = vi.fn(async () => dialogPane())
    const prompt = await readSessionDialog('%3', 'worker-foo', { capturePane })
    expect(capturePane).toHaveBeenCalledWith('%3')
    expect(prompt).toMatchObject({ session: 'worker-foo', question: 'Do you want to proceed?', options: [{ number: 1, label: 'Yes' }, { number: 2, label: 'No' }] })
    expect(prompt?.fingerprint).toMatch(/^[0-9a-f]{16}$/)
  })

  it('never exposes the fingerprint context', async () => {
    const prompt = await readSessionDialog('%3', 'worker-foo', { capturePane: async () => dialogPane() })
    expect(prompt).not.toHaveProperty('context')
  })

  it('returns null for a pane that is not a dialog', async () => {
    expect(await readSessionDialog('%3', 'worker-foo', { capturePane: async () => QUIET_PANE })).toBeNull()
  })

  it('propagates a capture failure instead of reporting "no dialog"', async () => {
    await expect(readSessionDialog('%3', 'worker-foo', { capturePane: async () => { throw new Error('tmux gone') } })).rejects.toThrow('tmux gone')
  })
})

describe('pollApprovalPrompts', () => {
  let panes: Record<string, string | Error>
  let liveSessions: Set<string> | null
  let listError: Error | null
  let deps: ApprovalWatchDeps
  let state: ApprovalPollState
  let capturePane: Mock<ApprovalWatchDeps['capturePane']>
  let logError: Mock<ApprovalWatchDeps['logError']>

  beforeEach(() => {
    panes = {}
    liveSessions = new Set()
    listError = null
    state = createApprovalPollState()
    capturePane = vi.fn<ApprovalWatchDeps['capturePane']>(async (target: string) => {
      const session = target.replace(/^=/, '').replace(/:$/, '')
      const pane = panes[session]
      if (pane instanceof Error) throw pane
      return pane ?? QUIET_PANE
    })
    logError = vi.fn<ApprovalWatchDeps['logError']>()
    deps = { listSessions: async () => {
      if (listError) throw listError
      return liveSessions
    }, capturePane, logError }
  })

  it('reports the dialog for a task whose live session shows one', async () => {
    liveSessions = new Set(['worker-foo'])
    panes['worker-foo'] = DIALOG_PANE
    const result = await pollApprovalPrompts([task('foo')], deps, state)
    expect(result.get('foo')).toMatchObject({ session: 'worker-foo', question: 'Do you want to proceed?' })
  })

  it('publishes the options and fingerprint the answer route will check', async () => {
    liveSessions = new Set(['worker-foo'])
    panes['worker-foo'] = DIALOG_PANE
    const prompt = (await pollApprovalPrompts([task('foo')], deps, state)).get('foo')
    expect(prompt?.options).toEqual([{ number: 1, label: 'Yes' }, { number: 2, label: 'No' }])
    expect(prompt?.fingerprint).toBe(await readSessionDialog('=worker-foo:', 'worker-foo', { capturePane: async () => DIALOG_PANE }).then((fresh) => fresh?.fingerprint))
  })

  it('does not report a quiet session', async () => {
    liveSessions = new Set(['worker-foo'])
    expect((await pollApprovalPrompts([task('foo')], deps, state)).size).toBe(0)
  })

  it('polls only non-done, non-shelved tasks', async () => {
    liveSessions = new Set(['worker-a', 'worker-b', 'worker-c'])
    panes['worker-a'] = panes['worker-b'] = panes['worker-c'] = DIALOG_PANE
    const result = await pollApprovalPrompts([task('a', { status: 'done' }), task('b', { status: 'shelved' }), task('c', { status: 'waiting' })], deps, state)
    expect([...result.keys()]).toEqual(['c'])
    expect(capturePane).toHaveBeenCalledTimes(1)
  })

  it('captures only live sessions that belong to a task', async () => {
    liveSessions = new Set(['worker-foo', 'claude-orchestrator', 'worker-unknown'])
    await pollApprovalPrompts([task('foo'), task('dead')], deps, state)
    expect(capturePane.mock.calls.map(([target]) => target)).toEqual(['=worker-foo:'])
  })

  it('prefers the primary session over a secondary one', async () => {
    liveSessions = new Set(['worker-foo-cr2', 'worker-foo'])
    panes['worker-foo-cr2'] = panes['worker-foo'] = DIALOG_PANE
    const result = await pollApprovalPrompts([task('foo', { tmuxSession: 'worker-foo' })], deps, state)
    expect(result.get('foo')?.session).toBe('worker-foo')
  })

  it('reports a dialog that only a secondary session shows', async () => {
    liveSessions = new Set(['worker-foo', 'worker-foo-cr2'])
    panes['worker-foo-cr2'] = DIALOG_PANE
    const result = await pollApprovalPrompts([task('foo', { tmuxSession: 'worker-foo' })], deps, state)
    expect(result.get('foo')?.session).toBe('worker-foo-cr2')
  })

  it('returns an empty map without capturing or logging when tmux is unavailable', async () => {
    liveSessions = null
    expect((await pollApprovalPrompts([task('foo')], deps, state)).size).toBe(0)
    expect(capturePane).not.toHaveBeenCalled()
    expect(logError).not.toHaveBeenCalled()
  })


  it('does not attribute a done task\'s lingering session to an active task with a shorter slug', async () => {
    liveSessions = new Set(['worker-foo-bar-qa'])
    panes['worker-foo-bar-qa'] = DIALOG_PANE
    const result = await pollApprovalPrompts([task('foo'), task('foo-bar', { status: 'done' })], deps, state)
    expect(result.size).toBe(0)
    expect(capturePane).not.toHaveBeenCalled()
  })

  it('ignores an ordinary pane that merely mentions Esc to cancel', async () => {
    liveSessions = new Set(['worker-foo'])
    panes['worker-foo'] = 'Press Esc to cancel the build at any time.\n❯ \n  ? for shortcuts'
    expect((await pollApprovalPrompts([task('foo')], deps, state)).size).toBe(0)
  })

  describe('a failed tmux ls', () => {
    beforeEach(async () => {
      liveSessions = new Set(['worker-foo'])
      panes['worker-foo'] = DIALOG_PANE
      await pollApprovalPrompts([task('foo')], deps, state)
      listError = new Error('Command timed out after 2000 milliseconds')
    })

    it('logs the failure once across three ticks', async () => {
      for (let tick = 0; tick < 3; tick++) await pollApprovalPrompts([task('foo')], deps, state)
      expect(logError).toHaveBeenCalledTimes(1)
      expect(logError).toHaveBeenCalledWith('[approvalWatch] tmux ls failed: Command timed out after 2000 milliseconds')
    })

    it('keeps the callouts it already had instead of dropping them for a tick', async () => {
      const result = await pollApprovalPrompts([task('foo')], deps, state)
      expect(result.get('foo')?.session).toBe('worker-foo')
    })

    it("does not hand a finished task's kept callout to an active task with a shorter slug", async () => {
      liveSessions = new Set(['worker-foo-bar-cr'])
      panes['worker-foo-bar-cr'] = DIALOG_PANE
      listError = null
      await pollApprovalPrompts([task('foo'), task('foo-bar')], deps, state)
      listError = new Error('Command timed out after 2000 milliseconds')
      const result = await pollApprovalPrompts([task('foo'), task('foo-bar', { status: 'done' })], deps, state)
      expect(result.has('foo')).toBe(false)
    })

    it('logs again after a successful list, so a recurrence is reported', async () => {
      await pollApprovalPrompts([task('foo')], deps, state)
      listError = null
      await pollApprovalPrompts([task('foo')], deps, state)
      listError = new Error('Command timed out after 2000 milliseconds')
      await pollApprovalPrompts([task('foo')], deps, state)
      expect(logError).toHaveBeenCalledTimes(2)
    })
  })

  describe('a failed capture after a dialog was seen', () => {
    beforeEach(async () => {
      liveSessions = new Set(['worker-foo'])
      panes['worker-foo'] = DIALOG_PANE
      await pollApprovalPrompts([task('foo')], deps, state)
      panes['worker-foo'] = new Error('timed out')
    })

    it('keeps the callout while the capture keeps failing', async () => {
      const result = await pollApprovalPrompts([task('foo')], deps, state)
      expect(result.get('foo')?.session).toBe('worker-foo')
    })

    it('clears the callout once a capture succeeds with no dialog', async () => {
      panes['worker-foo'] = QUIET_PANE
      expect((await pollApprovalPrompts([task('foo')], deps, state)).size).toBe(0)
    })

    it('clears the callout when the session leaves tmux ls', async () => {
      liveSessions = new Set()
      expect((await pollApprovalPrompts([task('foo')], deps, state)).size).toBe(0)
    })
  })

  describe('capture failures', () => {
    beforeEach(() => {
      liveSessions = new Set(['worker-foo'])
      panes['worker-foo'] = new Error('timed out')
    })

    it('treats a failed capture as not blocked', async () => {
      expect((await pollApprovalPrompts([task('foo')], deps, state)).size).toBe(0)
    })

    it('logs the same failure once across three ticks', async () => {
      for (let tick = 0; tick < 3; tick++) await pollApprovalPrompts([task('foo')], deps, state)
      expect(logError).toHaveBeenCalledTimes(1)
      expect(logError).toHaveBeenCalledWith('[approvalWatch] capture-pane failed for worker-foo: timed out')
    })

    it('logs again when the failure message changes', async () => {
      await pollApprovalPrompts([task('foo')], deps, state)
      panes['worker-foo'] = new Error("can't find session")
      await pollApprovalPrompts([task('foo')], deps, state)
      expect(logError).toHaveBeenCalledTimes(2)
    })

    it('forgets the failure after a successful capture, so a recurrence is logged', async () => {
      await pollApprovalPrompts([task('foo')], deps, state)
      panes['worker-foo'] = QUIET_PANE
      await pollApprovalPrompts([task('foo')], deps, state)
      expect(state.failures.size).toBe(0)
      panes['worker-foo'] = new Error('timed out')
      await pollApprovalPrompts([task('foo')], deps, state)
      expect(logError).toHaveBeenCalledTimes(2)
    })

    it('forgets the failure when the session disappears from the list', async () => {
      await pollApprovalPrompts([task('foo')], deps, state)
      liveSessions = new Set()
      await pollApprovalPrompts([task('foo')], deps, state)
      expect(state.failures.size).toBe(0)
    })
  })
})

describe('createApprovalTicker', () => {
  const PROMPT_A = { session: 'worker-foo', question: 'Proceed?', summary: 'Proceed?', options: [{ number: 1, label: 'Yes' }, { number: 2, label: 'No' }], fingerprint: '0123456789abcdef' }
  let onChange: Mock<(prompts: Map<string, ApprovalPrompt>) => Promise<void>>
  let logError: Mock<(message: string) => void>
  let poll: Mock<() => Promise<Map<string, ApprovalPrompt>>>

  beforeEach(() => {
    onChange = vi.fn<(prompts: Map<string, ApprovalPrompt>) => Promise<void>>(async () => {})
    logError = vi.fn<(message: string) => void>()
    poll = vi.fn<() => Promise<Map<string, ApprovalPrompt>>>(async () => new Map())
  })

  it('does not call onChange while the prompts stay empty', async () => {
    await createApprovalTicker({ poll, onChange, logError })()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('calls onChange once when a prompt appears and not again while it is unchanged', async () => {
    poll.mockResolvedValue(new Map([['foo', PROMPT_A]]))
    const tick = createApprovalTicker({ poll, onChange, logError })
    await tick()
    await tick()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0].get('foo')).toEqual(PROMPT_A)
  })

  it('calls onChange again when the prompt clears', async () => {
    poll.mockResolvedValueOnce(new Map([['foo', PROMPT_A]]))
    const tick = createApprovalTicker({ poll, onChange, logError })
    await tick()
    await tick()
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange.mock.calls[1][0].size).toBe(0)
  })

  it('skips a tick while the previous one is still in flight', async () => {
    let release: () => void = () => {}
    poll.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(new Map()) }))
    const tick = createApprovalTicker({ poll, onChange, logError })
    const first = tick()
    await tick()
    expect(poll).toHaveBeenCalledTimes(1)
    release()
    await first
    await tick()
    expect(poll).toHaveBeenCalledTimes(2)
  })

  it('logs a failing tick once per distinct message and keeps ticking', async () => {
    poll.mockRejectedValue(new Error('boom'))
    const tick = createApprovalTicker({ poll, onChange, logError })
    await tick()
    await tick()
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('[approvalWatch] tick failed: boom')
    poll.mockResolvedValue(new Map())
    await tick()
    expect(poll).toHaveBeenCalledTimes(3)
  })
})
