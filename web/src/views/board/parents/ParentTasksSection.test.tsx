import { beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { MilestoneStatus } from '../../../../../src/types'
import { makeTask } from '../testTask'
import { parentOpenStore } from '../../../data/parentOpen'
import { ParentTasksSection } from './ParentTasksSection'

function milestone(id: string, wave: number, state: MilestoneStatus['state']): MilestoneStatus {
  return { id, name: `${id} name`, needs: [], estimate: null, specFile: null, wave, task: null, state }
}
const PLAN_REVIEWED = [{ stage: 'plan-review' as const, at: '2026-01-01T00:00:00Z', note: '' }]
const parentA = makeTask({ slug: 'a', stageHistory: PLAN_REVIEWED, title: 'Parent A', milestones: [milestone('M1', 1, 'queued')] })
const parentB = makeTask({ slug: 'b', stageHistory: PLAN_REVIEWED, title: 'Parent B', milestones: [milestone('M1', 1, 'dispatched')] })

beforeEach(() => parentOpenStore.reset())

describe('ParentTasksSection', () => {
  test('renders nothing when there are no parents', () => {
    const { container } = render(<ParentTasksSection parents={[]} onRunWave={vi.fn()} onOpenPlan={vi.fn()} creaturePlacement="header" isCanonical />)
    expect(container).toBeEmptyDOMElement()
  })

  test('has a "Parent tasks · N" header in the group heading style, with the fading rule and no colour key', () => {
    render(<ParentTasksSection parents={[parentA, parentB]} onRunWave={vi.fn()} onOpenPlan={vi.fn()} creaturePlacement="header" isCanonical />)
    const section = screen.getByTestId('parent-tasks-section')
    expect(within(section).getByTestId('active-group-header')).toHaveTextContent('Parent tasks')
    expect(within(section).getByTestId('active-group-count')).toHaveTextContent('· 2')
    expect(section.querySelector('.active-group-rule')).toBeInTheDocument()
    expect(within(section).queryByTestId('parent-colour-key')).not.toBeInTheDocument()
  })

  test('one collapsed row per parent', () => {
    render(<ParentTasksSection parents={[parentA, parentB]} onRunWave={vi.fn()} onOpenPlan={vi.fn()} creaturePlacement="header" isCanonical />)
    expect(screen.getAllByTestId('parent-row').map((row) => row.dataset.slug)).toEqual(['a', 'b'])
    expect(screen.queryByTestId('parent-expanded')).not.toBeInTheDocument()
  })

  test('clicking a row opens it; clicking again closes it', () => {
    render(<ParentTasksSection parents={[parentA, parentB]} onRunWave={vi.fn()} onOpenPlan={vi.fn()} creaturePlacement="header" isCanonical />)
    const [rowA] = screen.getAllByTestId('parent-row-head')
    fireEvent.click(rowA)
    expect(screen.getAllByTestId('parent-expanded')).toHaveLength(1)
    fireEvent.click(rowA)
    expect(screen.queryByTestId('parent-expanded')).not.toBeInTheDocument()
  })

  test('open state is remembered for the session: it survives a remount', () => {
    const { unmount } = render(<ParentTasksSection parents={[parentA]} onRunWave={vi.fn()} onOpenPlan={vi.fn()} creaturePlacement="header" isCanonical />)
    fireEvent.click(screen.getByTestId('parent-row-head'))
    unmount()
    render(<ParentTasksSection parents={[parentA]} onRunWave={vi.fn()} onOpenPlan={vi.fn()} creaturePlacement="header" isCanonical />)
    expect(screen.getByTestId('parent-expanded')).toBeInTheDocument()
  })

  test('Run wave calls onRunWave with the parent task and wave, without opening the row', () => {
    const onRunWave = vi.fn()
    render(<ParentTasksSection parents={[parentA]} onRunWave={onRunWave} onOpenPlan={vi.fn()} creaturePlacement="header" isCanonical />)
    fireEvent.click(screen.getByTestId('parent-wave-btn'))
    expect(onRunWave).toHaveBeenCalledWith(parentA, 1)
    expect(screen.queryByTestId('parent-expanded')).not.toBeInTheDocument()
  })
})
