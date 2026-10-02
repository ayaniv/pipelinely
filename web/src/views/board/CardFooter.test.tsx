import { describe, expect, test, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CardFooter } from './CardFooter'
import { makeTask } from './testTask'
import type { ResultDocMeta } from '../../../../src/types'

// The design's ONE footer CTA per card. Three
// shapes — a dispatchable next stage, a merge-ready trio, and "See details".

const okJson = (body: unknown = {}, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('CardFooter: stage CTA', () => {
  const waitingForDev = () => makeTask({ status: 'waiting', attentionStatus: 'needs-you', waitingReason: 'plan reviewed, ready for dev' })

  test('offers the stage the waiting reason names, carrying its data attributes and primary state', () => {
    render(<CardFooter task={waitingForDev()} />)
    const cta = screen.getByTestId('card-cta-btn')
    expect(cta).toHaveTextContent('Start dev')
    expect(cta).toHaveAttribute('data-action', 'stage-skill')
    expect(cta).toHaveAttribute('data-stage', 'dev')
    expect(cta).toHaveAttribute('data-primary', 'true')
    expect(cta).toHaveClass('btn-primary')
  })

  test('is not primary when the task does not want you', () => {
    render(<CardFooter task={makeTask({ status: 'waiting', attentionStatus: 'idle', waitingReason: 'PR open, ready for CR' })} />)
    const cta = screen.getByTestId('card-cta-btn')
    expect(cta).toHaveAttribute('data-primary', 'false')
    expect(cta).not.toHaveClass('btn-primary')
  })

  test('clicking posts the stage with the auto-submit choice and flashes "staged"', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okJson({ submitted: false }))
    render(<CardFooter task={waitingForDev()} fetchImpl={fetchImpl} isAutoSubmitEnabled={() => true} />)

    fireEvent.click(screen.getByTestId('card-cta-btn'))

    await waitFor(() => expect(screen.getByTestId('card-cta-btn')).toHaveClass('btn-ok'))
    expect(screen.getByTestId('card-cta-btn')).toHaveTextContent('✓ staged')
    expect(fetchImpl).toHaveBeenCalledWith('/stage-skill/demo-task', expect.objectContaining({ body: JSON.stringify({ stage: 'dev', autoSubmit: true }) }))
  })

  test('a server failure flashes the error and logs [action]', async () => {
    const log = vi.fn()
    render(<CardFooter task={waitingForDev()} fetchImpl={vi.fn().mockResolvedValue(okJson({}, 500))} log={log} />)

    fireEvent.click(screen.getByTestId('card-cta-btn'))

    await waitFor(() => expect(screen.getByTestId('card-cta-btn')).toHaveClass('btn-err'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action]'), expect.any(Error))
  })

  test('a milestone-declaring parent never offers a stage, even with a dispatchable waiting reason', () => {
    render(<CardFooter task={makeTask({ ...waitingForDevProps(), milestones: [{ id: 'M0' }] as never })} />)
    expect(screen.getByTestId('card-cta-btn')).toHaveTextContent('See details')
  })
})

function waitingForDevProps() {
  return { status: 'waiting' as const, waitingReason: 'plan reviewed, ready for dev' }
}

describe('CardFooter: See details', () => {
  test('a card with no next stage offers "See details", which opens the task', () => {
    const onOpenDetail = vi.fn()
    render(<CardFooter task={makeTask({ status: 'waiting', waitingReason: 'need sign-off' })} onOpenDetail={onOpenDetail} />)

    const cta = screen.getByTestId('card-cta-btn')
    expect(cta).toHaveTextContent('See details')
    expect(cta).toHaveAttribute('data-action', 'open-detail')
    fireEvent.click(cta)
    expect(onOpenDetail).toHaveBeenCalledWith('demo-task')
  })
})

