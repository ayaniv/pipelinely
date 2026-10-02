import { describe, expect, test, vi } from 'vitest'
import {
  postAction, postAutoMode, postFocus, postHandover, postHelpFeedback, postMarkDone, postMergePr,
  isNothingSent, postAnswerDialog, postOrchestratorHandover, postOrchestratorTab, postShelve, postSkipStage, postStageSkill, postTaskAutoMode, postTriage, postWeeklyFocus,
} from './actions'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('postAction', () => {
  test('a 2xx response resolves ok with the ✓ label', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    const log = vi.fn()

    const result = await postAction('focus', 'my-task', { fetchImpl, log })

    expect(result).toEqual({ ok: true, label: '✓' })
    expect(fetchImpl).toHaveBeenCalledWith('/focus/my-task', { method: 'POST' })
    expect(log).not.toHaveBeenCalled()
  })

  test('a URL-unsafe slug is percent-encoded in the request path', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    await postAction('focus', 'a/b c', { fetchImpl, log: vi.fn() })
    expect(fetchImpl).toHaveBeenCalledWith('/focus/a%2Fb%20c', { method: 'POST' })
  })

  test('a 404 response resolves not-ok with a "not found" label and logs [action]', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }))
    const log = vi.fn()

    const result = await postAction('focus', 'my-task', { fetchImpl, log })

    expect(result).toEqual({ ok: false, label: 'not found' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action]'), expect.any(Error))
  })

  test('a non-404 failure response resolves not-ok with a "failed" label', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
    const result = await postAction('focus', 'my-task', { fetchImpl, log: vi.fn() })
    expect(result).toEqual({ ok: false, label: 'failed' })
  })

  test('a network failure resolves not-ok with a "no server" label and logs [action]', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'))
    const log = vi.fn()

    const result = await postAction('focus', 'my-task', { fetchImpl, log })

    expect(result).toEqual({ ok: false, label: 'no server' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action]'), expect.any(Error))
  })
})

describe('postMarkDone', () => {
  test('a plain 2xx response resolves ok with no cleanup error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}))
    const result = await postMarkDone('my-task', { fetchImpl, log: vi.fn() })
    expect(result).toEqual({ ok: true, label: '✓', cleanupError: null })
  })

  test('a 2xx response carrying a cleanupError surfaces it as the label and logs [action]', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { cleanupError: 'worktree busy' }))
    const log = vi.fn()

    const result = await postMarkDone('my-task', { fetchImpl, log })

    expect(result).toEqual({ ok: true, label: 'worktree busy', cleanupError: 'worktree busy' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action]'), expect.any(Error))
  })

  test('a network failure resolves not-ok with a "no server" label', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('down'))
    const result = await postMarkDone('my-task', { fetchImpl, log: vi.fn() })
    expect(result).toEqual({ ok: false, label: 'no server', cleanupError: null })
  })
})

describe('postShelve', () => {
  test('a plain 2xx response resolves ok as shelved', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}))
    const result = await postShelve('my-task', { fetchImpl, log: vi.fn() })
    expect(result).toEqual({ ok: true, label: '✓ shelved', cleanupError: null })
  })

  test('a failure response carrying an error field surfaces it as the label', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, { error: 'already shelved' }))
    const result = await postShelve('my-task', { fetchImpl, log: vi.fn() })
    expect(result).toEqual({ ok: false, label: 'already shelved', cleanupError: null })
  })

  test('a network failure resolves not-ok with a "no server" label and logs [action]', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('down'))
    const log = vi.fn()
    const result = await postShelve('my-task', { fetchImpl, log })
    expect(result).toEqual({ ok: false, label: 'no server', cleanupError: null })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action]'), expect.any(Error))
  })
})

