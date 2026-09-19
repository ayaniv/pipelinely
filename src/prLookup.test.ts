import { describe, it, expect, vi } from 'vitest'
import { attachResolvedPrNumbers, createPrNumberCache } from './prLookup.js'
import type { Task } from './types.js'

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
    const lookup = vi.fn().mockResolvedValue('108')
    const [task] = await attachResolvedPrNumbers([makeTask()], lookup, createPrNumberCache())
    expect(task.prNumber).toBe('108')
    expect(lookup).toHaveBeenCalledWith('cockpit-ai', 'claude/fix-header')
  })

  it('does not call GitHub when the TIMELINE already names the PR', async () => {
    const lookup = vi.fn()
    const withPr = makeTask({ stageHistory: [{ stage: 'dev', at: 'x', note: 'PR #42 open' }] })
    const [task] = await attachResolvedPrNumbers([withPr], lookup, createPrNumberCache())
    expect(task.prNumber).toBeUndefined()
    expect(lookup).not.toHaveBeenCalled()
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

  it('remembers a found PR so later refreshes do not hit GitHub again', async () => {
    const lookup = vi.fn().mockResolvedValue('108')
    const cache = createPrNumberCache()
    await attachResolvedPrNumbers([makeTask()], lookup, cache)
    const [task] = await attachResolvedPrNumbers([makeTask()], lookup, cache)
    expect(task.prNumber).toBe('108')
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('does not cache a miss, so a PR opened later is picked up on the next refresh', async () => {
    const lookup = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('108')
    const cache = createPrNumberCache()
    await attachResolvedPrNumbers([makeTask()], lookup, cache)
    const [task] = await attachResolvedPrNumbers([makeTask()], lookup, cache)
    expect(task.prNumber).toBe('108')
  })
})
