import { describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TabBar } from './TabBar'

const counts = { inprogress: 3, backlog: 12, done: 0 }

describe('TabBar', () => {
  test('renders the three counted tabs with their live counts', () => {
    render(<TabBar activeTab="inprogress" counts={counts} onSelectTab={vi.fn()} />)

    expect(screen.getByTestId('tab-count-inprogress')).toHaveTextContent('3')
    expect(screen.getByTestId('tab-count-backlog')).toHaveTextContent('12')
    expect(screen.getByTestId('tab-count-done')).toHaveTextContent('0')
    expect(screen.getAllByRole('button')).toHaveLength(3)
  })

  test('marks only the active tab, carrying its name in data-tab for the panels and specs that key off it', () => {
    render(<TabBar activeTab="backlog" counts={counts} onSelectTab={vi.fn()} />)

    expect(screen.getByTestId('tab-btn-backlog')).toHaveClass('is-active')
    expect(screen.getByTestId('tab-btn-backlog')).toHaveAttribute('data-tab', 'backlog')
    expect(screen.getByTestId('tab-btn-done')).not.toHaveClass('is-active')
    expect(screen.getByTestId('tab-btn-inprogress')).not.toHaveClass('is-active')
  })

  test('lists the tabs as Active, Done, Backlog', () => {
    render(<TabBar activeTab="inprogress" counts={counts} onSelectTab={vi.fn()} />)
    const order = screen.getAllByRole('button').map((button) => button.getAttribute('data-tab'))
    expect(order).toEqual(['inprogress', 'done', 'backlog'])
  })

  test('no counted tab is active while the Usage tab is', () => {
    render(<TabBar activeTab="usage" counts={counts} onSelectTab={vi.fn()} />)
    expect(document.querySelectorAll('.tab-btn.is-active')).toHaveLength(0)
  })

  test('no counted tab is active when the page showing is none of them (null)', () => {
    render(<TabBar activeTab={null} counts={counts} onSelectTab={vi.fn()} />)
    expect(document.querySelectorAll('.tab-btn.is-active')).toHaveLength(0)
    expect(document.querySelectorAll('[aria-current]')).toHaveLength(0)
  })

  test('a count that has not loaded shows a dash and is named "loading", never a misleading 0', () => {
    render(<TabBar activeTab="inprogress" counts={{ inprogress: null, backlog: null, done: null }} onSelectTab={vi.fn()} />)

    expect(screen.getByTestId('tab-count-backlog')).toHaveTextContent('–')
    expect(screen.getByRole('button', { name: 'Backlog, loading' })).toBeInTheDocument()
  })

  test('exposes the selected tab with aria-current, and names each tab with its count', () => {
    render(<TabBar activeTab="backlog" counts={counts} onSelectTab={vi.fn()} />)

    expect(screen.getByTestId('tab-btn-backlog')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('tab-btn-done')).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('button', { name: 'Backlog, 12' })).toBe(screen.getByTestId('tab-btn-backlog'))
    expect(screen.getByRole('button', { name: 'Active, 3' })).toBeInTheDocument()
  })

  test('clicking a tab selects it', () => {
    const onSelectTab = vi.fn()
    render(<TabBar activeTab="inprogress" counts={counts} onSelectTab={onSelectTab} />)

    fireEvent.click(screen.getByTestId('tab-btn-done'))

    expect(onSelectTab).toHaveBeenCalledWith('done')
  })
})
