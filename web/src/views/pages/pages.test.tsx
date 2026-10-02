import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SettingsPage } from './SettingsPage'
import { HelpPage } from './HelpPage'
import { SNAPSHOT_QUERY_KEY } from '../../data/snapshot'
import { autoSubmitStore } from '../../data/autoSubmit'
import { rememberBoardTab } from '../board/boardTabRoutes'

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>
}

function renderPage(path: string, element: React.ReactElement, autoMode = false) {
  const queryClient = new QueryClient()
  queryClient.setQueryData(SNAPSHOT_QUERY_KEY, {
    tasks: [], activeProject: null, weeklyFocus: '', backlog: [], doneGroups: [],
    settings: { autoMode }, orchestratorContextPct: null, isCanonical: true,
  })
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <LocationProbe />
        <Routes>
          <Route path="/settings" element={element} />
          <Route path="/help" element={element} />
          <Route path="/" element={<span data-testid="board" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...utils, queryClient }
}

function stubFetch(status: number, body: unknown = {}) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  document.body.className = ''
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('FullPage behavior (via SettingsPage)', () => {
  test('marks the body full-page-open while mounted and clears it on unmount', () => {
    const { unmount } = renderPage('/settings', <SettingsPage />)
    expect(document.body).toHaveClass('full-page-open')
    unmount()
    expect(document.body).not.toHaveClass('full-page-open')
  })

  test('Escape navigates back to the board', () => {
    renderPage('/settings', <SettingsPage />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByTestId('location')).toHaveTextContent('/')
    expect(screen.getByTestId('board')).toBeInTheDocument()
  })

  test('Escape returns to the board tab the page was opened from, not always Active', () => {
    rememberBoardTab('backlog')
    renderPage('/settings', <SettingsPage />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByTestId('location')).toHaveTextContent('/backlog')
    rememberBoardTab('inprogress')
  })

  test('other keys do nothing, and the listener is gone after unmount', () => {
    const { unmount } = renderPage('/settings', <SettingsPage />)
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(screen.getByTestId('location')).toHaveTextContent('/settings')
    unmount()
    expect(() => fireEvent.keyDown(document, { key: 'Escape' })).not.toThrow()
  })
})

describe('SettingsPage', () => {
  test('the switch reflects the snapshot\'s autoMode', () => {
    renderPage('/settings', <SettingsPage />, true)
    expect(screen.getByTestId('settings-auto-mode-switch')).toBeChecked()
  })

  test('toggling posts the new value and stays toggled', async () => {
    const fetchMock = stubFetch(200)
    renderPage('/settings', <SettingsPage />, false)

    fireEvent.click(screen.getByTestId('settings-auto-mode-switch'))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings', expect.objectContaining({ body: JSON.stringify({ autoMode: true }) })))
    expect(screen.getByTestId('settings-auto-mode-switch')).toBeChecked()
  })

  test('a rejected write reverts the switch and logs', async () => {
    stubFetch(500)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderPage('/settings', <SettingsPage />, false)

    fireEvent.click(screen.getByTestId('settings-auto-mode-switch'))

    await waitFor(() => expect(screen.getByTestId('settings-auto-mode-switch')).not.toBeChecked())
    expect(errorSpy).toHaveBeenCalledWith('[settings] POST /settings failed', expect.any(Error))
  })

  test('the requested value yields to the snapshot once the snapshot agrees, so a later remote change wins', async () => {
    stubFetch(200)
    const { queryClient } = renderPage('/settings', <SettingsPage />, false)
    fireEvent.click(screen.getByTestId('settings-auto-mode-switch'))
    await waitFor(() => expect(screen.getByTestId('settings-auto-mode-switch')).toBeChecked())

    const snapshot = queryClient.getQueryData(SNAPSHOT_QUERY_KEY) as Record<string, unknown>
    // React Query notifies observers on a later tick, so each write gets its
    // own flushed render — the point is the render in between that sees the
    // snapshot agree with the requested value.
    const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    queryClient.setQueryData(SNAPSHOT_QUERY_KEY, { ...snapshot, settings: { autoMode: true } })
    await flush()
    queryClient.setQueryData(SNAPSHOT_QUERY_KEY, { ...snapshot, settings: { autoMode: false } })
    await flush()

    await waitFor(() => expect(screen.getByTestId('settings-auto-mode-switch')).not.toBeChecked())
  })
})

