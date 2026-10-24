import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { PushForwardOutcome } from '../../api/agentActions'
import { DEFAULT_DECISION_CONTEXT } from '../../../../src/nextAction'
import { PushForwardPill } from './PushForwardPill'
import { makeTask } from './testTask'

const state = () => screen.getByTestId('push-forward-pill').getAttribute('data-state')
const TASKS = [makeTask({ slug: 'merge-me', status: 'waiting', waitingReason: 'QA passed, ready to merge' })]

function deferred() {
  let resolve!: (outcome: PushForwardOutcome) => void
  const promise = new Promise<PushForwardOutcome>((done) => { resolve = done })
  return { promise, resolve }
}

function renderPill(push: () => Promise<PushForwardOutcome>, tasks = TASKS) {
  return render(<PushForwardPill tasks={tasks} decisionContext={DEFAULT_DECISION_CONTEXT} push={push} log={vi.fn()} />)
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('PushForwardPill', () => {
  test('starts idle', () => {
    renderPill(vi.fn())
    expect(state()).toBe('idle')
    expect(screen.getByTestId('push-forward-pill')).not.toHaveAttribute('data-planned')
  })

  test('runs until the request settles, then reports the server\'s planned count', async () => {
    const pending = deferred()
    renderPill(vi.fn().mockReturnValue(pending.promise))
    fireEvent.click(screen.getByTestId('push-forward-pill'))
    expect(state()).toBe('running')
    await act(async () => { pending.resolve({ ok: true, result: 'sent', planned: 2, label: '✓' }) })
    expect(state()).toBe('sent')
    expect(screen.getByTestId('push-forward-pill')).toHaveAttribute('data-planned', '2')
  })

  test('returns to idle after the result has been shown', async () => {
    renderPill(vi.fn().mockResolvedValue({ ok: true, result: 'sent', planned: 1, label: '✓' }))
    await act(async () => { fireEvent.click(screen.getByTestId('push-forward-pill')) })
    expect(state()).toBe('sent')
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(state()).toBe('idle')
  })

  test('nothing to push reads as nothing, with no planned count', async () => {
    renderPill(vi.fn().mockResolvedValue({ ok: false, result: 'nothing', label: 'nothing' }))
    await act(async () => { fireEvent.click(screen.getByTestId('push-forward-pill')) })
    expect(state()).toBe('nothing')
    expect(screen.getByTestId('push-forward-pill')).not.toHaveAttribute('data-planned')
  })

  test('a deferred sweep carries the load reading', async () => {
    renderPill(vi.fn().mockResolvedValue({ ok: false, result: 'deferred', load1: 12.4, label: 'deferred' }))
    await act(async () => { fireEvent.click(screen.getByTestId('push-forward-pill')) })
    expect(state()).toBe('deferred')
    expect(screen.getByTestId('push-forward-pill')).toHaveAttribute('data-load', '12.4')
  })

  test('a failure carries the server\'s reason as the title', async () => {
    renderPill(vi.fn().mockResolvedValue({ ok: false, result: 'failed', label: 'Orchestrator not running' }))
    await act(async () => { fireEvent.click(screen.getByTestId('push-forward-pill')) })
    expect(state()).toBe('failed')
    expect(screen.getByTestId('push-forward-pill')).toHaveAttribute('title', 'Orchestrator not running')
  })

  test('a request that throws reads as failed, never sent, and is logged', async () => {
    const log = vi.fn()
    render(<PushForwardPill tasks={TASKS} decisionContext={DEFAULT_DECISION_CONTEXT} push={vi.fn().mockRejectedValue(new Error('boom'))} log={log} />)
    await act(async () => { fireEvent.click(screen.getByTestId('push-forward-pill')) })
    expect(state()).toBe('failed')
    expect(log).toHaveBeenCalledWith('[agent-action] pushForward threw', expect.any(Error))
  })

  test('a double click sends one request', async () => {
    const pending = deferred()
    const push = vi.fn().mockReturnValue(pending.promise)
    renderPill(push)
    fireEvent.click(screen.getByTestId('push-forward-pill'))
    fireEvent.click(screen.getByTestId('push-forward-pill'))
    expect(push).toHaveBeenCalledTimes(1)
    await act(async () => { pending.resolve({ ok: true, result: 'sent', planned: 1, label: '✓' }) })
  })

  test('ignores a click while a result is still showing', async () => {
    const push = vi.fn().mockResolvedValue({ ok: true, result: 'sent', planned: 1, label: '✓' })
    renderPill(push)
    await act(async () => { fireEvent.click(screen.getByTestId('push-forward-pill')) })
    fireEvent.click(screen.getByTestId('push-forward-pill'))
    expect(push).toHaveBeenCalledTimes(1)
  })
})

describe('PushForwardPill: needs-you list', () => {
  test('the toggle counts the decisions and the panel lists each with its reason and slug', () => {
    renderPill(vi.fn())
    expect(screen.getByTestId('push-forward-needs-you-toggle')).toHaveAttribute('data-count', '1')
    expect(screen.queryByTestId('needs-you-panel')).toBeNull()
    fireEvent.click(screen.getByTestId('push-forward-needs-you-toggle'))
    const item = screen.getByTestId('needs-you-item')
    expect(item).toHaveAttribute('data-slug', 'merge-me')
    expect(item).toHaveAttribute('data-reason', 'merge')
  })

  test('routine steps the sweep would push are not listed', () => {
    const routine = makeTask({ slug: 'cr-ready', status: 'waiting', waitingReason: 'PR open, ready for CR' })
    renderPill(vi.fn(), [routine])
    expect(screen.getByTestId('push-forward-needs-you-toggle')).toHaveAttribute('data-count', '0')
    fireEvent.click(screen.getByTestId('push-forward-needs-you-toggle'))
    expect(screen.queryByTestId('needs-you-item')).toBeNull()
    expect(screen.getByTestId('needs-you-empty')).toBeInTheDocument()
  })

  test('the toggle closes the panel again', () => {
    renderPill(vi.fn())
    fireEvent.click(screen.getByTestId('push-forward-needs-you-toggle'))
    fireEvent.click(screen.getByTestId('push-forward-needs-you-toggle'))
    expect(screen.queryByTestId('needs-you-panel')).toBeNull()
  })

  test('a row opens that task', () => {
    const onOpenTask = vi.fn()
    render(<PushForwardPill tasks={TASKS} decisionContext={DEFAULT_DECISION_CONTEXT} push={vi.fn()} onOpenTask={onOpenTask} log={vi.fn()} />)
    fireEvent.click(screen.getByTestId('push-forward-needs-you-toggle'))
    fireEvent.click(screen.getByTestId('needs-you-item'))
    expect(onOpenTask).toHaveBeenCalledWith('merge-me')
  })

  test('Escape closes the panel', () => {
    renderPill(vi.fn())
    fireEvent.click(screen.getByTestId('push-forward-needs-you-toggle'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('needs-you-panel')).toBeNull()
  })

  test('a press outside closes the panel, a press inside does not', () => {
    renderPill(vi.fn())
    fireEvent.click(screen.getByTestId('push-forward-needs-you-toggle'))
    fireEvent.mouseDown(screen.getByTestId('needs-you-panel'))
    expect(screen.getByTestId('needs-you-panel')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByTestId('needs-you-panel')).toBeNull()
  })
})
