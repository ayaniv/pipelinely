import { afterEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { OrchestratorPill } from './OrchestratorPill'

// The pure display rules (cool/hot/unknown ctx, canonical gating) plus the
// click → typed action → flash wiring. The action's own HTTP contract is
// covered in api/actions.test.ts.

function stubFetch(response: Response | Error) {
  const fetchMock = vi.fn().mockImplementation(() => (response instanceof Error ? Promise.reject(response) : Promise.resolve(response)))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('OrchestratorPill', () => {
  test('an unknown ctx renders only the home icon: no meter, no Handover, plain accessible name', () => {
    render(<OrchestratorPill ctx={null} isCanonical />)
    expect(screen.getByTestId('header-ctx-home-icon')).toBeInTheDocument()
    expect(screen.queryByTestId('header-ctx-body')).not.toBeInTheDocument()
    expect(screen.queryByTestId('header-handover')).not.toBeInTheDocument()
    expect(screen.getByTestId('orchestrator-tab-btn')).toHaveAttribute('aria-label', 'Bring back the orchestrator tab')
  })

  test('a cool ctx shows the meter and folds the value into the accessible name, without Handover', () => {
    render(<OrchestratorPill ctx={30} isCanonical />)
    expect(screen.getByTestId('header-ctx-value')).toHaveTextContent('30%')
    expect(screen.getByTestId('orchestrator-tab-btn')).toHaveAttribute('aria-label', 'Bring back the orchestrator tab (context 30%)')
    expect(screen.queryByTestId('header-handover')).not.toBeInTheDocument()
  })

  test('a hot ctx adds the Handover segment; exactly the threshold does not', () => {
    const { rerender } = render(<OrchestratorPill ctx={60} isCanonical />)
    expect(screen.queryByTestId('header-handover')).not.toBeInTheDocument()
    rerender(<OrchestratorPill ctx={61} isCanonical />)
    expect(screen.getByTestId('header-handover')).toHaveTextContent('Handover')
  })

  test('a non-canonical instance disables the home control and says why', () => {
    render(<OrchestratorPill ctx={30} isCanonical={false} />)
    const button = screen.getByTestId('orchestrator-tab-btn')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', expect.stringContaining('not the canonical dashboard instance'))
  })

  test('a successful click POSTs /orchestrator/tab, flashes ✓ and hides nothing permanently', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 200 }))
    render(<OrchestratorPill ctx={30} isCanonical />)

    fireEvent.click(screen.getByTestId('orchestrator-tab-btn'))

    await waitFor(() => expect(screen.getByTestId('orchestrator-tab-btn')).toHaveClass('btn-ok', 'is-flashing'))
    expect(screen.getByTestId('orchestrator-tab-status')).toHaveTextContent('✓')
    expect(fetchMock).toHaveBeenCalledWith('/orchestrator/tab', { method: 'POST' })
    // The icon and meter are still in the tree — only hidden by CSS while
    // .is-flashing is on — so the flash can never destroy them.
    expect(screen.getByTestId('header-ctx-home-icon')).toBeInTheDocument()
    expect(screen.getByTestId('header-ctx-value')).toBeInTheDocument()
  })

  test('a failure flashes the server\'s message and logs', async () => {
    stubFetch(new Response(JSON.stringify({ error: 'orchestrator not running' }), { status: 503 }))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<OrchestratorPill ctx={30} isCanonical />)

    fireEvent.click(screen.getByTestId('orchestrator-tab-btn'))

    await waitFor(() => expect(screen.getByTestId('orchestrator-tab-btn')).toHaveClass('btn-err'))
    expect(screen.getByTestId('orchestrator-tab-status')).toHaveTextContent('orchestrator not running')
    expect(errorSpy).toHaveBeenCalledWith('[action] POST /orchestrator/tab failed', expect.any(Error))
  })

  test('clicking the Handover segment POSTs /orchestrator/pipelinely-handover, not the tab route', async () => {
    const fetchMock = stubFetch(new Response(JSON.stringify({ submitted: false }), { status: 200 }))
    render(<OrchestratorPill ctx={82} isCanonical />)

    fireEvent.click(screen.getByTestId('header-handover'))

    await waitFor(() => expect(screen.getByTestId('header-handover')).toHaveClass('btn-ok'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/orchestrator/pipelinely-handover', { method: 'POST' })
  })
})
