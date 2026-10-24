import { describe, it, expect, vi, beforeEach } from 'vitest'
import { describeMergeOutcome, mergeResolvingPr } from './cockpitMerge.js'
import type { Task } from './types.js'

const { mergeTaskMock } = vi.hoisted(() => ({ mergeTaskMock: vi.fn() }))
vi.mock('./taskCompletion.js', () => ({ mergeTask: mergeTaskMock }))

const NO_SESSIONS = { retired: [], wasAttached: [], failures: [], listError: null }

const hijackedTask = {
  slug: 'react-migration-m4',
  repo: 'cockpit-ai',
  branch: 'claude/react-migration-m4',
  stage: 'merge',
  stageHistory: [{ stage: 'dev', at: 'x', note: 'merged origin/master (M2, PR #119) into branch' }],
} as unknown as Task

describe('mergeResolvingPr', () => {
  beforeEach(() => mergeTaskMock.mockReset())

  it('resolves the PR from the task branch via GitHub before merging, so the CLI never merges a note-scraped PR', async () => {
    mergeTaskMock.mockResolvedValueOnce({ outcome: 'merged', prNumber: '118', cleanupError: null, sessions: NO_SESSIONS })
    const lookup = vi.fn().mockResolvedValue({ prNumber: '118', isOpen: true })
    await mergeResolvingPr('/tasks', hijackedTask, lookup)
    expect(lookup).toHaveBeenCalledWith('cockpit-ai', 'claude/react-migration-m4')
    expect(mergeTaskMock).toHaveBeenCalledWith('/tasks', expect.objectContaining({ prNumber: '118' }))
  })

  it('passes the task through with no PR when GitHub knows none and no note names one', async () => {
    mergeTaskMock.mockResolvedValueOnce({ outcome: 'no-pr' })
    await mergeResolvingPr('/tasks', hijackedTask, vi.fn().mockResolvedValue(null))
    expect(mergeTaskMock.mock.calls[0][1].prNumber).toBeUndefined()
  })
})

describe('describeMergeOutcome', () => {
  it('branch-mismatch exits 2 with the clear refusal message on stderr', () => {
    const { exitCode, lines } = describeMergeOutcome({ outcome: 'branch-mismatch', prNumber: '119', expectedBranch: 'claude/mine', actualBranch: 'claude/theirs' })
    expect(exitCode).toBe(2)
    expect(lines).toEqual([{ stream: 'error', text: expect.stringContaining('PR #119') }])
    expect(lines[0].text).toContain('claude/theirs')
  })

  it('blocked exits 2 with the blockers', () => {
    const { exitCode, lines } = describeMergeOutcome({ outcome: 'blocked', prNumber: '1', blockers: [{ kind: 'conflicts', detail: 'PR has merge conflicts' }] })
    expect(exitCode).toBe(2)
    expect(lines[0].text).toBe('PR has merge conflicts')
  })

  it.each([
    [{ outcome: 'no-pr' }, 'No PR recorded'],
    [{ outcome: 'gate-unavailable', error: 'gh down' }, 'gh down'],
    [{ outcome: 'merge-failed', prNumber: '1', error: 'boom' }, 'boom'],
  ] as const)('%j exits 1 on stderr', (outcome, text) => {
    const { exitCode, lines } = describeMergeOutcome(outcome as never)
    expect(exitCode).toBe(1)
    expect(lines[0]).toEqual({ stream: 'error', text: expect.stringContaining(text) })
  })

  it('merged exits 0, and reports a cleanup error without failing', () => {
    const { exitCode, lines } = describeMergeOutcome({ outcome: 'merged', prNumber: '7', cleanupError: 'worktree busy', sessions: NO_SESSIONS })
    expect(exitCode).toBe(0)
    expect(lines).toEqual([
      { stream: 'log', text: 'PR #7 merged, task marked done' },
      { stream: 'error', text: 'cleanup: worktree busy' },
      { stream: 'log', text: 'sessions: none' },
    ])
  })

  it('merged prints the session retirement summary line after the merge message, exit code still 0', () => {
    const sessions = { retired: ['worker-a', 'worker-a-cr'], wasAttached: ['worker-a-cr'], failures: [], listError: null }
    const { exitCode, lines } = describeMergeOutcome({ outcome: 'merged', prNumber: '7', cleanupError: null, sessions })
    expect(exitCode).toBe(0)
    expect(lines).toEqual([
      { stream: 'log', text: 'PR #7 merged, task marked done' },
      { stream: 'log', text: 'sessions: retired worker-a, worker-a-cr (was attached)' },
    ])
  })

  it('a session that failed to retire is reported but never changes the exit code', () => {
    const sessions = { retired: [], wasAttached: [], failures: [{ name: 'worker-a', error: 'tmux says no' }], listError: null }
    const { exitCode, lines } = describeMergeOutcome({ outcome: 'merged', prNumber: '7', cleanupError: null, sessions })
    expect(exitCode).toBe(0)
    expect(lines[1]).toEqual({ stream: 'log', text: 'sessions: failed worker-a (tmux says no)' })
  })

  it.each([
    [{ outcome: 'no-pr' as const }, 1],
    [{ outcome: 'merge-failed' as const, prNumber: '7', error: 'x' }, 1],
    [{ outcome: 'blocked' as const, prNumber: '7', blockers: [] }, 2],
  ])('prints no sessions line for a merge that did not happen (%j)', (outcome, expectedExit) => {
    const { exitCode, lines } = describeMergeOutcome(outcome)
    expect(exitCode).toBe(expectedExit)
    expect(lines.some((line) => line.text.startsWith('sessions:'))).toBe(false)
  })
})
