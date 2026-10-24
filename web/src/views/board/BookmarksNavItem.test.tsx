import { describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { BookmarksNavItem } from './BookmarksNavItem'

describe('BookmarksNavItem', () => {
  test('is a nav row named Bookmarks with the count of bookmarks', () => {
    render(<BookmarksNavItem isCurrent={false} count={6} onOpen={vi.fn()} />)

    const button = screen.getByTestId('sidebar-bookmarks-btn')
    expect(button).toHaveAttribute('aria-label', 'Bookmarks')
    expect(button).toHaveClass('tab-btn')
    expect(button).not.toHaveClass('is-active')
    expect(button).not.toHaveAttribute('aria-current')
    expect(screen.getByTestId('sidebar-bookmarks-label')).toHaveTextContent('Bookmarks')
    expect(screen.getByTestId('sidebar-bookmarks-count')).toHaveTextContent('6')
  })

  test('is marked as the current page when /bookmarks shows', () => {
    render(<BookmarksNavItem isCurrent count={0} onOpen={vi.fn()} />)

    expect(screen.getByTestId('sidebar-bookmarks-btn')).toHaveClass('is-active')
    expect(screen.getByTestId('sidebar-bookmarks-btn')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('sidebar-bookmarks-count')).toHaveTextContent('0')
  })

  test('shows no count while the bookmarks are unknown (loading, or this device is not allowed them)', () => {
    render(<BookmarksNavItem isCurrent={false} count={null} onOpen={vi.fn()} />)
    expect(screen.queryByTestId('sidebar-bookmarks-count')).toBeNull()
  })

  test('opens the page on click', () => {
    const onOpen = vi.fn()
    render(<BookmarksNavItem isCurrent={false} count={1} onOpen={onOpen} />)
    fireEvent.click(screen.getByTestId('sidebar-bookmarks-btn'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})
