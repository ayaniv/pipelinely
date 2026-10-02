import { describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { DoneDateGroup } from '../../../../src/types'
import { DoneView } from './DoneView'
import { makeTask } from './testTask'

const pricedSession = { inputTokens: 1_000_000, outputTokens: 0, startedAt: '2026-09-01T10:00:00Z', current: false }

const groups: DoneDateGroup[] = [
  {
    dateKey: '2026-09-02',
    label: 'Today',
    tasks: [
      makeTask({ slug: 'priced', title: 'Priced task', repo: 'acme-api', model: 'claude-sonnet-5', sessions: [pricedSession] as never }),
      makeTask({ slug: 'unpriced', title: 'Unpriced task', repo: 'acme-web', sessions: [] }),
    ],
  },
  { dateKey: '2026-09-01', label: 'Yesterday', tasks: [makeTask({ slug: 'older', title: 'Older task', repo: 'acme-api' })] },
]

describe('DoneView', () => {
  test('renders a group per date with its label, and a row per task', () => {
    render(<DoneView groups={groups} onOpenTask={vi.fn()} />)

    expect(screen.getAllByTestId('done-date-label').map((el) => el.textContent)).toEqual(['Today', 'Yesterday'])
    expect(screen.getAllByTestId('done-row')).toHaveLength(3)
  })

  test('a row links to its task and shows the title, project and slug', () => {
    render(<DoneView groups={groups} onOpenTask={vi.fn()} />)

    const row = screen.getAllByTestId('done-row')[0]
    expect(row).toHaveAttribute('data-slug', 'priced')
    expect(row).toHaveAttribute('data-repo', 'acme-api')
    expect(within(row).getByTestId('done-row-link')).toHaveAttribute('href', '/task/priced')
    expect(row.querySelector('.done-row-title')).toHaveTextContent('Priced task')
    expect(row.querySelector('.done-row-meta')).toHaveTextContent('acme-api / priced')
  })

  test('a slug that needs escaping is percent-encoded in the link', () => {
    render(<DoneView groups={[{ dateKey: 'k', label: 'Today', tasks: [makeTask({ slug: 'a b' })] }]} onOpenTask={vi.fn()} />)
    expect(screen.getByTestId('done-row-link')).toHaveAttribute('href', '/task/a%20b')
  })

  test('shows a priced task\'s cost, an em dash for an unpriced one, and totals only priced cost per group', () => {
    render(<DoneView groups={groups} onOpenTask={vi.fn()} />)

    const costs = document.querySelectorAll('.done-row-cost')
    expect(costs[0]).toHaveTextContent('$2.00')
    expect(costs[1]).toHaveTextContent('—')
    expect(screen.getAllByTestId('done-date-total')[0]).toHaveTextContent('$2.00')
  })

  test('no groups renders the shared empty state', () => {
    render(<DoneView groups={[]} onOpenTask={vi.fn()} />)

    expect(screen.getByTestId('board-empty-state')).toBeInTheDocument()
    expect(screen.queryByTestId('done-row')).not.toBeInTheDocument()
  })
})

describe('DoneView row navigation', () => {
  test('a plain click opens the task in-app instead of reloading the page, so the board tab behind it is kept', () => {
    const onOpenTask = vi.fn()
    render(<DoneView groups={groups} onOpenTask={onOpenTask} />)

    const notCancelled = fireEvent.click(screen.getAllByTestId('done-row-link')[0])

    expect(notCancelled).toBe(false)
    expect(onOpenTask).toHaveBeenCalledWith('priced')
  })

  test.each([['metaKey'], ['ctrlKey'], ['shiftKey']])('a %s click is left to the browser (new tab or window)', (modifier) => {
    const onOpenTask = vi.fn()
    render(<DoneView groups={groups} onOpenTask={onOpenTask} />)

    const notCancelled = fireEvent.click(screen.getAllByTestId('done-row-link')[0], { [modifier]: true })

    expect(notCancelled).toBe(true)
    expect(onOpenTask).not.toHaveBeenCalled()
  })

  test('a non-primary button click is left to the browser', () => {
    const onOpenTask = vi.fn()
    render(<DoneView groups={groups} onOpenTask={onOpenTask} />)

    expect(fireEvent.click(screen.getAllByTestId('done-row-link')[0], { button: 1 })).toBe(true)
    expect(onOpenTask).not.toHaveBeenCalled()
  })
})