describe('postMergePr', () => {
  test('a 2xx response resolves merged with no cleanup error and no banner', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { prNumber: '42' }))
    const result = await postMergePr('my-task', { fetchImpl, log: vi.fn() })
    expect(result).toEqual({ merged: true, cleanupError: null, banner: null })
  })

  // A cleanup failure returns this exact shape/wording — the merge button's
  // caller renders it as a persistent warning banner, not a button flash (see
  // actions.ts's own comment on why).
  test('a 2xx response carrying a cleanupError is reported, still counts as merged, and returns a warning banner', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { prNumber: '42', cleanupError: 'branch delete failed' }))
    const log = vi.fn()
    const result = await postMergePr('my-task', { fetchImpl, log })
    expect(result).toEqual({
      merged: true,
      cleanupError: 'branch delete failed',
      banner: { tone: 'warning', lines: ['Merged PR #42 and marked done — cleanup needs a hand:', 'branch delete failed'] },
    })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action]'), expect.any(Error))
  })

  test('a multi-part cleanupError ("a; b") splits into one banner line per part', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { prNumber: '42', cleanupError: 'worktree busy; branch delete failed' }))
    const result = await postMergePr('my-task', { fetchImpl, log: vi.fn() })
    expect(result.banner).toEqual({
      tone: 'warning',
      lines: ['Merged PR #42 and marked done — cleanup needs a hand:', 'worktree busy', 'branch delete failed'],
    })
  })

  test('a 409 conflict resolves not merged, logs [action], and returns an error banner split on newlines', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(409, { error: 'check A failing\ncheck B failing' }))
    const log = vi.fn()
    const result = await postMergePr('my-task', { fetchImpl, log })
    expect(result).toEqual({ merged: false, cleanupError: null, banner: { tone: 'error', lines: ['check A failing', 'check B failing'] } })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action]'), expect.any(Error))
  })

  test('a non-409 failure returns a single-line error banner from the server message, or a generic one', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, {}))
    const result = await postMergePr('my-task', { fetchImpl, log: vi.fn() })
    expect(result.banner).toEqual({ tone: 'error', lines: ['failed (HTTP 500)'] })
  })

  test('a network failure resolves not merged with a "no server" error banner', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('down'))
    const result = await postMergePr('my-task', { fetchImpl, log: vi.fn() })
    expect(result).toEqual({ merged: false, cleanupError: null, banner: { tone: 'error', lines: ['no server'] } })
  })
})

describe('postSkipStage', () => {
  test('a 2xx response resolves ok and sends the stage in a JSON body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    const result = await postSkipStage('my-task', 'qa-fixes', { fetchImpl, log: vi.fn() })
    expect(result).toEqual({ ok: true, label: '✓ skipped' })
    expect(fetchImpl).toHaveBeenCalledWith('/skip-stage/my-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'qa-fixes' }),
    })
  })

  test('a failure response resolves not-ok with a "failed" label and logs [action]', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
    const log = vi.fn()
    const result = await postSkipStage('my-task', 'qa-fixes', { fetchImpl, log })
    expect(result).toEqual({ ok: false, label: 'failed' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action]'), expect.any(Error))
  })
})

// FocusButton needs the full status-code mapping, not postAction's generic ok/not-ok/404 split — 202/409/503/403 are
// all meaningfully different outcomes a plain "failed" would flatten.
describe('postFocus', () => {
  test('200 resolves ok', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    const result = await postFocus('my-task', { fetchImpl, log: vi.fn() })
    expect(result).toEqual({ ok: true, label: '✓' })
    expect(fetchImpl).toHaveBeenCalledWith('/focus/my-task', { method: 'POST' })
  })

  test('202 resolves ok with the resuming-via-orchestrator label', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 202 }))
    const result = await postFocus('my-task', { fetchImpl, log: vi.fn() })
    expect(result).toEqual({ ok: true, label: '↻ resuming via orchestrator' })
  })

  test('409 resolves not-ok with "reattached — click again" and logs [action]', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 409 }))
    const log = vi.fn()
    const result = await postFocus('my-task', { fetchImpl, log })
    expect(result).toEqual({ ok: false, label: 'reattached — click again' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action]'), expect.any(Error))
  })

  test('503 resolves not-ok with "no orchestrator"', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 503 }))
    const result = await postFocus('my-task', { fetchImpl, log: vi.fn() })
    expect(result).toEqual({ ok: false, label: 'no orchestrator' })
  })

  test('403 resolves not-ok with "read-only instance"', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 403 }))
    const result = await postFocus('my-task', { fetchImpl, log: vi.fn() })
    expect(result).toEqual({ ok: false, label: 'read-only instance' })
  })

  test('a network failure resolves not-ok with "no server" and logs [action]', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('down'))
    const log = vi.fn()
    const result = await postFocus('my-task', { fetchImpl, log })
    expect(result).toEqual({ ok: false, label: 'no server' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action]'), expect.any(Error))
  })
})

