import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ViewBoundary } from './ViewBoundary'

function Crashes(): never {
  throw new Error('task detail blew up')
}

function Healthy() {
  return <div data-testid="healthy-view" />
}

describe('ViewBoundary', () => {
  // Pinned to a concrete function type — see snapshot.test.ts's own comment
  // on why `ReturnType<typeof vi.fn>`-shaped bare generics don't assign.
  let consoleError: Mock<(...data: unknown[]) => void>

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    consoleError.mockRestore()
  })

  it('renders its view when nothing throws', () => {
    render(<ViewBoundary view="board"><Healthy /></ViewBoundary>)
    expect(screen.getByTestId('healthy-view')).toBeInTheDocument()
    expect(screen.queryByTestId('view-error-board')).toBeNull()
  })

  it('contains a crash to its own view and logs it', () => {
    render(
      <>
        <ViewBoundary view="task"><Crashes /></ViewBoundary>
        <ViewBoundary view="board"><Healthy /></ViewBoundary>
      </>,
    )

    expect(screen.getByTestId('view-error-task')).toHaveAttribute('role', 'alert')
    // The rest of the dashboard keeps working.
    expect(screen.getByTestId('healthy-view')).toBeInTheDocument()
    expect(screen.queryByTestId('view-error-board')).toBeNull()

    const ownLog = consoleError.mock.calls.find(([first]) => String(first).startsWith('[view:task] crashed'))
    expect(ownLog).toBeDefined()
  })
})

describe('ViewBoundary fallback', () => {
  it('renders a caller-supplied visible fallback inside the alert, and still logs the crash', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    function Boom(): never { throw new Error('boom') }
    render(<ViewBoundary view="board" fallback={<span data-testid="board-crashed-message">Board failed to load</span>}><Boom /></ViewBoundary>)

    expect(screen.getByTestId('view-error-board')).toContainElement(screen.getByTestId('board-crashed-message'))
    expect(consoleError).toHaveBeenCalledWith('[view:board] crashed', expect.any(Error), expect.anything())
    consoleError.mockRestore()
  })
})