describe('HelpPage', () => {
  test('the disclosure says it files a public GitHub issue, previewed and confirmed first, with no Pipelinely server', () => {
    renderPage('/help', <HelpPage />)
    expect(screen.getByTestId('help-feedback-label')).toHaveTextContent('File a public GitHub issue')
    const disclosure = screen.getByTestId('help-feedback-disclosure')
    expect(disclosure).toHaveTextContent('public GitHub issue')
    expect(disclosure).toHaveTextContent('after you confirm')
    expect(disclosure).toHaveTextContent('Pipelinely server')
  })

  test('Send is disabled for empty and whitespace-only input, enabled for real content', () => {
    renderPage('/help', <HelpPage />)
    const send = screen.getByTestId('help-feedback-send')
    expect(send).toBeDisabled()
    fireEvent.change(screen.getByTestId('help-feedback-input'), { target: { value: '   ' } })
    expect(send).toBeDisabled()
    fireEvent.change(screen.getByTestId('help-feedback-input'), { target: { value: 'hi' } })
    expect(send).toBeEnabled()
  })

  test('a successful send posts the trimmed message and clears the composer', async () => {
    const fetchMock = stubFetch(200, { submitted: false })
    renderPage('/help', <HelpPage />)
    fireEvent.change(screen.getByTestId('help-feedback-input'), { target: { value: '  it broke  ' } })

    fireEvent.click(screen.getByTestId('help-feedback-send'))

    await waitFor(() => expect(screen.getByTestId('help-feedback-input')).toHaveValue(''))
    expect(fetchMock).toHaveBeenCalledWith('/help/pipelinely-feedback', expect.objectContaining({ body: JSON.stringify({ message: 'it broke' }) }))
    expect(screen.getByTestId('help-feedback-send')).toHaveClass('btn-ok')
  })

  test('a failed send keeps the message, shows the server\'s reason and logs', async () => {
    stubFetch(503, { error: 'no orchestrator session' })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderPage('/help', <HelpPage />)
    fireEvent.change(screen.getByTestId('help-feedback-input'), { target: { value: 'keep me' } })

    fireEvent.click(screen.getByTestId('help-feedback-send'))

    await waitFor(() => expect(screen.getByTestId('help-feedback-send')).toHaveClass('btn-err'))
    expect(screen.getByTestId('help-feedback-send')).toHaveTextContent('no orchestrator session')
    expect(screen.getByTestId('help-feedback-input')).toHaveValue('keep me')
    expect(errorSpy).toHaveBeenCalledWith('[action] POST /help/pipelinely-feedback failed', expect.any(Error))
  })

  test('offers the support mailto link', () => {
    renderPage('/help', <HelpPage />)
    expect(screen.getByTestId('help-support-link')).toHaveAttribute('href', expect.stringMatching(/^mailto:/))
  })
})

describe('SettingsPage — sign out of a remote session', () => {
  async function probeAccess(body: unknown) {
    stubFetch(200, body)
    await autoSubmitStore.probeAccessContext()
  }

  test('offers no sign-out on the desktop, where there is no session', async () => {
    await probeAccess({ isRemoteAccess: false, hasRemoteSession: false })
    renderPage('/settings', <SettingsPage />)
    expect(screen.queryByTestId('remote-logout-btn')).toBeNull()
  })

  test('offers no sign-out when the server does not report a session at all (an older server)', async () => {
    await probeAccess({ isRemoteAccess: true })
    renderPage('/settings', <SettingsPage />)
    expect(screen.queryByTestId('remote-logout-btn')).toBeNull()
  })

  test('offers sign-out to a signed-in remote device, as a plain form post to /remote-logout', async () => {
    await probeAccess({ isRemoteAccess: true, hasRemoteSession: true })
    renderPage('/settings', <SettingsPage />)

    const button = screen.getByTestId('remote-logout-btn')
    const form = button.closest('form')
    expect(form?.getAttribute('method')?.toLowerCase()).toBe('post')
    expect(form?.getAttribute('action')).toBe('/remote-logout')
  })
})