// HandoverPill dispatches through this, not postAction — a bodyless staging
// POST with its own response shape (submitted vs staged) and 409/503/403
// mapping.
describe('postHandover', () => {
  test('a submitted response resolves ok with the "sent" label', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ submitted: true }), { status: 200 }))
    const result = await postHandover('my-task', { fetchImpl, log: vi.fn() })
    expect(result).toEqual({ ok: true, label: '✓ sent' })
    expect(fetchImpl).toHaveBeenCalledWith('/pipelinely-handover/my-task', { method: 'POST' })
  })

  test('a staged-not-submitted response resolves ok with the "staged" label', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ submitted: false }), { status: 200 }))
    const result = await postHandover('my-task', { fetchImpl, log: vi.fn() })
    expect(result).toEqual({ ok: true, label: '✓ staged' })
  })

  test('409 resolves not-ok with "reattached — click again" and logs [action]', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 409 }))
    const log = vi.fn()
    const result = await postHandover('my-task', { fetchImpl, log })
    expect(result).toEqual({ ok: false, label: 'reattached — click again' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action]'), expect.any(Error))
  })

  test('503 surfaces the server\'s own error message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'no session found' }), { status: 503 }))
    const result = await postHandover('my-task', { fetchImpl, log: vi.fn() })
    expect(result).toEqual({ ok: false, label: 'no session found' })
  })

  test('a network failure resolves not-ok with "no server" and logs [action]', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('down'))
    const log = vi.fn()
    const result = await postHandover('my-task', { fetchImpl, log })
    expect(result).toEqual({ ok: false, label: 'no server' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action]'), expect.any(Error))
  })
})

describe('postOrchestratorHandover', () => {
  test('POSTs the orchestrator route, bodyless, and maps a staged response like the task handover', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ submitted: false }), { status: 200 }))
    const result = await postOrchestratorHandover({ fetchImpl, log: vi.fn() })
    expect(result).toEqual({ ok: true, label: '✓ staged' })
    expect(fetchImpl).toHaveBeenCalledWith('/orchestrator/pipelinely-handover', { method: 'POST' })
  })

  test('a 503 surfaces the server\'s message and logs which route failed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'no orchestrator session' }), { status: 503 }))
    const log = vi.fn()
    const result = await postOrchestratorHandover({ fetchImpl, log })
    expect(result).toEqual({ ok: false, label: 'no orchestrator session' })
    expect(log).toHaveBeenCalledWith('[action] POST /orchestrator/pipelinely-handover failed', expect.any(Error))
  })
})

describe('postHelpFeedback', () => {
  test('POSTs the message as JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ submitted: false }), { status: 200 }))
    const result = await postHelpFeedback('it broke', { fetchImpl, log: vi.fn() })
    expect(result).toEqual({ ok: true, label: '✓ staged' })
    expect(fetchImpl).toHaveBeenCalledWith('/help/pipelinely-feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'it broke' }),
    })
  })

  test('a network failure resolves not-ok with "no server" and logs', async () => {
    const log = vi.fn()
    const result = await postHelpFeedback('x', { fetchImpl: vi.fn().mockRejectedValue(new Error('down')), log })
    expect(result).toEqual({ ok: false, label: 'no server' })
    expect(log).toHaveBeenCalledWith('[action] POST /help/pipelinely-feedback failed', expect.any(Error))
  })
})

describe('postOrchestratorTab', () => {
  test('a 2xx resolves ok with the ✓ label', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    expect(await postOrchestratorTab({ fetchImpl, log: vi.fn() })).toEqual({ ok: true, label: '✓' })
    expect(fetchImpl).toHaveBeenCalledWith('/orchestrator/tab', { method: 'POST' })
  })

  test('a non-2xx surfaces the server\'s own message and logs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'orchestrator not running' }), { status: 503 }))
    const log = vi.fn()
    expect(await postOrchestratorTab({ fetchImpl, log })).toEqual({ ok: false, label: 'orchestrator not running' })
    expect(log).toHaveBeenCalledWith('[action] POST /orchestrator/tab failed', expect.any(Error))
  })

  test('a non-2xx with no readable body falls back to "failed"', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<html>', { status: 500 }))
    expect(await postOrchestratorTab({ fetchImpl, log: vi.fn() })).toEqual({ ok: false, label: 'failed' })
  })

  test('a thrown fetch resolves "no server" and logs', async () => {
    const log = vi.fn()
    expect(await postOrchestratorTab({ fetchImpl: vi.fn().mockRejectedValue(new Error('down')), log })).toEqual({ ok: false, label: 'no server' })
    expect(log).toHaveBeenCalledWith('[action] POST /orchestrator/tab failed', expect.any(Error))
  })
})

