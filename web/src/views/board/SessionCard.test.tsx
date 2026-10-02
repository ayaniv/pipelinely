import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, render, screen, fireEvent, within } from '@testing-library/react'
import { SessionCard } from './SessionCard'
import { makeTask } from './testTask'
import type { Task } from '../../../../src/types'

const NOW = new Date('2026-09-23T12:00:00Z').getTime()

function renderCard(task: Task, overrides: Partial<Parameters<typeof SessionCard>[0]> = {}) {
  const props = { task, now: NOW, isOffFocus: false, onToggleOffFocus: vi.fn(), onOpenDetail: vi.fn(), ...overrides }
  render(<SessionCard {...props} />)
  return props
}

describe('SessionCard: frame', () => {
  test('carries the attributes the board\'s specs and CSS key off', () => {
    renderCard(makeTask({ attentionStatus: 'needs-you', status: 'waiting', stage: 'qa', repo: 'acme-api' }))
    const card = screen.getByTestId('task-card')

    expect(card).toHaveAttribute('data-slug', 'demo-task')
    expect(card).toHaveAttribute('data-status', 'needs-you')
    expect(card).toHaveAttribute('data-lifecycle-status', 'waiting')
    expect(card).toHaveAttribute('data-stage', 'qa')
    expect(card).toHaveAttribute('data-repo', 'acme-api')
    expect(card).toHaveClass('card', 'session-card', 'card-waiting', 'is-needs-you')
  })

  test('an orphaned task is styled as waiting whatever its STATUS says', () => {
    renderCard(makeTask({ status: 'working', orphaned: true }))
    expect(screen.getByTestId('task-card')).toHaveClass('card-waiting')
    expect(screen.getByTestId('card-orphan-warning')).toBeInTheDocument()
  })

  test('shows the title, repo/slug row and relative time', () => {
    renderCard(makeTask({ title: 'Fix the thing', updatedAt: new Date(NOW - 5 * 60_000).toISOString() as never }))

    expect(screen.getByTestId('card-title')).toHaveAttribute('data-action', 'open-detail')
    expect(screen.getByTestId('task-card').querySelector('.card-slug-project')).toHaveTextContent('cockpit-ai')
    expect(screen.getByTestId('card-time')).toHaveTextContent('5m ago')
  })

  test('omits the project prefix for a task with no repo', () => {
    renderCard(makeTask({ repo: '' }))
    expect(screen.getByTestId('task-card').querySelector('.card-slug-project')).not.toBeInTheDocument()
  })

  test('shows the auto-mode badge only when auto mode is on', () => {
    const { unmount } = render(<SessionCard task={makeTask({ autoMode: true })} now={NOW} isOffFocus={false} onToggleOffFocus={vi.fn()} onOpenDetail={vi.fn()} />)
    expect(screen.getByTestId('card-auto-badge')).toBeInTheDocument()
    unmount()
    renderCard(makeTask({ autoMode: false }))
    expect(screen.queryByTestId('card-auto-badge')).not.toBeInTheDocument()
  })

  test('marks an off-focus card with the drift pill', () => {
    renderCard(makeTask(), { isOffFocus: true })
    expect(screen.getByTestId('task-card').querySelector('.drift-pill')).toBeInTheDocument()
  })

  test('the mini stage rail draws the five design buckets', () => {
    renderCard(makeTask({ stage: 'dev' }))
    expect(screen.getAllByTestId('mini-stage-node').map((n) => n.getAttribute('data-stage'))).toEqual(['planning', 'dev', 'cr', 'qa', 'merge'])
  })

  test('shows the parent-link chip only for a milestone child', () => {
    const { unmount } = render(<SessionCard task={makeTask({ projectTitle: 'Parent', projectBase: 'parent-slug' })} now={NOW} isOffFocus={false} onToggleOffFocus={vi.fn()} onOpenDetail={vi.fn()} />)
    expect(screen.getByTestId('ms-parent-link')).toHaveTextContent('Parent')
    unmount()
    renderCard(makeTask())
    expect(screen.queryByTestId('ms-parent-link')).not.toBeInTheDocument()
  })
})

describe('SessionCard: notes and warnings', () => {
  test('shows the waiting reason, or the paused reason, as the card note', () => {
    const { unmount } = render(<SessionCard task={makeTask({ waitingReason: 'need a decision' })} now={NOW} isOffFocus={false} onToggleOffFocus={vi.fn()} onOpenDetail={vi.fn()} />)
    expect(screen.getByTestId('card-note')).toHaveTextContent('need a decision')
    unmount()
    renderCard(makeTask({ status: 'paused', pausedReason: 'parked' }))
    expect(screen.getByTestId('card-note')).toHaveTextContent('parked')
  })

  test('warns about hot context at or above the warn threshold, but not below it', () => {
    const { unmount } = render(<SessionCard task={makeTask({ contextPct: 85 })} now={NOW} isOffFocus={false} onToggleOffFocus={vi.fn()} onOpenDetail={vi.fn()} />)
    expect(screen.getByTestId('card-ctx-warning')).toHaveTextContent('Context at 85%')
    unmount()
    renderCard(makeTask({ contextPct: 70 }))
    expect(screen.queryByTestId('card-ctx-warning')).not.toBeInTheDocument()
  })
})

