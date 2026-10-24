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
  ParentChartGraph: ({ task }: { task: Task }) => <div data-testid="parent-chart-stub" data-task={task.slug} />,
}))
vi.mock('./WaveGraph', () => ({
  WaveGraph: ({ task }: { task: Task }) => <div data-testid="wave-graph-stub" data-task={task.slug} />,
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

  test.each(['planning', 'plan-review', 'dev', 'cr', 'qa', 'merge'] as const)('a fan-out parent draws its own chart on the %s stage', async (l1Tab) => {
    renderSlot(parent, { l1Tab })
    expect(await screen.findByTestId('parent-chart-stub')).toHaveAttribute('data-task', 'proj')
    expect(screen.queryByTestId('stage-chain-stub')).toBeNull()
  })

  test('the wave graph is the panel\'s now, so the slot never draws it or the project summary', async () => {
    renderSlot(parent)
    await screen.findByTestId('parent-chart-stub')
    expect(screen.queryByTestId('wave-graph-stub')).toBeNull()
    expect(screen.queryByTestId('project-summary-slot')).toBeNull()
  })

  test('a drilled-into milestone shows its head and its own chain, and the head steps back to the list', async () => {
    const { api } = renderSlot(parent, { milestoneId: 'M1' })

    expect(await screen.findByTestId('stage-chain-stub')).toHaveAttribute('data-child', 'proj-m1')
    expect(screen.getByTestId('milestone-detail-head-slot')).toBeInTheDocument()
    expect(screen.queryByTestId('parent-chart-stub')).toBeNull()

    fireEvent.click(screen.getByTestId('milestone-parent-link'))
    expect(api.leaveMilestone).toHaveBeenCalledTimes(1)
  })

  test('drilling into a milestone with no child draws the chain with no task, so every node reads pending', async () => {
    renderSlot(parent, { milestoneId: 'M0' })
    expect(await screen.findByTestId('stage-chain-stub')).toHaveAttribute('data-child', '')
  })

  test('a milestone the plan no longer declares falls back to the parent chart', async () => {
    renderSlot(parent, { milestoneId: 'M9' })
    expect(await screen.findByTestId('parent-chart-stub')).toBeInTheDocument()
  })
})
