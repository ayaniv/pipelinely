import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Task } from '../../../src/types'
import { markTaskDone } from './markTaskDone'

const task = (overrides: Partial<Task> = {}) => ({ slug: 'my-task', title: 'My task', worktree: null, branch: 'claude/my-task', ...overrides }) as Task

afterEach(() => vi.restoreAllMocks())

describe('markTaskDone', () => {
  test('a task with no worktree posts straight away, without a confirm', async () => {
    const confirm = vi.spyOn(window, 'confirm')
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))

    const result = await markTaskDone(task(), { fetchImpl, log: vi.fn() })

    expect(confirm).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledWith('/mark-done/my-task', { method: 'POST' })
    expect(result).toMatchObject({ ok: true })
  })

  test('a task with a worktree confirms first, naming the title and the branch about to be deleted', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))

    await markTaskDone(task({ worktree: '/wt/my-task' }), { fetchImpl, log: vi.fn() })

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('"My task"'))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('claude/my-task'))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('declining the confirm sends nothing and resolves undefined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const fetchImpl = vi.fn()

    const result = await markTaskDone(task({ worktree: '/wt/my-task' }), { fetchImpl, log: vi.fn() })

    expect(result).toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('a failed request resolves not-ok so the caller can flash it', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'))
    const log = vi.fn()

    const result = await markTaskDone(task(), { fetchImpl, log })

    expect(result).toMatchObject({ ok: false, label: 'no server' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action]'), expect.any(Error))
  })
})