describe('SessionCard: ctx row and footer', () => {
  test('the ctx meter uses the board card\'s testids', () => {
    renderCard(makeTask({ contextPct: 42 }))
    expect(screen.getByTestId('ctx-value')).toHaveTextContent('42%')
    expect(screen.getByTestId('ctx-meter-fill').style.width).toBe('42%')
  })

  test('a hot, parked task offers Handover; a hot but working one does not', () => {
    const { unmount } = render(<SessionCard task={makeTask({ contextPct: 74, status: 'paused', attentionStatus: 'paused' })} now={NOW} isOffFocus={false} onToggleOffFocus={vi.fn()} onOpenDetail={vi.fn()} />)
    expect(screen.getByTestId('card-handover')).toBeInTheDocument()
    unmount()
    renderCard(makeTask({ contextPct: 74, status: 'working' }))
    expect(screen.queryByTestId('card-handover')).not.toBeInTheDocument()
  })

  test('a working leaf has no footer; a working milestone parent keeps its own', () => {
    const { unmount } = render(<SessionCard task={makeTask({ status: 'working' })} now={NOW} isOffFocus={false} onToggleOffFocus={vi.fn()} onOpenDetail={vi.fn()} />)
    expect(screen.getByTestId('task-card').querySelector('.card-footer')).not.toBeInTheDocument()
    unmount()
    renderCard(makeTask({ status: 'working', milestones: [{ id: 'M0' }] as never }))
    expect(screen.getByTestId('task-card').querySelector('.card-footer')).toBeInTheDocument()
  })

  test('the header row holds the time, the terminal button and the menu, in that order', () => {
    renderCard(makeTask())
    const right = screen.getByTestId('task-card').querySelector('.card-header-right')!
    const order = [...right.children].map((el) => (el as HTMLElement).dataset.testid ?? el.className)
    expect(order[0]).toBe('card-time')
    expect(order[1]).toBe('focus-btn')
    expect(order[2]).toContain('card-menu-wrap')
  })
})

describe('SessionCard: opening the detail view', () => {
  test('clicking the title opens the task exactly once', () => {
    const { onOpenDetail } = renderCard(makeTask())
    fireEvent.click(screen.getByTestId('card-title'))
    expect(onOpenDetail).toHaveBeenCalledTimes(1)
    expect(onOpenDetail).toHaveBeenCalledWith('demo-task')
  })

  test('clicking blank card space opens the task', () => {
    const { onOpenDetail } = renderCard(makeTask())
    fireEvent.click(screen.getByTestId('task-card'))
    expect(onOpenDetail).toHaveBeenCalledWith('demo-task')
  })

  test('clicking a button inside the card does not also open it', () => {
    const { onOpenDetail } = renderCard(makeTask({ status: 'paused' }))
    fireEvent.click(within(screen.getByTestId('task-card')).getByTestId('resume-btn'))
    expect(onOpenDetail).not.toHaveBeenCalled()
  })

  test('clicking inside an open card menu does not open the task', () => {
    const { onOpenDetail } = renderCard(makeTask())
    fireEvent.click(screen.getByTestId('card-menu-btn'))
    fireEvent.click(screen.getByTestId('card-menu'))
    expect(onOpenDetail).not.toHaveBeenCalled()
  })

  test('the parent-link chip navigates to the parent, not to this card', () => {
    const onOpenDetail = vi.fn()
    render(<SessionCard task={makeTask({ projectTitle: 'Parent', projectBase: 'parent-slug' })} now={NOW} isOffFocus={false} onToggleOffFocus={vi.fn()} onOpenDetail={onOpenDetail} />)
    fireEvent.click(screen.getByTestId('ms-parent-link'))
    expect(onOpenDetail).toHaveBeenCalledTimes(1)
    expect(onOpenDetail).toHaveBeenCalledWith('parent-slug')
  })

  test('the card menu\'s off-focus item reports through onToggleOffFocus', () => {
    const { onToggleOffFocus } = renderCard(makeTask())
    fireEvent.click(screen.getByTestId('card-menu-btn'))
    fireEvent.click(screen.getByTestId('card-menu-toggle-off-focus'))
    expect(onToggleOffFocus).toHaveBeenCalledWith('demo-task')
  })
})

describe('SessionCard: approval callout', () => {
  const APPROVAL_PROMPT = { session: 'worker-demo-task', question: 'Proceed?', summary: 'Bash command — npm test', options: [{ number: 1, label: 'Yes' }, { number: 2, label: 'No' }], fingerprint: '0123456789abcdef' }

  function cardFor(task: Task) {
    return <SessionCard task={task} now={NOW} isOffFocus={false} onToggleOffFocus={vi.fn()} onOpenDetail={vi.fn()} />
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('shows the callout when the task has an approval prompt', () => {
    renderCard(makeTask({ approvalPrompt: APPROVAL_PROMPT }))
    expect(screen.getByTestId('card-approval')).toBeInTheDocument()
  })

  test('the callout clears when a push drops the prompt', () => {
    const { rerender } = render(cardFor(makeTask({ approvalPrompt: APPROVAL_PROMPT })))

    rerender(cardFor(makeTask({ approvalPrompt: null })))

    expect(screen.queryByTestId('card-approval')).not.toBeInTheDocument()
  })

  // The real sequence: the route's approvalTick() clears the prompt before
  // the response to the click lands.
  test('the callout clears when the prompt drops with an answer in flight, and the late response shows nothing', async () => {
    let resolveFetch: (res: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>((resolve) => { resolveFetch = resolve })))
    const { rerender } = render(cardFor(makeTask({ approvalPrompt: APPROVAL_PROMPT })))
    fireEvent.click(screen.getAllByTestId('card-approval-option')[0])

    rerender(cardFor(makeTask({ approvalPrompt: null })))
    await act(async () => { resolveFetch(new Response(JSON.stringify({ outcome: 'answered' }), { status: 200 })) })

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('card-approval')).not.toBeInTheDocument()
    expect(screen.queryByTestId('card-approval-result')).not.toBeInTheDocument()
  })

  test('has no callout when the task has no approval prompt', () => {
    renderCard(makeTask({ approvalPrompt: null }))
    expect(screen.queryByTestId('card-approval')).not.toBeInTheDocument()
  })
})
