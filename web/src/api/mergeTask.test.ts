import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClientState, type ClientState } from '../data/clientState'
import { makeTask } from '../testing/makeTask'
import { mergeTask } from './mergeTask'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let state: ClientState
beforeEach(() => { state = createClientState() })

const task = makeTask({ slug: 'my-task', title: 'My task', prNumber: '42' })

function deps(response: Response | Error, confirm = vi.fn().mockReturnValue(true)) {
  const fetchImpl = vi.fn()
  if (response instanceof Error) fetchImpl.mockRejectedValue(response)
  else fetchImpl.mockResolvedValue(response)
  return { fetchImpl, log: vi.fn(), confirm, state }
}

describe('mergeTask', () => {
  test('confirms first, naming the PR and the task, and does nothing when declined', async () => {
    const options = deps(jsonResponse(200, { prNumber: '42' }), vi.fn().mockReturnValue(false))

    expect(await mergeTask(task, options)).toEqual({ merged: false, cleanupError: null })

    expect(options.confirm).toHaveBeenCalledWith('Merge PR #42 for "My task" and mark it done? This also deletes its branch on GitHub.')
    expect(options.fetchImpl).not.toHaveBeenCalled()
    expect(state.getMergeState('my-task')).toEqual({ banner: null, isInFlight: false })
  })

  test('also names the worktree and local branch in the confirmation when the task has one', async () => {
    const options = deps(jsonResponse(200, { prNumber: '42' }))
    await mergeTask({ ...task, worktree: '/w/my-task', branch: 'claude/my-task' }, options)
    expect(options.confirm).toHaveBeenCalledWith(expect.stringContaining('It also deletes its worktree and local branch (claude/my-task).'))
  })

  test('a clean merge resolves merged with no banner, and leaves the slug idle', async () => {
    const options = deps(jsonResponse(200, { prNumber: '42' }))

    expect(await mergeTask(task, options)).toEqual({ merged: true, cleanupError: null })

    expect(state.getMergeState('my-task')).toEqual({ banner: null, isInFlight: false })
  })

  test('a merge that lands with a cleanup problem resolves merged and keeps a warning banner', async () => {
    const options = deps(jsonResponse(200, { prNumber: '42', cleanupError: 'branch delete failed' }))

    expect(await mergeTask(task, options)).toEqual({ merged: true, cleanupError: 'branch delete failed' })

    expect(state.getMergeState('my-task').banner?.tone).toBe('warning')
  })

  test('a blocked merge resolves not merged and keeps an error banner', async () => {
    const options = deps(jsonResponse(409, { error: 'CI failing\nconflicts' }))

    expect(await mergeTask(task, options)).toEqual({ merged: false, cleanupError: null })

    expect(state.getMergeState('my-task')).toEqual({ banner: { tone: 'error', lines: ['CI failing', 'conflicts'] }, isInFlight: false })
  })

  test('an unreachable server keeps an error banner and never strands the slug in flight', async () => {
    const options = deps(new Error('down'))

    expect(await mergeTask(task, options)).toEqual({ merged: false, cleanupError: null })

    expect(state.getMergeState('my-task')).toEqual({ banner: { tone: 'error', lines: ['no server'] }, isInFlight: false })
    expect(options.log).toHaveBeenCalled()
  })

  test('marks the slug in flight, with the stale banner cleared, while the request is out', async () => {
    state.beginMerge('my-task')
    state.settleMerge('my-task', { tone: 'error', lines: ['old reason'] })
    let observedDuringRequest: ReturnType<ClientState['getMergeState']> | null = null
    const fetchImpl = vi.fn().mockImplementation(async () => {
      observedDuringRequest = state.getMergeState('my-task')
      return jsonResponse(200, { prNumber: '42' })
    })

    await mergeTask(task, { fetchImpl, log: vi.fn(), confirm: () => true, state })

    expect(observedDuringRequest).toEqual({ banner: null, isInFlight: true })
  })

  test('a second merge for a slug already in flight is ignored — no dialog, no request', async () => {
    state.beginMerge('my-task')
    const options = deps(jsonResponse(200, { prNumber: '42' }))

    expect(await mergeTask(task, options)).toEqual({ merged: false, cleanupError: null })

    expect(options.confirm).not.toHaveBeenCalled()
    expect(options.fetchImpl).not.toHaveBeenCalled()
  })
})
