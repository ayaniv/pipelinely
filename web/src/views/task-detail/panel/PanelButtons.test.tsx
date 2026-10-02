import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Task } from '../../../../../src/types'
import { mergeTask } from '../../../api/mergeTask'
import { autoSubmitStore } from '../../../data/autoSubmit'
import { clientState } from '../../../data/clientState'
import { installAppNavigator } from '../../../shell/appNavigation'
import { rememberBoardTab } from '../../board/boardTabRoutes'
import { makeTask } from '../../../testing/makeTask'
import { ActionButton, MarkDoneButton, MergeButton, SkipButton, StageCtaButton } from './PanelButtons'

vi.mock('../../../api/mergeTask', () => ({ mergeTask: vi.fn() }))

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let navigate: Mock<(to: string, options?: { replace?: boolean }) => void>
let uninstallNavigator: () => void
const mergeTaskMock = vi.mocked(mergeTask)

// Closing the detail view is a navigation back to the board tab last shown.
const expectClosed = () => expect(navigate).toHaveBeenCalledWith('/done', undefined)
const expectNotClosed = () => expect(navigate).not.toHaveBeenCalled()

beforeEach(() => {
  navigate = vi.fn<(to: string, options?: { replace?: boolean }) => void>()
  uninstallNavigator = installAppNavigator(navigate)
  rememberBoardTab('done')
  vi.spyOn(autoSubmitStore, 'isEnabled').mockReturnValue(false)
  mergeTaskMock.mockReset()
  mergeTaskMock.mockResolvedValue({ merged: false, cleanupError: null })
})

afterEach(() => {
  uninstallNavigator()
  rememberBoardTab('inprogress')
  clientState.settleMerge('my-task', null)
  clientState.settleMerge('t', null)
  vi.restoreAllMocks()
})

