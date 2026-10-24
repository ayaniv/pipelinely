import { beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { makeMilestone, makeTask } from '../../../testing/makeTask'
import { ParentStageList } from './ParentStageList'

const { navigateToTask } = vi.hoisted(() => ({ navigateToTask: vi.fn() }))
vi.mock('../../../shell/appNavigation', () => ({ navigateToTask }))

const inStage = (id: string, stage: 'dev' | 'code-review' | 'qa' | 'merge') =>
  makeMilestone({ id, name: `Milestone ${id}`, state: 'dispatched', task: makeTask({ slug: `p-${id.toLowerCase()}`, stage }) })

beforeEach(() => navigateToTask.mockClear())

describe('ParentStageList', () => {
  test('lists only the milestones sitting in the stage, each as its own row', () => {
    render(<ParentStageList stage="cr" milestones={[inStage('M0', 'dev'), inStage('M1', 'code-review'), inStage('M2', 'qa')]} />)
    expect(screen.getAllByTestId('parent-stage-row').map((row) => row.dataset.milestoneId)).toEqual(['M1'])
  })

  test('a row opens the milestone\'s own page', () => {
    render(<ParentStageList stage="qa" milestones={[inStage('M2', 'qa')]} />)
    fireEvent.click(screen.getByTestId('parent-stage-row'))
    expect(navigateToTask).toHaveBeenCalledWith('p-m2')
  })

  test('says so when nothing is in the stage, instead of an empty list', () => {
    render(<ParentStageList stage="merge" milestones={[inStage('M0', 'dev'), makeMilestone({ id: 'M1' })]} />)
    expect(screen.getByTestId('parent-stage-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('parent-stage-list')).toBeNull()
  })

  test('the merge list also shows the milestones already merged, matching the node\'s "N of M merged"', () => {
    const merged = makeMilestone({ id: 'M0', state: 'done', task: makeTask({ slug: 'p-m0', status: 'done', stage: null }) })
    render(<ParentStageList stage="merge" milestones={[merged, inStage('M1', 'merge'), inStage('M2', 'dev')]} />)
    expect(screen.getAllByTestId('parent-stage-row').map((row) => row.dataset.milestoneId)).toEqual(['M0', 'M1'])
  })

  test('a merged milestone is not in the code review or QA lists', () => {
    const merged = makeMilestone({ id: 'M0', state: 'done', task: makeTask({ slug: 'p-m0', status: 'done', stage: null }) })
    render(<ParentStageList stage="qa" milestones={[merged]} />)
    expect(screen.getByTestId('parent-stage-empty')).toBeInTheDocument()
  })

  test('a listed milestone whose child has not loaded is shown but cannot be opened', () => {
    render(<ParentStageList stage="merge" milestones={[makeMilestone({ id: 'M0', state: 'done', task: null })]} />)
    const row = screen.getByTestId('parent-stage-row')
    expect(row).toBeDisabled()
    fireEvent.click(row)
    expect(navigateToTask).not.toHaveBeenCalled()
  })
})
