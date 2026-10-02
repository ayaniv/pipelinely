import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { fetchSnapshot } from './snapshot'

const SNAPSHOT = {
  tasks: [],
  activeProject: null,
  weeklyFocus: '',
  backlog: [],
  doneGroups: [],
  settings: { autoMode: false },
  orchestratorContextPct: null,
  isCanonical: true,
}

describe('fetchSnapshot', () => {
  // Pinned to a concrete function type: `ReturnType<typeof vi.fn>` alone
  // resolves vi.fn's type parameter to its unresolved constraint (`Procedure
  // | Constructable`), which has no usable call signature and can't assign
  // to fetchSnapshot's `log` parameter.
  let log: Mock<(message: string, ...args: unknown[]) => void>

  beforeEach(() => {
    log = vi.fn()
  })

  it('returns the /api/tasks snapshot', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(SNAPSHOT), { status: 200 }))

    await expect(fetchSnapshot({ fetchImpl, log })).resolves.toEqual(SNAPSHOT)
    expect(fetchImpl).toHaveBeenCalledWith('/api/tasks')
    expect(log).not.toHaveBeenCalled()
  })

  // A failed cold load is logged, not swallowed. SSE still
  // fills the cache, so the page recovers — but the failure must be visible.
  it('logs a [snapshot]-prefixed error and rejects on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }))

    await expect(fetchSnapshot({ fetchImpl, log })).rejects.toThrow()
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0][0])).toMatch(/^\[snapshot\]/)
  })

  it('logs and rejects when the request itself fails', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('network down') })

    await expect(fetchSnapshot({ fetchImpl, log })).rejects.toThrow('network down')
    expect(String(log.mock.calls[0][0])).toMatch(/^\[snapshot\]/)
  })

  // A token rotated or disabled under an open tab: the cold load is the first
  // request to notice, and the way out is the login page, not a console error.
  it('sends the browser to the login page when the cold load is refused for lack of a session', async () => {
    const navigate = vi.fn()
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'remote-auth-required' }), { status: 401 }))

    await expect(fetchSnapshot({ fetchImpl, log, navigate })).rejects.toThrow()
    expect(navigate).toHaveBeenCalledWith('/remote-login')
  })

  it('does not navigate for an ordinary failure', async () => {
    const navigate = vi.fn()
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }))

    await expect(fetchSnapshot({ fetchImpl, log, navigate })).rejects.toThrow()
    expect(navigate).not.toHaveBeenCalled()
  })
})