describe('postAutoMode', () => {
  test('POSTs the new value as JSON and resolves true on 2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    expect(await postAutoMode(true, { fetchImpl, log: vi.fn() })).toBe(true)
    expect(fetchImpl).toHaveBeenCalledWith('/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoMode: true }),
    })
  })

  test('a non-2xx resolves false and logs with the [settings] prefix', async () => {
    const log = vi.fn()
    expect(await postAutoMode(false, { fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 500 })), log })).toBe(false)
    expect(log).toHaveBeenCalledWith('[settings] POST /settings failed', expect.any(Error))
  })

  test('a thrown fetch resolves false and logs', async () => {
    const log = vi.fn()
    expect(await postAutoMode(true, { fetchImpl: vi.fn().mockRejectedValue(new Error('down')), log })).toBe(false)
    expect(log).toHaveBeenCalledWith('[settings] POST /settings failed', expect.any(Error))
  })
})

describe('postStageSkill', () => {
  test('POSTs the stage and the autoSubmit flag as JSON to /stage-skill/:slug', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { submitted: false }))

    await postStageSkill('my-task', 'code-review', true, { fetchImpl, log: vi.fn() })

    expect(fetchImpl).toHaveBeenCalledWith('/stage-skill/my-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'code-review', autoSubmit: true }),
    })
  })

  test('labels a 2xx by what the server actually did — sent vs merely staged', async () => {
    const staged = vi.fn().mockResolvedValue(jsonResponse(200, { submitted: false }))
    const sent = vi.fn().mockResolvedValue(jsonResponse(200, { submitted: true }))
    expect(await postStageSkill('t', 'dev', false, { fetchImpl: staged, log: vi.fn() })).toEqual({ ok: true, label: '✓ staged' })
    expect(await postStageSkill('t', 'dev', true, { fetchImpl: sent, log: vi.fn() })).toEqual({ ok: true, label: '✓ sent' })
  })

  test('a 2xx with an unreadable body still counts as staged', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }))
    expect(await postStageSkill('t', 'dev', false, { fetchImpl, log: vi.fn() })).toEqual({ ok: true, label: '✓ staged' })
  })

  test('a 409 asks the user to click again and logs [action]', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 409 }))
    const log = vi.fn()

    const result = await postStageSkill('t', 'dev', false, { fetchImpl, log })

    expect(result).toEqual({ ok: false, label: 'reattached — click again' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action]'), expect.any(Error))
  })

  test('a 503 surfaces the server\'s own message and logs [action]', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(503, { error: 'no session found' }))
    const log = vi.fn()

    const result = await postStageSkill('t', 'dev', false, { fetchImpl, log })

    expect(result).toEqual({ ok: false, label: 'no session found' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('/stage-skill/t'), expect.any(Error))
  })

  test('a failure with no readable message falls back to not found / failed by status', async () => {
    const notFound = vi.fn().mockResolvedValue(new Response(null, { status: 404 }))
    const broken = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
    expect((await postStageSkill('t', 'dev', false, { fetchImpl: notFound, log: vi.fn() })).label).toBe('not found')
    expect((await postStageSkill('t', 'dev', false, { fetchImpl: broken, log: vi.fn() })).label).toBe('failed')
  })

  test('a network failure resolves not-ok with a "no server" label and logs [action]', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'))
    const log = vi.fn()

    const result = await postStageSkill('t', 'dev', false, { fetchImpl, log })

    expect(result).toEqual({ ok: false, label: 'no server' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action]'), expect.any(Error))
  })
})

describe('postWeeklyFocus', () => {
  test('POSTs the text as JSON to /weekly-focus', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    const result = await postWeeklyFocus('ship it', { fetchImpl, log: vi.fn() })
    expect(result).toEqual({ ok: true, label: '✓' })
    expect(fetchImpl).toHaveBeenCalledWith('/weekly-focus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'ship it' }),
    })
  })

  test('a non-2xx response resolves not-ok and logs [action]', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
    const log = vi.fn()
    expect(await postWeeklyFocus('x', { fetchImpl, log })).toEqual({ ok: false, label: 'failed' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action] POST /weekly-focus'), expect.any(Error))
  })

  test('a network failure resolves "no server" and logs [action]', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('down'))
    const log = vi.fn()
    expect(await postWeeklyFocus('x', { fetchImpl, log })).toEqual({ ok: false, label: 'no server' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action] POST /weekly-focus'), expect.any(Error))
  })
})

