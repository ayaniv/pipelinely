import { describe, expect, test, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TerminalIconButton } from './TerminalIconButton'

// Same dispatch as FocusButton (POST /focus/:slug via postFocus), just an
// icon-only render — used by the board and milestone cards, where the labeled
// FocusButton would not fit.

describe('TerminalIconButton', () => {
  test('always uses the focus-btn testid, whatever the caller knows about the task', () => {
    render(<TerminalIconButton slug="demo-task" fetchImpl={vi.fn()} log={vi.fn()} />)
    expect(screen.getByTestId('focus-btn')).toHaveAttribute('title', 'Open terminal')
  })

  test('takes the testid as a prop', () => {
    render(<TerminalIconButton slug="demo-task" testId="row-terminal" fetchImpl={vi.fn()} log={vi.fn()} />)
    expect(screen.getByTestId('row-terminal')).toBeInTheDocument()
    expect(screen.queryByTestId('focus-btn')).not.toBeInTheDocument()
  })

  test('a click dispatches POST /focus/:slug and flashes the outcome in place of the icon', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    render(<TerminalIconButton slug="demo-task" fetchImpl={fetchImpl} log={vi.fn()} />)

    fireEvent.click(screen.getByTestId('focus-btn'))

    const btn = screen.getByTestId('focus-btn')
    await waitFor(() => expect(btn).toHaveClass('btn-ok'))
    expect(fetchImpl).toHaveBeenCalledWith('/focus/demo-task', { method: 'POST' })
  })

  test('is disabled while the request is in flight, and a click while disabled sends only one request', async () => {
    let resolveFetch: (res: Response) => void = () => {}
    const fetchImpl = vi.fn().mockReturnValue(new Promise<Response>((resolve) => { resolveFetch = resolve }))
    render(<TerminalIconButton slug="demo-task" fetchImpl={fetchImpl} log={vi.fn()} />)
    const btn = screen.getByTestId('focus-btn')

    fireEvent.click(btn)
    await waitFor(() => expect(btn).toBeDisabled())
    fireEvent.click(btn)

    resolveFetch(new Response(null, { status: 200 }))
    await waitFor(() => expect(btn).not.toBeDisabled())
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('carries no data-action by default, and data-action plus data-slug when a caller outside #root asks for it', () => {
    const { rerender } = render(<TerminalIconButton slug="demo-task" fetchImpl={vi.fn()} log={vi.fn()} />)
    expect(screen.getByTestId('focus-btn')).not.toHaveAttribute('data-action')

    rerender(<TerminalIconButton slug="demo-task" dataAction="focus" fetchImpl={vi.fn()} log={vi.fn()} />)
    expect(screen.getByTestId('focus-btn')).toHaveAttribute('data-action', 'focus')
    expect(screen.getByTestId('focus-btn')).toHaveAttribute('data-slug', 'demo-task')
  })
})
