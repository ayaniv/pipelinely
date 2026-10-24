import { describe, expect, test, vi } from 'vitest'
import { pushForward, startTaskInClaude } from './agentActions'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('pushForward', () => {
  test('POSTs /babysit with no body fields', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { outcome: 'nothing' }))
    await pushForward({ fetchImpl, log: vi.fn() })
    expect(fetchImpl).toHaveBeenCalledWith('/babysit', expect.objectContaining({ method: 'POST' }))
  })

  test('reports a sweep the server sent, with the planned count it gave', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { outcome: 'sent', planned: 3 }))
    expect(await pushForward({ fetchImpl, log: vi.fn() })).toMatchObject({ ok: true, result: 'sent', planned: 3 })
  })

  test('nothing to push is not a success', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { outcome: 'nothing' }))
    const outcome = await pushForward({ fetchImpl, log: vi.fn() })
    expect(outcome).toMatchObject({ ok: false, result: 'nothing' })
  })

  test('a load above the ceiling is deferred, carrying the reading', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { outcome: 'load-too-high', load1: 12.4 }))
    const outcome = await pushForward({ fetchImpl, log: vi.fn() })
    expect(outcome).toMatchObject({ ok: false, result: 'deferred', load1: 12.4 })
  })

  test('a 503 fails with the server\'s own reason, and logs it', async () => {
    const error = 'Orchestrator not running — no ORCHESTRATOR_SESSION found'
    const log = vi.fn()
    const outcome = await pushForward({ fetchImpl: vi.fn(async () => jsonResponse(503, { error })), log })
    expect(outcome).toEqual({ ok: false, result: 'failed', label: error })
    expect(log).toHaveBeenCalledWith('[agent-action] pushForward failed', expect.any(Error))
  })

  test('an error status with no readable body still fails', async () => {
    const outcome = await pushForward({ fetchImpl: vi.fn(async () => new Response('boom', { status: 500 })), log: vi.fn() })
    expect(outcome).toMatchObject({ ok: false, result: 'failed' })
  })

  test('a 200 with an outcome it does not know is a failure, never a sent sweep', async () => {
    const log = vi.fn()
    const outcome = await pushForward({ fetchImpl: vi.fn(async () => jsonResponse(200, { outcome: 'who-knows' })), log })
    expect(outcome).toMatchObject({ ok: false, result: 'failed' })
    expect(log).toHaveBeenCalled()
  })

  test('a network throw is a failure, logged, never a sent sweep', async () => {
    const log = vi.fn()
    const outcome = await pushForward({ fetchImpl: vi.fn(async () => { throw new TypeError('offline') }), log })
    expect(outcome).toMatchObject({ ok: false, result: 'failed' })
    expect(log).toHaveBeenCalledWith('[agent-action] pushForward failed', expect.any(TypeError))
  })
})

describe('startTaskInClaude', () => {
  test('succeeds for a non-blank prompt and a project', async () => {
    const log = vi.fn()
    expect(await startTaskInClaude({ prompt: 'Add a CSV export', project: 'cockpit-ai' }, { log })).toEqual({ ok: true, label: '✓' })
    expect(log).not.toHaveBeenCalledWith('[agent-action] startTaskInClaude failed', expect.anything())
  })

  test('says in the log that it is a stub, so a closed modal is not mistaken for a started session', async () => {
    const log = vi.fn()
    await startTaskInClaude({ prompt: 'Add a CSV export', project: 'cockpit-ai' }, { log })
    expect(log).toHaveBeenCalledWith('[agent-action] startTaskInClaude is not wired yet: nothing was started')
  })

  test('succeeds without a project when the board has none to offer', async () => {
    expect((await startTaskInClaude({ prompt: 'Add a CSV export', project: null }, { log: vi.fn() })).ok).toBe(true)
  })

  test('a blank prompt fails and is logged, never silently accepted', async () => {
    const log = vi.fn()
    const outcome = await startTaskInClaude({ prompt: '   ', project: 'cockpit-ai' }, { log })
    expect(outcome).toEqual({ ok: false, label: 'empty prompt' })
    expect(log).toHaveBeenCalledWith('[agent-action] startTaskInClaude failed', expect.any(Error))
  })
})