describe('postTriage', () => {
  test('POSTs the selected indexes as JSON to the given triage endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))

    const result = await postTriage('qa-triage', 'my-task', [0, 2], { fetchImpl, log: vi.fn() })

    expect(result).toEqual({ ok: true, label: '✓' })
    expect(fetchImpl).toHaveBeenCalledWith('/qa-triage/my-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selected: [0, 2] }),
    })
  })

  test('a non-2xx response resolves not-ok and logs a [triage] error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
    const log = vi.fn()

    const result = await postTriage('triage', 'my-task', [], { fetchImpl, log })

    expect(result).toEqual({ ok: false, label: 'failed' })
    expect(log).toHaveBeenCalledWith('[triage] POST /triage/my-task failed', expect.any(Error))
  })

  test('a network failure resolves not-ok and logs a [triage] error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'))
    const log = vi.fn()

    const result = await postTriage('triage', 'my-task', [1], { fetchImpl, log })

    expect(result).toEqual({ ok: false, label: 'no server' })
    expect(log).toHaveBeenCalledWith('[triage] POST /triage/my-task failed', expect.any(Error))
  })
})

describe('postTaskAutoMode', () => {
  test('posts the override as JSON to the task\'s own route and resolves true on 2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    const log = vi.fn()

    expect(await postTaskAutoMode('my-task', 'manual', { fetchImpl, log })).toBe(true)

    expect(fetchImpl).toHaveBeenCalledWith('/task-auto-mode/my-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ override: 'manual' }),
    })
    expect(log).not.toHaveBeenCalled()
  })

  test('a non-2xx response resolves false and logs the status', async () => {
    const log = vi.fn()
    expect(await postTaskAutoMode('my-task', 'auto', { fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 400 })), log })).toBe(false)
    expect(log).toHaveBeenCalledWith('[action] POST /task-auto-mode/my-task failed', new Error('HTTP 400'))
  })

  test('a network failure resolves false and logs the error', async () => {
    const log = vi.fn()
    expect(await postTaskAutoMode('my-task', 'auto', { fetchImpl: vi.fn().mockRejectedValue(new Error('down')), log })).toBe(false)
    expect(log).toHaveBeenCalledWith('[action] POST /task-auto-mode/my-task failed', expect.any(Error))
  })
})

