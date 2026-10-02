import { describe, expect, test, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { HandoverPill } from './HandoverPill'
import { postHandover } from '../api/actions'

// The task-level case (detail-handover) — dispatches through postHandover
// (api/actions.ts), not the generic postAction.

describe('HandoverPill', () => {
  test('renders a real button carrying the given testid', () => {
    render(<HandoverPill testId="detail-handover" send={(options) => postHandover('demo-task', options)} fetchImpl={vi.fn()} log={vi.fn()} />)
    const pill = screen.getByTestId('detail-handover')
    expect(pill.tagName).toBe('BUTTON')
    expect(pill).toHaveTextContent('Handover')
  })

  test('clicking it POSTs /pipelinely-handover/:slug and flashes ok on success, leaving the pill in place', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ submitted: true }), { status: 200 }))
    render(<HandoverPill testId="detail-handover" send={(options) => postHandover('demo-task', options)} fetchImpl={fetchImpl} log={vi.fn()} />)

    fireEvent.click(screen.getByTestId('detail-handover'))

    await waitFor(() => expect(screen.getByTestId('detail-handover')).toHaveClass('btn-ok'))
    expect(fetchImpl).toHaveBeenCalledWith('/pipelinely-handover/demo-task', { method: 'POST' })
  })

  test('a failure flashes btn-err with the server\'s own message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'no session found' }), { status: 503 }))
    const log = vi.fn()
    render(<HandoverPill testId="detail-handover" send={(options) => postHandover('demo-task', options)} fetchImpl={fetchImpl} log={log} />)

    fireEvent.click(screen.getByTestId('detail-handover'))

    const pill = screen.getByTestId('detail-handover')
    await waitFor(() => expect(pill).toHaveClass('btn-err'))
    expect(pill).toHaveTextContent('no session found')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action]'), expect.any(Error))
  })

  test('is disabled while the request is in flight, and a click while disabled sends only one request', async () => {
    let resolveFetch: (res: Response) => void = () => {}
    const fetchImpl = vi.fn().mockReturnValue(new Promise<Response>((resolve) => { resolveFetch = resolve }))
    render(<HandoverPill testId="detail-handover" send={(options) => postHandover('demo-task', options)} fetchImpl={fetchImpl} log={vi.fn()} />)
    const pill = screen.getByTestId('detail-handover')

    fireEvent.click(pill)
    await waitFor(() => expect(pill).toBeDisabled())
    fireEvent.click(pill)

    resolveFetch(new Response(JSON.stringify({ submitted: true }), { status: 200 }))
    await waitFor(() => expect(pill).not.toBeDisabled())
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('carries no data-action by default, and data-action plus data-slug when a caller outside #root asks for it', () => {
    const { rerender } = render(<HandoverPill testId="detail-handover" send={vi.fn()} fetchImpl={vi.fn()} log={vi.fn()} />)
    expect(screen.getByTestId('detail-handover')).not.toHaveAttribute('data-action')

    rerender(<HandoverPill testId="card-handover" send={vi.fn()} dataAttrs={{ action: 'handover', slug: 'demo-task' }} fetchImpl={vi.fn()} log={vi.fn()} />)
    expect(screen.getByTestId('card-handover')).toHaveAttribute('data-action', 'handover')
    expect(screen.getByTestId('card-handover')).toHaveAttribute('data-slug', 'demo-task')
  })
})
