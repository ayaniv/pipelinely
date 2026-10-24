import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { attachPrMergeStates, attachResolvedPrNumbers, createPrMergeStateCache, createPrNumberCache, prMergeStateTtlMs } from './prLookup.js'
import { findPrNumber } from './taskParser.js'
import type { Task } from './types.js'

const openPr = (prNumber: string) => ({ prNumber, isOpen: true })
const mergedPr = (prNumber: string) => ({ prNumber, isOpen: false })

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    slug: 'fix-header',
    repo: 'cockpit-ai',
    branch: 'claude/fix-header',
    status: 'waiting',
    stage: 'merge',
    reviewRef: undefined,
    stageHistory: [{ stage: 'dev', at: '2026-09-19T05:48:29Z', note: 'PR opened: no number' }],
    ...overrides,
  } as Task
}

describe('attachResolvedPrNumbers', () => {
  it('looks up the PR by branch for a post-dev task whose TIMELINE names no PR', async () => {
    const lookup = vi.fn().mockResolvedValue(openPr('108'))
    const [task] = await attachResolvedPrNumbers([makeTask()], lookup, createPrNumberCache())
    expect(task.prNumber).toBe('108')
    expect(lookup).toHaveBeenCalledWith('cockpit-ai', 'claude/fix-header')
  })

  it('lets the branch-derived PR beat a different PR named in a TIMELINE note', async () => {
    const lookup = vi.fn().mockResolvedValue(openPr('117'))
    const hijacked = makeTask({
      stageHistory: [
        { stage: 'dev', at: 'x', note: 'PR #117 opened: my change' },
        { stage: 'dev', at: 'y', note: 'merged origin/master (M2, PR #119) into branch' },
      ],
    })
    const [task] = await attachResolvedPrNumbers([hijacked], lookup, createPrNumberCache())
    expect(task.prNumber).toBe('117')
  })

  it('does not call GitHub when a legacy reviewRef already names the PR, and keeps it winning', async () => {
    const lookup = vi.fn()
    const [task] = await attachResolvedPrNumbers([makeTask({ reviewRef: '99' })], lookup, createPrNumberCache())
    expect(lookup).not.toHaveBeenCalled()
    expect(findPrNumber(task)).toBe('99')
  })

  it('falls back to a strict note match when GitHub finds nothing', async () => {
    const lookup = vi.fn().mockResolvedValue(null)
    const withNote = makeTask({ stageHistory: [{ stage: 'dev', at: 'x', note: 'PR #42 opened: my change' }] })
    const [task] = await attachResolvedPrNumbers([withNote], lookup, createPrNumberCache())
    expect(task.prNumber).toBe('42')
  })

  it('falls back to a strict note match, and logs, when the lookup itself throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const lookup = vi.fn().mockRejectedValue(new Error('gh exploded'))
    const withNote = makeTask({ stageHistory: [{ stage: 'dev', at: 'x', note: 'PR #42 opened: my change' }] })
    const [task] = await attachResolvedPrNumbers([withNote], lookup, createPrNumberCache())
    expect(task.prNumber).toBe('42')
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('never resolves a bare "#N" mentioned in prose', async () => {
    const lookup = vi.fn().mockResolvedValue(null)
    const prose = makeTask({ stageHistory: [{ stage: 'dev', at: 'x', note: 'rebased after #119 landed' }] })
    const [task] = await attachResolvedPrNumbers([prose], lookup, createPrNumberCache())
    expect(task.prNumber).toBeUndefined()
  })

  it('folds a strict note match into prNumber for a task in a stage that never asks GitHub', async () => {
    const lookup = vi.fn()
    const inDev = makeTask({ stage: 'dev', stageHistory: [{ stage: 'dev', at: 'x', note: 'PR #42 opened: my change' }] })
    const [task] = await attachResolvedPrNumbers([inDev], lookup, createPrNumberCache())
    expect(lookup).not.toHaveBeenCalled()
    expect(task.prNumber).toBe('42')
  })

  it.each([['planning'], ['plan-review'], ['dev'], [null]] as const)(
    'does not call GitHub for a task still in stage %s (no PR can exist yet)',
    async (stage) => {
      const lookup = vi.fn()
      await attachResolvedPrNumbers([makeTask({ stage })], lookup, createPrNumberCache())
      expect(lookup).not.toHaveBeenCalled()
    },
  )

  it('does not call GitHub for a task with no branch', async () => {
    const lookup = vi.fn()
    await attachResolvedPrNumbers([makeTask({ branch: '' })], lookup, createPrNumberCache())
    expect(lookup).not.toHaveBeenCalled()
  })

  it('leaves prNumber unset when GitHub reports no open PR', async () => {
    const lookup = vi.fn().mockResolvedValue(null)
    const [task] = await attachResolvedPrNumbers([makeTask()], lookup, createPrNumberCache())
    expect(task.prNumber).toBeUndefined()
  })

  it('remembers an OPEN PR so later refreshes do not hit GitHub again', async () => {
    const lookup = vi.fn().mockResolvedValue(openPr('108'))
    const cache = createPrNumberCache()
    await attachResolvedPrNumbers([makeTask()], lookup, cache)
    const [task] = await attachResolvedPrNumbers([makeTask()], lookup, cache)
    expect(task.prNumber).toBe('108')
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('re-asks an OPEN PR after its TTL, so a closed-and-replaced PR is eventually found', async () => {
    const lookup = vi.fn().mockResolvedValueOnce(openPr('108')).mockResolvedValueOnce(openPr('130'))
    const cache = createPrNumberCache()
    let now = 0
    await attachResolvedPrNumbers([makeTask()], lookup, cache, () => now)
    now = 11 * 60_000
    const [task] = await attachResolvedPrNumbers([makeTask()], lookup, cache, () => now)
    expect(task.prNumber).toBe('130')
  })

  it('caches a miss only briefly: no repeat gh call inside the TTL, a fresh one after it', async () => {
    const lookup = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(openPr('108'))
    const cache = createPrNumberCache()
    let now = 0
    await attachResolvedPrNumbers([makeTask()], lookup, cache, () => now)
    now = 30_000
    const [inside] = await attachResolvedPrNumbers([makeTask()], lookup, cache, () => now)
    expect(inside.prNumber).toBeUndefined()
    expect(lookup).toHaveBeenCalledTimes(1)
    now = 61_000
    const [after] = await attachResolvedPrNumbers([makeTask()], lookup, cache, () => now)
    expect(after.prNumber).toBe('108')
  })

  it('does not treat a MERGED-only result as final: a new PR on the reused branch is found after the TTL', async () => {
    const lookup = vi.fn().mockResolvedValueOnce(mergedPr('105')).mockResolvedValueOnce(openPr('140'))
    const cache = createPrNumberCache()
    let now = 0
    await attachResolvedPrNumbers([makeTask()], lookup, cache, () => now)
    now = 61_000
    const [task] = await attachResolvedPrNumbers([makeTask()], lookup, cache, () => now)
    expect(task.prNumber).toBe('140')
  })

  it('caches a failing lookup briefly too, logging the failure once rather than on every refresh', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const lookup = vi.fn().mockRejectedValue(new Error('gh offline'))
    const cache = createPrNumberCache()
    await attachResolvedPrNumbers([makeTask()], lookup, cache, () => 0)
    await attachResolvedPrNumbers([makeTask()], lookup, cache, () => 1_000)
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })

  it('asks GitHub once when several tasks in the same refresh share a repo and branch', async () => {
    const lookup = vi.fn().mockResolvedValue(openPr('108'))
    const tasks = [makeTask({ slug: 'a' }), makeTask({ slug: 'b' })]
    const resolved = await attachResolvedPrNumbers(tasks, lookup, createPrNumberCache())
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(resolved.map((t) => t.prNumber)).toEqual(['108', '108'])
  })
})

describe('attachPrMergeStates', () => {
  const withPr = (overrides: Partial<Task> = {}) => makeTask({ prNumber: '149', ...overrides })
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
    delete process.env.COCKPIT_PR_MERGE_STATE_TTL_MS
  })

  it("attaches the open PR's merge state, asking with the task's repo, PR number and branch", async () => {
    const lookup = vi.fn().mockResolvedValue('conflicting')
    const [task] = await attachPrMergeStates([withPr()], lookup, createPrMergeStateCache())
    expect(task.prMergeState).toBe('conflicting')
    expect(lookup).toHaveBeenCalledWith('cockpit-ai', '149', 'claude/fix-header')
  })

  it('leaves the field off when the PR is not open (the lookup answers null)', async () => {
    const lookup = vi.fn().mockResolvedValue(null)
    const [task] = await attachPrMergeStates([withPr()], lookup, createPrMergeStateCache())
    expect(task).not.toHaveProperty('prMergeState')
  })

  it.each([
    ['no PR', { prNumber: undefined }],
    ['done', { status: 'done' }],
    ['shelved', { status: 'shelved' }],
  ] as const)('never asks GitHub for a task with %s', async (_label, overrides) => {
    const lookup = vi.fn()
    const [task] = await attachPrMergeStates([withPr(overrides as Partial<Task>)], lookup, createPrMergeStateCache())
    expect(lookup).not.toHaveBeenCalled()
    expect(task).not.toHaveProperty('prMergeState')
  })

  it('uses a PR named only in a TIMELINE note (resolved by findPrNumber), not just the attached prNumber', async () => {
    const lookup = vi.fn().mockResolvedValue('mergeable')
    const noted = makeTask({ stageHistory: [{ stage: 'dev', at: 'x', note: 'PR #42 opened: my change' }] })
    const [task] = await attachPrMergeStates([noted], lookup, createPrMergeStateCache())
    expect(lookup).toHaveBeenCalledWith('cockpit-ai', '42', 'claude/fix-header')
    expect(task.prMergeState).toBe('mergeable')
  })

  it('maps a throwing lookup to unknown and logs it', async () => {
    const lookup = vi.fn().mockRejectedValue(new Error('gh exploded'))
    const [task] = await attachPrMergeStates([withPr()], lookup, createPrMergeStateCache())
    expect(task.prMergeState).toBe('unknown')
    expect(errorSpy).toHaveBeenCalled()
  })

  it('is cached per PR within the TTL — one gh call across refreshes — and re-read after it', async () => {
    const lookup = vi.fn().mockResolvedValueOnce('conflicting').mockResolvedValueOnce('mergeable')
    const cache = createPrMergeStateCache()
    let now = 0
    await attachPrMergeStates([withPr()], lookup, cache, () => now)
    now = prMergeStateTtlMs() - 1
    const [inside] = await attachPrMergeStates([withPr()], lookup, cache, () => now)
    expect(inside.prMergeState).toBe('conflicting')
    expect(lookup).toHaveBeenCalledTimes(1)

    now = prMergeStateTtlMs()
    const [after] = await attachPrMergeStates([withPr()], lookup, cache, () => now)
    expect(after.prMergeState).toBe('mergeable')
  })

  it('has a short default TTL, overridable through COCKPIT_PR_MERGE_STATE_TTL_MS', () => {
    expect(prMergeStateTtlMs()).toBe(60_000)
    process.env.COCKPIT_PR_MERGE_STATE_TTL_MS = '250'
    expect(prMergeStateTtlMs()).toBe(250)
  })

  it('falls back to the default TTL, and logs, for an unusable override', () => {
    process.env.COCKPIT_PR_MERGE_STATE_TTL_MS = 'soon'
    expect(prMergeStateTtlMs()).toBe(60_000)
    expect(errorSpy).toHaveBeenCalled()
  })
})

