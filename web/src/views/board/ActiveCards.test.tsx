import { describe, expect, test, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { ActiveCards } from './ActiveCards'
import { makeTask } from './testTask'

const NOW = new Date('2026-09-23T12:00:00Z').getTime()
const noop = () => {}
const baseProps = { now: NOW, isTaskOffFocus: () => false, onToggleOffFocus: noop, onOpenDetail: noop, creaturePlacement: 'header' as const }

describe('ActiveCards', () => {
  test('renders one card per task inside its group, with a header carrying the count', () => {
    render(<ActiveCards {...baseProps} tasks={[
      makeTask({ slug: 'a', attentionStatus: 'needs-you', status: 'waiting' }),
      makeTask({ slug: 'b', attentionStatus: 'working' }),
      makeTask({ slug: 'c', attentionStatus: 'working' }),
    ]} />)

    const needs = screen.getByTestId('active-group-needs')
    const working = screen.getByTestId('active-group-working')
    expect(within(needs).getAllByTestId('task-card')).toHaveLength(1)
    expect(within(working).getAllByTestId('task-card')).toHaveLength(2)
    expect(working.querySelector('.active-group-count')).toHaveTextContent('· 2')
    expect(working.querySelector('.active-group-label')).toHaveTextContent('Working')
  })

  test('Needs-you cards get a 420px minimum column and Working cards keep 300px', () => {
    render(<ActiveCards {...baseProps} tasks={[
      makeTask({ slug: 'n', attentionStatus: 'needs-you', status: 'waiting' }),
      makeTask({ slug: 'w', attentionStatus: 'working' }),
    ]} />)
    expect(screen.getByTestId('active-group-needs').querySelector('.active-group-grid')).toHaveAttribute('style', expect.stringContaining('420px'))
    expect(screen.getByTestId('active-group-working').querySelector('.active-group-grid')).toHaveAttribute('style', expect.stringContaining('300px'))
  })

  test('the Needs-you group renders before the Working group', () => {
    render(<ActiveCards {...baseProps} tasks={[
      makeTask({ slug: 'w', attentionStatus: 'working' }),
      makeTask({ slug: 'n', attentionStatus: 'needs-you', status: 'waiting' }),
    ]} />)
    const groups = screen.getAllByTestId(/^active-group-(needs|working)$/)
    expect(groups.map((g) => g.dataset.testid)).toEqual(['active-group-needs', 'active-group-working'])
  })

  test('shows the shared empty state when there is nothing to show', () => {
    render(<ActiveCards {...baseProps} tasks={[]} />)
    expect(screen.getByTestId('board-empty-state')).toBeInTheDocument()
    expect(screen.queryByTestId('task-card')).not.toBeInTheDocument()
  })

  test('a task with a plan gets its donut card after its session card, inside the same group', () => {
    const { container } = render(<ActiveCards {...baseProps} tasks={[makeTask({ plan: { total: 2, done: 1, milestones: [] } })]} />)
    const grid = container.querySelector('.active-group-grid')!
    expect([...grid.children].map((el) => (el as HTMLElement).dataset.testid ?? el.className)).toEqual(['task-card', 'plan-card'])
  })

  test('reads off-focus state per task and forwards toggles and opens with the slug', () => {
    const isTaskOffFocus = vi.fn((slug: string) => slug === 'a')
    render(<ActiveCards {...baseProps} isTaskOffFocus={isTaskOffFocus} tasks={[makeTask({ slug: 'a' }), makeTask({ slug: 'b' })]} />)

    const [first, second] = screen.getAllByTestId('task-card')
    expect(first.querySelector('.drift-pill')).toBeInTheDocument()
    expect(second.querySelector('.drift-pill')).not.toBeInTheDocument()
  })

  test('keeps a card\'s DOM node when an unrelated task changes (keyed by slug)', () => {
    const tasks = [makeTask({ slug: 'a' }), makeTask({ slug: 'b', waitingReason: 'one' })]
    const { rerender } = render(<ActiveCards {...baseProps} tasks={tasks} />)
    const nodeA = screen.getAllByTestId('task-card')[0]

    rerender(<ActiveCards {...baseProps} tasks={[tasks[0], { ...tasks[1], waitingReason: 'two' }]} />)

    expect(screen.getAllByTestId('task-card')[0]).toBe(nodeA)
    expect(screen.getByTestId('card-note')).toHaveTextContent('two')
  })

  test('hides every card\'s creature when the placement is off, and shows them otherwise', () => {
    const pip = { name: 'Pip', color: '#a8d8c9', shape: '32% 64% 44% 47% / 63% 60% 47% 55%' }
    const tasks = [makeTask({ slug: 'a', creature: pip }), makeTask({ slug: 'b', creature: { ...pip, name: 'Juno' } })]
    const { rerender } = render(<ActiveCards {...baseProps} tasks={tasks} creaturePlacement="header" />)
    expect(screen.getAllByTestId('creature')).toHaveLength(2)
    rerender(<ActiveCards {...baseProps} tasks={tasks} creaturePlacement="off" />)
    expect(screen.queryByTestId('creature')).not.toBeInTheDocument()
  })
})
