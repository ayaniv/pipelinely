import { describe, expect, test, vi } from 'vitest'
import type { BacklogItem } from '../../../src/types'
import {
  BACKLOG_EDIT_FALLBACK_MESSAGE, postBacklogDismiss, postBacklogDispatch, postBacklogEdit, postBacklogResume, postBatchDispatch,
} from './backlogActions'

const item: BacklogItem = { description: 'Ship it', date: '2026-08-20', context: 'ctx', done: false, shelvedSlug: null, project: 'acme-api' }

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function options(response: Response | Error) {
  const fetchImpl = vi.fn()
  if (response instanceof Error) fetchImpl.mockRejectedValue(response)
  else fetchImpl.mockResolvedValue(response)
  return { fetchImpl, log: vi.fn() }
}

describe('postBacklogDispatch', () => {
  test('posts the item\'s description, context and project, and reports "✓ sent"', async () => {
    const opts = options(new Response(null, { status: 200 }))

    const result = await postBacklogDispatch(item, opts)

    expect(result).toEqual({ ok: true, label: '✓ sent' })
    const [url, init] = opts.fetchImpl.mock.calls[0]
    expect(url).toBe('/backlog/dispatch')
    expect(JSON.parse(init.body)).toEqual({ description: 'Ship it', context: 'ctx', project: 'acme-api' })
    expect(opts.log).not.toHaveBeenCalled()
  })

  test.each([
    [409, 'reattached — click again'],
    [503, 'no orchestrator'],
    [403, 'read-only instance'],
    [500, 'failed'],
  ])('a %i response reports "%s" and logs [action]', async (status, label) => {
    const opts = options(new Response(null, { status }))

    const result = await postBacklogDispatch(item, opts)

    expect(result).toEqual({ ok: false, label })
    expect(opts.log).toHaveBeenCalledWith('[action] POST /backlog/dispatch failed', expect.any(Error))
  })

  test('a network failure reports "no server" and logs [action]', async () => {
    const opts = options(new Error('down'))
    expect(await postBacklogDispatch(item, opts)).toEqual({ ok: false, label: 'no server' })
    expect(opts.log).toHaveBeenCalledWith('[action] POST /backlog/dispatch failed', expect.any(Error))
  })
})

describe('postBacklogResume', () => {
  test('posts the item as the concurrency guard and reports "✓ resumed"', async () => {
    const opts = options(new Response(null, { status: 200 }))

    expect(await postBacklogResume(3, item, opts)).toEqual({ ok: true, label: '✓ resumed' })

    const [url, init] = opts.fetchImpl.mock.calls[0]
    expect(url).toBe('/backlog/resume/3')
    expect(JSON.parse(init.body)).toEqual({ original: item })
  })

  test('a failure surfaces the server\'s own message and logs it', async () => {
    const opts = options(jsonResponse(404, { error: 'that task directory is gone' }))

    expect(await postBacklogResume(0, item, opts)).toEqual({ ok: false, label: 'that task directory is gone' })
    expect(opts.log).toHaveBeenCalledWith('[action] POST /backlog/resume/0 failed', expect.any(Error))
  })

  test('a failure with no message falls back to "failed", and a network failure to "no server"', async () => {
    expect(await postBacklogResume(0, item, options(new Response(null, { status: 500 })))).toEqual({ ok: false, label: 'failed' })
    expect(await postBacklogResume(0, item, options(new Error('down')))).toEqual({ ok: false, label: 'no server' })
  })
})

describe('postBacklogDismiss', () => {
  test('posts the item as the concurrency guard and reports "✓ removed"', async () => {
    const opts = options(new Response(null, { status: 200 }))

    expect(await postBacklogDismiss(2, item, opts)).toEqual({ ok: true, label: '✓ removed' })

    const [url, init] = opts.fetchImpl.mock.calls[0]
    expect(url).toBe('/backlog/dismiss/2')
    expect(JSON.parse(init.body)).toEqual({ original: item })
  })

  test.each([
    [409, 'changed elsewhere — refresh'],
    [500, 'failed'],
  ])('a %i response reports "%s" and logs the index and status', async (status, label) => {
    const opts = options(new Response(null, { status }))

    expect(await postBacklogDismiss(2, item, opts)).toEqual({ ok: false, label })
    expect(opts.log).toHaveBeenCalledWith('[action] POST /backlog/dismiss/2 failed', new Error(`HTTP ${status}`))
  })

  test('a network failure reports "no server" and logs [action]', async () => {
    const opts = options(new Error('down'))
    expect(await postBacklogDismiss(2, item, opts)).toEqual({ ok: false, label: 'no server' })
    expect(opts.log).toHaveBeenCalledWith('[action] POST /backlog/dismiss/2 failed', expect.any(Error))
  })
})