describe('StageCtaButton', () => {
  test('a live CTA POSTs the stage with the auto-submit flag and flashes what the server did', async () => {
    vi.spyOn(autoSubmitStore, 'isEnabled').mockReturnValue(true)
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { submitted: true }))
    render(<StageCtaButton label="Start Dev" stage="dev" slug="my-task" isLive fetchImpl={fetchImpl} />)

    fireEvent.click(screen.getByTestId('l2-cta'))

    await waitFor(() => expect(screen.getByTestId('l2-cta')).toHaveTextContent('✓ sent'))
    expect(fetchImpl).toHaveBeenCalledWith('/stage-skill/my-task', expect.objectContaining({ body: JSON.stringify({ stage: 'dev', autoSubmit: true }) }))
    expect(screen.getByTestId('l2-cta')).toHaveClass('btn-ok')
  })

  test('is disabled for the whole request, so a double click sends one', async () => {
    let release!: (res: Response) => void
    const fetchImpl = vi.fn().mockReturnValue(new Promise<Response>((resolve) => { release = resolve }))
    render(<StageCtaButton label="Start Dev" stage="dev" slug="t" isLive fetchImpl={fetchImpl} />)

    fireEvent.click(screen.getByTestId('l2-cta'))
    await waitFor(() => expect(screen.getByTestId('l2-cta')).toBeDisabled())
    fireEvent.click(screen.getByTestId('l2-cta'))
    release(json(200, {}))

    await waitFor(() => expect(screen.getByTestId('l2-cta')).toBeEnabled())
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('a rejection flashes the server\'s message in the error style and logs', async () => {
    const log = vi.fn()
    const fetchImpl = vi.fn().mockResolvedValue(json(503, { error: 'no session found' }))
    render(<StageCtaButton label="Start Dev" stage="dev" slug="t" isLive fetchImpl={fetchImpl} log={log} />)

    fireEvent.click(screen.getByTestId('l2-cta'))

    await waitFor(() => expect(screen.getByTestId('l2-cta')).toHaveTextContent('no session found'))
    expect(screen.getByTestId('l2-cta')).toHaveClass('btn-err')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action]'), expect.any(Error))
  })

  test('a not-live CTA is disabled, explains why, carries no arrow, and never posts', () => {
    const fetchImpl = vi.fn()
    render(<StageCtaButton label="Start QA" stage="qa" slug="t" isLive={false} fetchImpl={fetchImpl} />)

    const button = screen.getByTestId('l2-cta')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', expect.stringContaining('Not ready yet'))
    expect(button.querySelector('svg')).toBeNull()
    fireEvent.click(button)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('a live CTA carries the primary arrow, and uses a caller-supplied testid', () => {
    render(<StageCtaButton label="Start Plan Review" stage="plan-review" slug="t" isLive testId="plan-review-cta" fetchImpl={vi.fn()} />)
    expect(screen.getByTestId('plan-review-cta').querySelector('svg')).not.toBeNull()
  })
})

describe('SkipButton', () => {
  test('a live Skip POSTs the stage to /skip-stage and flashes the outcome', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, {}))
    render(<SkipButton stage="comment-fix" slug="my-task" isLive fetchImpl={fetchImpl} />)

    fireEvent.click(screen.getByTestId('skip-cta'))

    await waitFor(() => expect(screen.getByTestId('skip-cta')).toHaveTextContent('✓ skipped'))
    expect(fetchImpl).toHaveBeenCalledWith('/skip-stage/my-task', expect.objectContaining({ body: JSON.stringify({ stage: 'comment-fix' }) }))
  })

  test('a failed Skip flashes the failure and logs', async () => {
    const log = vi.fn()
    render(<SkipButton stage="qa-fixes" slug="t" isLive fetchImpl={vi.fn().mockRejectedValue(new Error('down'))} log={log} />)

    fireEvent.click(screen.getByTestId('skip-cta'))

    await waitFor(() => expect(screen.getByTestId('skip-cta')).toHaveTextContent('no server'))
    expect(log).toHaveBeenCalled()
  })

  test('a not-live Skip is disabled and never posts', () => {
    const fetchImpl = vi.fn()
    render(<SkipButton stage="qa-fixes" slug="t" isLive={false} fetchImpl={fetchImpl} />)
    fireEvent.click(screen.getByTestId('skip-cta'))
    expect(screen.getByTestId('skip-cta')).toBeDisabled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('ActionButton', () => {
  test('POSTs the named action and flashes ✓', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    render(<ActionButton action="annotate-plan" slug="my-task" label="Open in Plannotator" testId="plannotator-btn" fetchImpl={fetchImpl} />)

    fireEvent.click(screen.getByTestId('plannotator-btn'))

    await waitFor(() => expect(screen.getByTestId('plannotator-btn')).toHaveClass('btn-ok'))
    expect(fetchImpl).toHaveBeenCalledWith('/annotate-plan/my-task', { method: 'POST' })
  })

  test('a failure flashes the error style and logs', async () => {
    const log = vi.fn()
    render(<ActionButton action="browse" slug="t" label="Browse App" testId="b" fetchImpl={vi.fn().mockResolvedValue(new Response(null, { status: 500 }))} log={log} />)

    fireEvent.click(screen.getByTestId('b'))

    await waitFor(() => expect(screen.getByTestId('b')).toHaveClass('btn-err'))
    expect(screen.getByTestId('b')).not.toHaveClass('btn-ok')
    expect(log).toHaveBeenCalled()
  })

  test('a disabled one never posts', () => {
    const fetchImpl = vi.fn()
    render(<ActionButton action="annotate-plan" slug="t" label="x" testId="b" disabled fetchImpl={fetchImpl} />)
    fireEvent.click(screen.getByTestId('b'))
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('MergeButton', () => {
  const task = (slug = 'my-task') => makeTask({ slug })

  test('hands the merge to the shared merge action, and closes the detail view when it merged cleanly', async () => {
    mergeTaskMock.mockResolvedValue({ merged: true, cleanupError: null })
    const merging = task()
    render(<MergeButton task={merging} openTaskSlug="my-task" />)

    fireEvent.click(screen.getByTestId('merge-pr-btn'))

    await waitFor(expectClosed)
    expect(mergeTaskMock).toHaveBeenCalledWith(merging)
  })

  test.each([
    ['a merge that left a cleanup warning (the banner must be read)', { merged: true, cleanupError: 'branch left behind' }, 'my-task'],
    ['a merge that did not happen', { merged: false, cleanupError: null }, 'my-task'],
    ['a milestone child merged from its parent\'s drill-down', { merged: true, cleanupError: null }, 'my-task-m1'],
  ])('leaves the detail view open after %s', async (_name, outcome, slug) => {
    mergeTaskMock.mockResolvedValue(outcome)
    render(<MergeButton task={task(slug)} openTaskSlug="my-task" />)

    fireEvent.click(screen.getByTestId('merge-pr-btn'))

    await waitFor(() => expect(mergeTaskMock).toHaveBeenCalled())
    await Promise.resolve()
    expectNotClosed()
  })

  test('is disabled while the shared state says a merge is in flight', () => {
    clientState.beginMerge('t')
    render(<MergeButton task={task('t')} openTaskSlug="t" />)
    expect(screen.getByTestId('merge-pr-btn')).toBeDisabled()
  })

  test('re-enables once the in-flight merge settles', async () => {
    clientState.beginMerge('t')
    render(<MergeButton task={task('t')} openTaskSlug="t" />)
    act(() => clientState.settleMerge('t', null))
    expect(screen.getByTestId('merge-pr-btn')).toBeEnabled()
  })

  test('logs a merge rejection instead of dropping it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mergeTaskMock.mockRejectedValue(new Error('boom'))
    render(<MergeButton task={task('t')} openTaskSlug="t" />)

    fireEvent.click(screen.getByTestId('merge-pr-btn'))

    await waitFor(() => expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[action]'), expect.any(Error)))
  })
})

describe('MarkDoneButton', () => {
  const child = (overrides: Partial<Task> = {}) => ({ slug: 'my-task', title: 'My task', worktree: null, branch: 'claude/my-task', ...overrides }) as Task

  test('marks done and closes the detail view of that same task', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, {}))
    render(<MarkDoneButton child={child()} openTaskSlug="my-task" isPrimary={false} fetchImpl={fetchImpl} />)

    fireEvent.click(screen.getByTestId('mark-done-btn'))

    await waitFor(expectClosed)
    expect(fetchImpl).toHaveBeenCalledWith('/mark-done/my-task', { method: 'POST' })
  })

  test('a milestone child marked done keeps its parent\'s view open', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, {}))
    render(<MarkDoneButton child={child({ slug: 'parent-m1' })} openTaskSlug="parent" isPrimary={false} fetchImpl={fetchImpl} />)

    fireEvent.click(screen.getByTestId('mark-done-btn'))

    await waitFor(() => expect(screen.getByTestId('mark-done-btn')).toHaveClass('btn-ok'))
    expectNotClosed()
  })

  test('declining the worktree-deletion confirm sends nothing and closes nothing', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const fetchImpl = vi.fn()
    render(<MarkDoneButton child={child({ worktree: '/wt' })} openTaskSlug="my-task" isPrimary={false} fetchImpl={fetchImpl} />)

    fireEvent.click(screen.getByTestId('mark-done-btn'))
    await Promise.resolve()

    expect(fetchImpl).not.toHaveBeenCalled()
    expectNotClosed()
  })

  test('a failure keeps the view open, flashes it and logs', async () => {
    const log = vi.fn()
    render(<MarkDoneButton child={child()} openTaskSlug="my-task" isPrimary={false} fetchImpl={vi.fn().mockRejectedValue(new Error('down'))} log={log} />)

    fireEvent.click(screen.getByTestId('mark-done-btn'))

    await waitFor(() => expect(screen.getByTestId('mark-done-btn')).toHaveTextContent('no server'))
    expectNotClosed()
    expect(log).toHaveBeenCalled()
  })

  test('a cleanup failure flashes it as an error but still counts as done, closing the view', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { cleanupError: 'worktree busy' }))
    render(<MarkDoneButton child={child()} openTaskSlug="my-task" isPrimary={false} fetchImpl={fetchImpl} log={vi.fn()} />)

    fireEvent.click(screen.getByTestId('mark-done-btn'))

    await waitFor(expectClosed)
  })

  test('carries the primary arrow only when it is the footer\'s primary', () => {
    const { rerender } = render(<MarkDoneButton child={child()} openTaskSlug="t" isPrimary />)
    expect(screen.getByTestId('mark-done-btn').querySelector('svg')).not.toBeNull()
    rerender(<MarkDoneButton child={child()} openTaskSlug="t" isPrimary={false} />)
    expect(screen.getByTestId('mark-done-btn').querySelector('svg')).toBeNull()
  })
})
