import { describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { Task } from '../../../../../src/types'
import { TaskDetailNavProvider, type TaskDetailNavApi } from '../detailNav'
import { L1Tabs } from './L1Tabs'

const at = '2026-08-10T10:00:00Z'
const taskWithHistory = (stages: string[]) => ({ stageHistory: stages.map((stage) => ({ stage, at, note: '' })) }) as unknown as Task

function renderTabs(task: Task, activeTab: 'plan' | 'plan-review' | 'dev') {
  const api: TaskDetailNavApi = { nav: { l1Tab: activeTab, l2Tab: null, milestoneId: null }, selectL1Tab: vi.fn(), selectStageTab: vi.fn(), selectMilestone: vi.fn(), leaveMilestone: vi.fn() }
  render(<TaskDetailNavProvider value={api}><L1Tabs task={task} activeTab={activeTab} /></TaskDetailNavProvider>)
  return api
}

describe('L1Tabs', () => {
  test('renders Plan, Plan Review and Dev, marking only the active one', () => {
    renderTabs(taskWithHistory([]), 'plan-review')

    expect(screen.getByTestId('l1-tab-plan')).toHaveTextContent('Plan')
    expect(screen.getByTestId('l1-tab-plan')).not.toHaveClass('is-active')
    expect(screen.getByTestId('l1-tab-plan-review')).toHaveClass('is-active')
    expect(screen.getByTestId('l1-tab-dev')).not.toHaveClass('is-active')
  })

  test('each tab carries a round counter for its own stage — none until the stage has been reached', () => {
    renderTabs(taskWithHistory(['planning', 'plan-review', 'plan-review', 'plan-review']), 'dev')

    expect(screen.getByTestId('l1-round-plan')).toHaveTextContent('×1')
    expect(screen.getByTestId('l1-round-plan-review')).toHaveTextContent('×3')
    expect(screen.queryByTestId('l1-round-dev')).toBeNull()
  })

  test('clicking a tab asks the detail nav to switch to it', () => {
    const api = renderTabs(taskWithHistory([]), 'dev')

    fireEvent.click(screen.getByTestId('l1-tab-plan'))

    expect(api.selectL1Tab).toHaveBeenCalledWith('plan')
  })

  test('tabs are real buttons, so they are keyboard-operable', () => {
    renderTabs(taskWithHistory([]), 'dev')
    expect(screen.getByTestId('l1-tab-plan').tagName).toBe('BUTTON')
    expect(screen.getByTestId('l1-tab-plan')).toHaveAttribute('type', 'button')
  })
})
