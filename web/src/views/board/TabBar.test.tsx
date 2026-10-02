import { describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SidebarAccount, TabBar } from './TabBar'

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

  test('no counted tab is active while the You tab is', () => {
    render(<TabBar activeTab="you" counts={counts} onSelectTab={vi.fn()} />)
    expect(document.querySelectorAll('.tab-btn.is-active')).toHaveLength(0)
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

describe('SidebarAccount', () => {
  test('is the You tab\'s trigger and is active only on it', () => {
    const { rerender } = render(<SidebarAccount activeTab="you" onSelectTab={vi.fn()} />)
    expect(screen.getByTestId('sidebar-account')).toHaveClass('is-active')
    expect(screen.getByTestId('sidebar-account')).toHaveAttribute('data-tab', 'you')

    rerender(<SidebarAccount activeTab="done" onSelectTab={vi.fn()} />)
    expect(screen.getByTestId('sidebar-account')).not.toHaveClass('is-active')
  })

  test('exposes the You tab as current only while it is showing', () => {
    const { rerender } = render(<SidebarAccount activeTab="you" onSelectTab={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'You' })).toHaveAttribute('aria-current', 'page')

    rerender(<SidebarAccount activeTab="done" onSelectTab={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'You' })).not.toHaveAttribute('aria-current')
  })

  test('clicking it selects the You tab', () => {
    const onSelectTab = vi.fn()
    render(<SidebarAccount activeTab="inprogress" onSelectTab={onSelectTab} />)

    fireEvent.click(screen.getByTestId('sidebar-account'))

    expect(onSelectTab).toHaveBeenCalledWith('you')
  })
})
