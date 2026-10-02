import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PlanCard } from './PlanCard'
import { makeTask } from './testTask'

describe('PlanCard', () => {
  test('renders the donut with done/total and a milestone caption', () => {
    const { container } = render(<PlanCard task={makeTask({ plan: { total: 5, done: 2, milestones: [] } })} />)

    expect(container.querySelector('.donut-text')).toHaveTextContent('2/5')
    expect(container.querySelector('.donut-label')).toHaveTextContent('2 of 5 milestones')
    expect(container.querySelector('.plan-card-title')).toHaveTextContent('Demo task')
  })

  test('the arc length is proportional to progress', () => {
    const { container } = render(<PlanCard task={makeTask({ plan: { total: 4, done: 1, milestones: [] } })} />)
    const circumference = 2 * Math.PI * 28
    const dasharray = container.querySelector('.donut-progress')!.getAttribute('stroke-dasharray')!
    const [drawn] = dasharray.split(' ').map(Number)
    expect(drawn).toBeCloseTo(circumference / 4, 1)
  })

  test('shows the branch when there is one, and omits the row when there is not', () => {
    const { container, rerender } = render(<PlanCard task={makeTask({ plan: { total: 1, done: 0, milestones: [] }, branch: 'claude/x' })} />)
    expect(container.querySelector('.card-branch')).toHaveTextContent('claude/x')

    rerender(<PlanCard task={makeTask({ plan: { total: 1, done: 0, milestones: [] }, branch: '' })} />)
    expect(container.querySelector('.card-branch')).not.toBeInTheDocument()
  })

  test('renders nothing for a task with no plan, or a plan with no milestones', () => {
    const none = render(<PlanCard task={makeTask({ plan: null })} />)
    expect(none.container).toBeEmptyDOMElement()
    const empty = render(<PlanCard task={makeTask({ plan: { total: 0, done: 0, milestones: [] } })} />)
    expect(empty.container).toBeEmptyDOMElement()
    expect(screen.queryByTestId('plan-card')).not.toBeInTheDocument()
  })
})
