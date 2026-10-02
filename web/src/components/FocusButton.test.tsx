import { describe, expect, test, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FocusButton } from './FocusButton'

// Dispatches through postFocus (api/actions.ts).

function deps(fetchImpl: typeof fetch) {
  return { fetchImpl, log: vi.fn() }
}

describe('FocusButton', () => {
  test('renders the Terminal label/testid for a non-paused task', () => {
    render(<FocusButton slug="demo-task" status="working" attentionStatus="working" {...deps(vi.fn())} />)
    const btn = screen.getByTestId('focus-btn')
    expect(btn).toHaveTextContent('Terminal')
    expect(btn).toHaveAttribute('data-primary', 'false')
  })

  test('renders the Resume label/testid for a paused task, primary when it needs you', () => {
    render(<FocusButton slug="demo-task" status="paused" attentionStatus="paused" {...deps(vi.fn())} />)
    const btn = screen.getByTestId('resume-btn')
    expect(btn).toHaveTextContent('Resume')
    expect(btn).toHaveClass('btn-primary')
    expect(btn).toHaveAttribute('data-primary', 'true')
  })

  test('a successful click flashes ✓ then reverts to the original label', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    render(<FocusButton slug="demo-task" status="working" attentionStatus="working" {...deps(fetchImpl)} />)
    const btn = screen.getByTestId('focus-btn')

    fireEvent.click(btn)

    await waitFor(() => expect(btn).toHaveClass('btn-ok'))
    expect(fetchImpl).toHaveBeenCalledWith('/focus/demo-task', { method: 'POST' })
  })

  test('a failed click flashes btn-err with the server\'s status-specific label', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 503 }))
    render(<FocusButton slug="demo-task" status="working" attentionStatus="working" {...deps(fetchImpl)} />)

    fireEvent.click(screen.getByTestId('focus-btn'))

    const btn = screen.getByTestId('focus-btn')
    await waitFor(() => expect(btn).toHaveClass('btn-err'))
    expect(btn).toHaveTextContent('no orchestrator')
  })

  // The button is disabled for the duration of the request.
  test('is disabled while the request is in flight, and a click while disabled sends only one request', async () => {
    let resolveFetch: (res: Response) => void = () => {}
    const fetchImpl = vi.fn().mockReturnValue(new Promise<Response>((resolve) => { resolveFetch = resolve }))
    render(<FocusButton slug="demo-task" status="working" attentionStatus="working" {...deps(fetchImpl)} />)
    const btn = screen.getByTestId('focus-btn')

    fireEvent.click(btn)
    await waitFor(() => expect(btn).toBeDisabled())
    fireEvent.click(btn) // a second click while still in flight

    resolveFetch(new Response(null, { status: 200 }))
    await waitFor(() => expect(btn).not.toBeDisabled())
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