describe('postBacklogEdit', () => {
  const edit = { description: 'New', date: '2026-08-20', context: null, project: null, original: item }

  test('posts the edit with the untouched original and reports ok', async () => {
    const opts = options(new Response(null, { status: 200 }))

    expect(await postBacklogEdit(1, edit, opts)).toEqual({ ok: true })

    const [url, init] = opts.fetchImpl.mock.calls[0]
    expect(url).toBe('/backlog/edit/1')
    expect(JSON.parse(init.body)).toEqual(edit)
  })

  test.each([
    [409, {}, 'This item changed elsewhere — refresh and try again.'],
    [400, { error: 'invalid-project' }, 'Project must be a single word (letters, digits, -, _, .).'],
    [400, { error: 'project-collision' }, "An untagged description can't start with a bracketed word. Set it as the project instead."],
    [400, { error: 'something-new' }, BACKLOG_EDIT_FALLBACK_MESSAGE],
    [500, {}, BACKLOG_EDIT_FALLBACK_MESSAGE],
  ])('a %i response %j gives a specific message and logs [action]', async (status, body, message) => {
    const opts = options(jsonResponse(status, body))

    expect(await postBacklogEdit(1, edit, opts)).toEqual({ ok: false, message })
    expect(opts.log).toHaveBeenCalledWith('[action] POST /backlog/edit/1 failed', new Error(`HTTP ${status}`))
  })

  test('a 400 whose body is not JSON still falls back to the generic message', async () => {
    const opts = options(new Response('nope', { status: 400 }))
    expect(await postBacklogEdit(1, edit, opts)).toEqual({ ok: false, message: BACKLOG_EDIT_FALLBACK_MESSAGE })
  })

  test('a network failure says no response arrived and logs [action]', async () => {
    const opts = options(new Error('down'))

    expect(await postBacklogEdit(1, edit, opts)).toEqual({ ok: false, message: 'Save failed — no response from server.' })
    expect(opts.log).toHaveBeenCalledWith('[action] POST /backlog/edit/1 failed', expect.any(Error))
  })
})

describe('postBatchDispatch', () => {
  const body = { kind: 'backlog' as const, items: [{ description: 'Ship it', context: null, project: null }] }

  test('a 200 reports "staged"', async () => {
    const opts = options(new Response(null, { status: 200 }))

    expect(await postBatchDispatch(body, opts)).toEqual({ ok: true, label: 'staged' })
    expect(JSON.parse(opts.fetchImpl.mock.calls[0][1].body)).toEqual(body)
  })

  test('a wave batch posts the child slugs under kind "wave"', async () => {
    const opts = options(new Response(null, { status: 200 }))

    expect(await postBatchDispatch({ kind: 'wave', slugs: ['p-m1', 'p-m2'] }, opts)).toEqual({ ok: true, label: 'staged' })
    expect(JSON.parse(opts.fetchImpl.mock.calls[0][1].body)).toEqual({ kind: 'wave', slugs: ['p-m1', 'p-m2'] })
  })

  test.each([
    [409, 'reattached — retry'],
    [503, 'no orchestrator'],
  ])('a %i response reports "%s" with the server\'s detail, and logs', async (status, label) => {
    const opts = options(jsonResponse(status, { error: 'tab is gone' }))

    expect(await postBatchDispatch(body, opts)).toEqual({ ok: false, label, detail: 'tab is gone' })
    expect(opts.log).toHaveBeenCalledWith('[action] POST /batch-dispatch failed', new Error(`HTTP ${status}`))
  })

  test('any other failure reports "failed" and a network failure "no server"', async () => {
    expect(await postBatchDispatch(body, options(new Response(null, { status: 500 })))).toEqual({ ok: false, label: 'failed' })
    const opts = options(new Error('down'))
    expect(await postBatchDispatch(body, opts)).toEqual({ ok: false, label: 'no server' })
    expect(opts.log).toHaveBeenCalledWith('[action] POST /batch-dispatch failed', expect.any(Error))
  })
})
