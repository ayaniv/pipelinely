import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { makeMilestone, makeTask } from '../../testing/makeTask'
import { ProjectSummary } from './ProjectSummary'

const session = (overrides = {}) => ({ n: 1, contextPct: 40, inputTokens: 1_000_000, outputTokens: 0, current: false, stage: null, sessionId: null, startedAt: null, updatedAt: null, ...overrides })

describe('ProjectSummary', () => {
  test('counts merged milestones against the declared total, one dot per milestone in its state', () => {
    const task = makeTask({ milestones: [makeMilestone({ id: 'M0', state: 'done' }), makeMilestone({ id: 'M1', state: 'dispatched' }), makeMilestone({ id: 'M2' })] })
    const { container } = render(<ProjectSummary task={task} />)

    expect(screen.getByTestId('milestone-progress-label')).toHaveTextContent('1 of 3 milestones merged')
    expect(container.querySelectorAll('.ms-dot')).toHaveLength(3)
    expect(container.querySelector('.ms-dot-done')).toHaveAttribute('title', 'M0: M0 — Merged')
    expect(container.querySelector('.ms-dot-dispatched')).not.toBeNull()
    expect(container.querySelector('.ms-dot-queued')).not.toBeNull()
  })

  test('rolls the stats up across the parent and its dispatched milestones, naming the hottest session', () => {
    const milestoneChild = makeTask({ slug: 'p-m0', model: 'claude-sonnet-5', sessions: [session({ stage: 'dev', contextPct: 70 })] })
    const task = makeTask({ model: 'claude-sonnet-5', sessions: [session({ stage: 'planning', contextPct: 30 })], milestones: [makeMilestone({ id: 'M0', state: 'dispatched', task: milestoneChild })] })
    render(<ProjectSummary task={task} />)

    expect(screen.getByTestId('sess-count')).toHaveTextContent('2')
    expect(screen.getByTestId('ctx-value')).toHaveTextContent('70%')
    expect(screen.getByTestId('ctx-sub')).toHaveTextContent('last known · M0 · dev')
  })

  test('warns on a live ctx past the threshold', () => {
    const task = makeTask({ sessions: [session({ contextPct: 90, current: true })], milestones: [makeMilestone({ id: 'M0' })] })
    const { container } = render(<ProjectSummary task={task} />)
    expect(container.querySelector('.ctx-high')).not.toBeNull()
  })

  test('with no declared milestones it reads 0 of 0 instead of throwing', () => {
    render(<ProjectSummary task={makeTask({ milestones: undefined })} />)
    expect(screen.getByTestId('milestone-progress-label')).toHaveTextContent('0 of 0 milestones merged')
  })
})