describe('CardFooter: merge', () => {
  const mergeReady = () => makeTask({ stage: 'merge', reviewRef: '42', status: 'waiting', waitingReason: 'QA passed, ready to merge', attentionStatus: 'needs-you' })

  test('a task whose QA is not applicable gets Merge, not Start QA', () => {
    const task = makeTask({ stage: 'code-review', reviewRef: '42', status: 'waiting', waitingReason: 'CR approved, ready for QA', qaSkipReason: 'no e2e' })
    render(<CardFooter task={task} readMergeState={() => ({ banner: null, isInFlight: false })} />)
    expect(screen.getByTestId('card-merge-pr-btn')).toBeInTheDocument()
    expect(screen.queryByTestId('card-cta-btn')).toBeNull()
  })

  test('a task that needs QA still gets Start QA', () => {
    const task = makeTask({ stage: 'code-review', reviewRef: '42', status: 'waiting', waitingReason: 'CR approved, ready for QA', qaSkipReason: null })
    render(<CardFooter task={task} />)
    expect(screen.getByTestId('card-cta-btn')).toHaveTextContent('Start QA')
  })

  test('a merge-ready task gets Merge and Open PR instead of a CTA', () => {
    render(<CardFooter task={mergeReady()} readMergeState={() => ({ banner: null, isInFlight: false })} />)

    expect(screen.getByTestId('card-merge-pr-btn')).toHaveAttribute('data-action', 'merge-pr')
    expect(screen.getByTestId('card-merge-pr-btn')).toHaveAttribute('data-primary', 'true')
    expect(screen.getByTestId('card-open-pr-btn')).toBeInTheDocument()
    expect(screen.queryByTestId('card-cta-btn')).not.toBeInTheDocument()
  })

  test('a waiting reason that names a stage wins over the merge footer', () => {
    render(<CardFooter task={makeTask({ stage: 'merge', reviewRef: '42', status: 'waiting', waitingReason: 'plan reviewed, ready for dev' })} readMergeState={() => ({ banner: null, isInFlight: false })} />)
    expect(screen.getByTestId('card-cta-btn')).toBeInTheDocument()
    expect(screen.queryByTestId('card-merge-pr-btn')).not.toBeInTheDocument()
  })

  test('Merge hands off to the shared merge action and reflects its in-flight state', () => {
    const merge = vi.fn().mockResolvedValue({ merged: false, cleanupError: null })
    const { rerender } = render(<CardFooter task={mergeReady()} merge={merge} readMergeState={() => ({ banner: null, isInFlight: false })} />)

    fireEvent.click(screen.getByTestId('card-merge-pr-btn'))
    expect(merge).toHaveBeenCalledWith(expect.objectContaining({ slug: 'demo-task' }))

    rerender(<CardFooter task={mergeReady()} merge={merge} readMergeState={() => ({ banner: null, isInFlight: true })} />)
    expect(screen.getByTestId('card-merge-pr-btn')).toBeDisabled()
  })

  test('the shared state\'s persistent banner renders in the footer, one line per blocker', () => {
    render(<CardFooter task={mergeReady()} readMergeState={() => ({ banner: { tone: 'error', lines: ['checks failing', 'behind main'] }, isInFlight: false })} />)
    expect(screen.getAllByTestId('merge-banner-line')).toHaveLength(2)
  })

  test('a merge action that throws is logged with an [action] prefix', async () => {
    const log = vi.fn()
    const merge = vi.fn().mockRejectedValue(new Error('boom'))
    render(<CardFooter task={mergeReady()} merge={merge} log={log} readMergeState={() => ({ banner: null, isInFlight: false })} />)

    fireEvent.click(screen.getByTestId('card-merge-pr-btn'))

    await waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('[action]'), expect.any(Error)))
  })

  test('Open PR posts open-pr and flashes the outcome', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    render(<CardFooter task={mergeReady()} fetchImpl={fetchImpl} readMergeState={() => ({ banner: null, isInFlight: false })} />)

    fireEvent.click(screen.getByTestId('card-open-pr-btn'))

    await waitFor(() => expect(screen.getByTestId('card-open-pr-btn')).toHaveClass('btn-ok'))
    expect(fetchImpl).toHaveBeenCalledWith('/open-pr/demo-task', { method: 'POST' })
  })
})

