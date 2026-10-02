import { Suspense } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { Task } from '../../../../../src/types'
import { makeMilestone, makeTask } from '../../../testing/makeTask'
import { TaskDetailNavProvider, type TaskDetailNav, type TaskDetailNavApi } from '../detailNav'
import { GraphSlot } from './GraphSlot'

// The two graphs are React Flow and load lazily; what matters here is which one
// the slot picks and what it hands it.
vi.mock('./StageChainGraph', () => ({
  StageChainGraph: ({ child, stages }: { child: Task | null; stages: string }) => <div data-testid="stage-chain-stub" data-child={child?.slug ?? ''} data-stages={stages} />,
}))
vi.mock('./MilestoneGraph', () => ({
  MilestoneGraph: ({ milestones }: { milestones: unknown[] }) => <div data-testid="milestone-graph-stub" data-count={milestones.length} />,
}))

function renderSlot(task: Task, nav: Partial<TaskDetailNav> = {}) {
  const api: TaskDetailNavApi = {
    nav: { l1Tab: 'dev', l2Tab: null, milestoneId: null, ...nav },
    selectL1Tab: vi.fn(), selectStageTab: vi.fn(), selectMilestone: vi.fn(), leaveMilestone: vi.fn(),
  }
  // The slot suspends while its lazy chunk loads; TaskDetail owns the boundary.
  const { container } = render(<Suspense fallback={null}><TaskDetailNavProvider value={api}><GraphSlot task={task} /></TaskDetailNavProvider></Suspense>)
  return { api, container }
}

const parent = makeTask({ slug: 'proj', title: 'Big project', milestones: [makeMilestone({ id: 'M0', name: 'First' }), makeMilestone({ id: 'M1', name: 'Second', state: 'dispatched', task: makeTask({ slug: 'proj-m1' }) })] })

describe('GraphSlot', () => {
  test('a flat task gets the eight-stage chain', async () => {
    renderSlot(makeTask({ slug: 'flat' }))
    expect(await screen.findByTestId('stage-chain-stub')).toHaveAttribute('data-stages', 'flat')
  })

  test('a dispatched milestone child gets the six-stage chain', async () => {
    renderSlot(makeTask({ slug: 'proj-m1', projectTitle: 'Big project' }))
    expect(await screen.findByTestId('stage-chain-stub')).toHaveAttribute('data-stages', 'milestone')
  })

  test('a fan-out parent\'s Dev tab shows the project summary above the milestone graph', async () => {
    renderSlot(parent)

    expect(await screen.findByTestId('milestone-graph-stub')).toHaveAttribute('data-count', '2')
    expect(screen.getByTestId('project-summary-slot')).toBeInTheDocument()
    expect(screen.getByTestId('project-summary')).toBeInTheDocument()
  })

  test.each(['plan', 'plan-review'] as const)('a fan-out parent\'s %s tab draws no graph at all', (l1Tab) => {
    const { container } = renderSlot(parent, { l1Tab })
    expect(screen.queryByTestId('milestone-graph-stub')).toBeNull()
    expect(screen.queryByTestId('project-summary-slot')).toBeNull()
    expect(container).toBeEmptyDOMElement()
  })

  test('a drilled-into milestone shows its head and its own chain, and the head steps back to the list', async () => {
    const { api } = renderSlot(parent, { milestoneId: 'M1' })

    expect(await screen.findByTestId('stage-chain-stub')).toHaveAttribute('data-child', 'proj-m1')
    expect(screen.getByTestId('milestone-detail-head-slot')).toBeInTheDocument()
    expect(screen.queryByTestId('milestone-graph-stub')).toBeNull()

    fireEvent.click(screen.getByTestId('milestone-parent-link'))
    expect(api.leaveMilestone).toHaveBeenCalledTimes(1)
  })

  test('drilling into a milestone with no child draws the chain with no task, so every node reads pending', async () => {
    renderSlot(parent, { milestoneId: 'M0' })
    expect(await screen.findByTestId('stage-chain-stub')).toHaveAttribute('data-child', '')
  })

  test('a milestone the plan no longer declares falls back to the milestone graph', async () => {
    renderSlot(parent, { milestoneId: 'M9' })
    expect(await screen.findByTestId('milestone-graph-stub')).toBeInTheDocument()
  })
})