describe('postAnswerDialog', () => {
  const REQUEST = { session: 'worker-demo', option: 2, fingerprint: '0123456789abcdef' }

  test('posts JSON with exactly the session, the option and the fingerprint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { outcome: 'answered' }))

    await postAnswerDialog('demo-task', REQUEST, { fetchImpl, log: vi.fn() })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/answer-dialog/demo-task')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init.body)).toEqual(REQUEST)
  })

  test('a Cancel request carries the cancel option, not a number', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { outcome: 'answered' }))
    await postAnswerDialog('demo-task', { ...REQUEST, option: 'cancel' }, { fetchImpl, log: vi.fn() })
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).option).toBe('cancel')
  })

  test('200 is answered and is not logged as a failure', async () => {
    const log = vi.fn()
    const result = await postAnswerDialog('demo-task', REQUEST, { fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, { outcome: 'answered' })), log })
    expect(result.outcome).toBe('answered')
    expect(result.message).not.toBe('')
    expect(log).not.toHaveBeenCalled()
  })

  test.each([
    ['no body', new Response('', { status: 200 })],
    ['an HTML page', new Response('<html>', { status: 200 })],
    ['a different outcome', jsonResponse(200, { outcome: 'something-else' })],
  ])('a 200 with %s is not answered: it is failed, says to check the terminal, and is logged', async (_case, response) => {
    const log = vi.fn()
    const result = await postAnswerDialog('demo-task', REQUEST, { fetchImpl: vi.fn().mockResolvedValue(response), log })
    expect(result.outcome).toBe('failed')
    expect(result.message).toMatch(/terminal/i)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action] POST /answer-dialog/demo-task'), expect.any(Error))
  })

  test('202 is unconfirmed, says to check the terminal, and is logged', async () => {
    const log = vi.fn()
    const body = { outcome: 'unconfirmed', error: 'The key was sent, but the dialog is still showing. Check the terminal.' }
    const result = await postAnswerDialog('demo-task', REQUEST, { fetchImpl: vi.fn().mockResolvedValue(jsonResponse(202, body)), log })
    expect(result).toEqual({ outcome: 'unconfirmed', message: body.error })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action] POST /answer-dialog/demo-task'), expect.any(Error))
  })

  test.each([
    [409, 'dialog-changed', 'The dialog changed since you last saw it, so nothing was sent.'],
    [409, 'no-dialog', 'The worker is no longer showing a dialog, so nothing was sent.'],
    [403, 'not-canonical', 'Only the main dashboard can answer.'],
    [403, 'remote', 'Answering is only available on this machine.'],
    [502, 'send-failed', 'Sending the key may have failed, so check the terminal before answering again: boom'],
  ])('%i %s resolves to that reason with the server\'s own sentence, and is logged', async (status, reason, error) => {
    const log = vi.fn()
    const result = await postAnswerDialog('demo-task', REQUEST, { fetchImpl: vi.fn().mockResolvedValue(jsonResponse(status, { reason, error })), log })
    expect(result).toEqual({ outcome: reason, message: error })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action] POST /answer-dialog/demo-task'), expect.any(Error))
  })

  test('an error status with no readable body is failed and names the status', async () => {
    const log = vi.fn()
    const result = await postAnswerDialog('demo-task', REQUEST, { fetchImpl: vi.fn().mockResolvedValue(new Response('<html>', { status: 500 })), log })
    expect(result.outcome).toBe('failed')
    expect(result.message).toContain('500')
    expect(log).toHaveBeenCalled()
  })

  test('a network failure is no-server, tells the developer to check the terminal, and is logged', async () => {
    const log = vi.fn()
    const result = await postAnswerDialog('demo-task', REQUEST, { fetchImpl: vi.fn().mockRejectedValue(new Error('down')), log })
    expect(result.outcome).toBe('no-server')
    expect(result.message).toMatch(/terminal/i)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action] POST /answer-dialog/demo-task'), expect.any(Error))
  })

  test.each([
    [500, 'internal', 'Answering failed unexpectedly, so it is unknown whether a key was sent. Check the terminal.'],
    [403, 'not-canonical', 'Only the main dashboard can answer.'],
  ])('%i %s, an inline body the server sends, resolves to that reason', async (status, reason, error) => {
    const result = await postAnswerDialog('demo-task', REQUEST, { fetchImpl: vi.fn().mockResolvedValue(jsonResponse(status, { reason, error })), log: vi.fn() })
    expect(result).toEqual({ outcome: reason, message: error })
  })

  test('a reason this route never sends is not trusted: it is failed and says it is unknown whether the key was sent', async () => {
    const log = vi.fn()
    const result = await postAnswerDialog('demo-task', REQUEST, { fetchImpl: vi.fn().mockResolvedValue(jsonResponse(409, { reason: 'made-up', error: 'Nothing to see.' })), log })
    expect(result.outcome).toBe('failed')
    expect(result.message).toMatch(/unknown whether the key was sent/i)
    expect(log).toHaveBeenCalled()
  })

  test('an error status with no readable body does not say the server refused, since a key may have gone out', async () => {
    const result = await postAnswerDialog('demo-task', REQUEST, { fetchImpl: vi.fn().mockResolvedValue(new Response('<html>', { status: 502 })), log: vi.fn() })
    expect(result.message).not.toMatch(/refused/i)
    expect(result.message).toMatch(/unknown whether the key was sent/i)
  })

  test('a URL-unsafe slug is percent-encoded', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { outcome: 'answered' }))
    await postAnswerDialog('a/b c', REQUEST, { fetchImpl, log: vi.fn() })
    expect(fetchImpl.mock.calls[0][0]).toBe('/answer-dialog/a%2Fb%20c')
  })
})

describe('isNothingSent', () => {
  test.each([
    'dialog-changed', 'no-dialog', 'busy', 'unknown-option', 'session-not-owned', 'capture-failed', 'audit-failed',
    'not-json', 'remote', 'bad-host', 'cross-site', 'not-canonical', 'bad-request', 'unknown-task',
  ] as const)('%s proves nothing was sent', (outcome) => {
    expect(isNothingSent(outcome)).toBe(true)
  })

  test.each(['answered', 'unconfirmed', 'send-failed', 'internal', 'no-server', 'failed'] as const)('%s does not: a key went out or may have', (outcome) => {
    expect(isNothingSent(outcome)).toBe(false)
  })
})