describe('CardFooter: approved review with comments', () => {
  const comment = (selected: boolean) => ({ severity: 'should' as const, category: 'Bug', description: 'a comment', location: 'a.ts:1', selected })
  const approvedTask = (findings: ReturnType<typeof comment>[]) =>
    makeTask({ status: 'waiting', attentionStatus: 'needs-you', waitingReason: 'CR approved, ready for QA', findings })

  test('never offers Start QA while comments exist; with nothing selected it sends the developer to triage instead of staging cr-fixes', () => {
    const onOpenDetail = vi.fn()
    render(<CardFooter task={approvedTask([comment(false)])} onOpenDetail={onOpenDetail} />)
    const cta = screen.getByTestId('card-cta-btn')
    expect(cta).toHaveTextContent('Triage CR comments')
    expect(cta).toHaveAttribute('data-action', 'open-detail')

    fireEvent.click(cta)
    expect(onOpenDetail).toHaveBeenCalledWith('demo-task')
  })

  test('stages CR fixes once at least one comment is selected', () => {
    render(<CardFooter task={approvedTask([comment(false), comment(true)])} />)
    const cta = screen.getByTestId('card-cta-btn')
    expect(cta).toHaveTextContent('Run CR fixes')
    expect(cta).toHaveAttribute('data-stage', 'comment-fix')
  })

  test('an unparseable review (parse mismatch, no findings) also goes to triage', () => {
    const task = makeTask({ status: 'waiting', waitingReason: 'CR approved, ready for QA', findings: [], findingsParseMismatch: ['Should Fix: header says 2, parsed 0'] })
    render(<CardFooter task={task} />)
    expect(screen.getByTestId('card-cta-btn')).toHaveTextContent('Triage CR comments')
  })

  test('still offers Start QA when the review found no comments', () => {
    render(<CardFooter task={approvedTask([])} />)
    const cta = screen.getByTestId('card-cta-btn')
    expect(cta).toHaveTextContent('Start QA')
    expect(cta).toHaveAttribute('data-stage', 'qa')
  })
})

describe('CardFooter: Read result', () => {
  const resultDoc: ResultDocMeta = { file: 'AUDIT.md', isTruncated: false, totalBytes: 7, mtimeMs: 1000 }
  const readyForReview = (overrides = {}) => makeTask({ status: 'waiting', attentionStatus: 'needs-you', waitingReason: 'audit ready for developer review', resultDoc, ...overrides })

  test('a research task with a document, ready for review, offers "Read result" instead of "See details"', () => {
    render(<CardFooter task={readyForReview()} />)
    const cta = screen.getByTestId('card-cta-btn')
    expect(cta).toHaveTextContent('Read result')
    expect(cta).not.toHaveTextContent('See details')
    expect(cta).toHaveAttribute('data-action', 'open-result')
    expect(cta).toHaveAttribute('data-primary', 'true')
  })

  test('clicking opens the task on its Result tab', () => {
    const onOpenResult = vi.fn()
    render(<CardFooter task={readyForReview()} onOpenResult={onOpenResult} />)
    fireEvent.click(screen.getByTestId('card-cta-btn'))
    expect(onOpenResult).toHaveBeenCalledWith('demo-task')
  })

  test('keeps "See details" when the task is ready for review but has no document', () => {
    render(<CardFooter task={readyForReview({ resultDoc: null })} />)
    expect(screen.getByTestId('card-cta-btn')).toHaveTextContent('See details')
  })

  test('keeps "See details" when a document exists but the task is not ready for review', () => {
    render(<CardFooter task={readyForReview({ waitingReason: 'need sign-off' })} />)
    expect(screen.getByTestId('card-cta-btn')).toHaveTextContent('See details')
  })

  test('never replaces a real stage CTA', () => {
    render(<CardFooter task={readyForReview({ waitingReason: 'PR open, ready for CR' })} />)
    const cta = screen.getByTestId('card-cta-btn')
    expect(cta).toHaveAttribute('data-action', 'stage-skill')
    expect(cta).not.toHaveTextContent('Read result')
  })

  test('never replaces the merge footer', () => {
    const task = readyForReview({ stage: 'merge', reviewRef: '42', waitingReason: 'QA passed, ready to merge' })
    render(<CardFooter task={task} readMergeState={() => ({ banner: null, isInFlight: false })} />)
    expect(screen.getByTestId('card-merge-pr-btn')).toBeInTheDocument()
    expect(screen.queryByText('Read result')).not.toBeInTheDocument()
  })
})
