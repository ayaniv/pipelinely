import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useCloseWhenTaskGone } from './useCloseWhenTaskGone'

const tasksResponse = (slugs: string[]) => new Response(JSON.stringify({ tasks: slugs.map((slug) => ({ slug })) }), { status: 200 })

function setup(response: Response | Error) {
  const fetchImpl = vi.fn()
  if (response instanceof Error) fetchImpl.mockRejectedValue(response)
  else fetchImpl.mockResolvedValue(response)
  return { fetchImpl, log: vi.fn(), close: vi.fn() }
}

describe('useCloseWhenTaskGone', () => {
  it('does nothing while the task is still in the snapshot', () => {
    const deps = setup(tasksResponse([]))
    renderHook(() => useCloseWhenTaskGone('a', false, 1, deps))
    expect(deps.fetchImpl).not.toHaveBeenCalled()
  })

  it('does nothing with no slug in the URL', () => {
    const deps = setup(tasksResponse([]))
    renderHook(() => useCloseWhenTaskGone(undefined, true, 1, deps))
    expect(deps.fetchImpl).not.toHaveBeenCalled()
  })

  it('closes once /api/tasks, the authoritative list, confirms the task is gone', async () => {
    const deps = setup(tasksResponse(['other']))
    renderHook(() => useCloseWhenTaskGone('a', true, 1, deps))
    await waitFor(() => expect(deps.close).toHaveBeenCalledTimes(1))
  })

  it('does not close when /api/tasks still has the task — the snapshot just raced a refresh', async () => {
    const deps = setup(tasksResponse(['a']))
    renderHook(() => useCloseWhenTaskGone('a', true, 1, deps))
    await waitFor(() => expect(deps.fetchImpl).toHaveBeenCalled())
    await Promise.resolve()
    expect(deps.close).not.toHaveBeenCalled()
  })

  it('checks again on the next snapshot while the task is still missing', async () => {
    const deps = setup(tasksResponse(['a']))
    const { rerender } = renderHook(({ updatedAt }) => useCloseWhenTaskGone('a', true, updatedAt, deps), { initialProps: { updatedAt: 1 } })
    await waitFor(() => expect(deps.fetchImpl).toHaveBeenCalledTimes(1))
    rerender({ updatedAt: 2 })
    await waitFor(() => expect(deps.fetchImpl).toHaveBeenCalledTimes(2))
  })

  it('logs — and does not close — when the confirming request fails, so a failure is observable', async () => {
    const deps = setup(new Error('down'))
    renderHook(() => useCloseWhenTaskGone('a', true, 1, deps))
    await waitFor(() => expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('[task-detail]'), expect.any(Error)))
    expect(deps.close).not.toHaveBeenCalled()
  })

  it('treats a non-OK answer as a failure, not as "the task is gone"', async () => {
    const deps = setup(new Response(null, { status: 500 }))
    renderHook(() => useCloseWhenTaskGone('a', true, 1, deps))
    await waitFor(() => expect(deps.log).toHaveBeenCalled())
    expect(deps.close).not.toHaveBeenCalled()
  })

  it('drops an in-flight check if the view unmounts first', async () => {
    let resolveFetch: (response: Response) => void = () => {}
    const fetchImpl = vi.fn().mockReturnValue(new Promise<Response>((resolve) => { resolveFetch = resolve }))
    const close = vi.fn()
    const { unmount } = renderHook(() => useCloseWhenTaskGone('a', true, 1, { fetchImpl, log: vi.fn(), close }))
    unmount()
    resolveFetch(tasksResponse([]))
    await Promise.resolve()
    await Promise.resolve()
    expect(close).not.toHaveBeenCalled()
  })
})
