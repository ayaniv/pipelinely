import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ShellFrame } from './ShellFrame'

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function renderAt(path: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}><ShellFrame /></MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('ShellFrame', () => {
  test.each([
    ['/', 'inprogress'],
    ['/backlog', 'backlog'],
    ['/docs', 'docs'],
    ['/task/demo-task', 'task'],
    ['/nope', 'unknown'],
  ])('%s is reported as route %s', (path, route) => {
    renderAt(path)
    expect(screen.getByTestId('react-shell')).toHaveAttribute('data-route', route)
  })

  test('renders the frame and mounts the header chrome and tab bar into it, before any snapshot has arrived', () => {
    renderAt('/')

    expect(screen.getByTestId('app-sidebar')).toBeInTheDocument()
    expect(screen.getByTestId('board-column')).toBeInTheDocument()
    expect(screen.getByTestId('app-header')).toContainElement(screen.getByTestId('header-live'))
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument()
    expect(screen.getByTestId('tab-bar')).toContainElement(screen.getByTestId('tab-btn-backlog'))
    expect(screen.getByTestId('sidebar-account')).toBeInTheDocument()
  })

  test('the active board tab follows the route', () => {
    renderAt('/done')
    expect(screen.getByTestId('done-section')).toHaveClass('is-active')
    expect(screen.getByTestId('active-sessions')).not.toHaveClass('is-active')
    expect(screen.getByTestId('board-column')).toHaveAttribute('data-active-tab', 'done')
  })
})