// parseAllTasks stitches each dispatched milestone child onto its parent as the
// SAME object as the top-level task. Attaching resolved fields copies the task,
// so the parent's milestone must be relinked to the resolved copy, or the
// milestone card reads a child with no PR number and no merge state.
describe('milestone children see the resolved fields', () => {
  function parentWith(child: Task): Task {
    return makeTask({
      slug: 'proj',
      branch: 'claude/proj',
      stage: 'dev',
      milestones: [{ id: 'M0', name: 'First', needs: [], wave: 1, state: 'dispatched', task: child }] as unknown as Task['milestones'],
    })
  }

  it("attachPrMergeStates: the parent's milestone task is the resolved child, with its merge state", async () => {
    const child = makeTask({ slug: 'proj-m0', branch: 'claude/proj-m0', prNumber: '149' })
    const lookup = vi.fn().mockResolvedValue('conflicting')
    const [parent, resolvedChild] = await attachPrMergeStates([parentWith(child), child], lookup, createPrMergeStateCache())

    expect(resolvedChild.prMergeState).toBe('conflicting')
    expect(parent.milestones![0].task).toBe(resolvedChild)
  })

  it("attachResolvedPrNumbers: the parent's milestone task carries the branch-derived PR number", async () => {
    const child = makeTask({ slug: 'proj-m0', branch: 'claude/proj-m0' })
    const lookup = vi.fn(async (_repo: string, branch: string) => (branch === 'claude/proj-m0' ? openPr('150') : null))
    const [parent, resolvedChild] = await attachResolvedPrNumbers([parentWith(child), child], lookup, createPrNumberCache())

    expect(resolvedChild.prNumber).toBe('150')
    expect(parent.milestones![0].task).toBe(resolvedChild)
  })

  it('leaves a queued milestone (no child task yet) alone', async () => {
    const parent = makeTask({
      slug: 'proj',
      milestones: [{ id: 'M0', name: 'First', needs: [], wave: 1, state: 'queued', task: null }] as unknown as Task['milestones'],
    })
    const [resolved] = await attachPrMergeStates([parent], vi.fn(), createPrMergeStateCache())
    expect(resolved.milestones![0].task).toBeNull()
  })
})
