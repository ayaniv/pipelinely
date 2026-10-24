import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SettingsPage } from './SettingsPage'
import { HelpPage } from './HelpPage'
import { SNAPSHOT_QUERY_KEY } from '../../data/snapshot'
import { autoSubmitStore } from '../../data/autoSubmit'
import { rememberBoardTab } from '../board/boardTabRoutes'
import type { QaStartPolicy } from '../../../../src/types'

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>
}

function renderPage(path: string, element: React.ReactElement, autoMode = false, creaturePlacement: 'header' | 'off' = 'header', weeklyFocusEnabled = true, qaStartPolicy?: QaStartPolicy) {
  const queryClient = new QueryClient()
  queryClient.setQueryData(SNAPSHOT_QUERY_KEY, {
    tasks: [], activeProject: null, weeklyFocus: '', backlog: [], doneGroups: [],
    settings: { autoMode, creaturePlacement, weeklyFocusEnabled, qaStartPolicy }, orchestratorContextPct: null, isCanonical: true,
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

describe('SettingsPage — task creatures', () => {
  test('the switch reflects the placement: on for the header, off for off', () => {
    const { unmount } = renderPage('/settings', <SettingsPage />, false, 'header')
    expect(screen.getByTestId('settings-creatures-switch')).toBeChecked()
    unmount()
    renderPage('/settings', <SettingsPage />, false, 'off')
    expect(screen.getByTestId('settings-creatures-switch')).not.toBeChecked()
  })

  test('toggling posts only the placement and flips the switch at once', async () => {
    const fetchMock = stubFetch(200)
    renderPage('/settings', <SettingsPage />, true, 'header')
    fireEvent.click(screen.getByTestId('settings-creatures-switch'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings', expect.objectContaining({ body: JSON.stringify({ creaturePlacement: 'off' }) })))
    expect(screen.getByTestId('settings-creatures-switch')).not.toBeChecked()
  })

  test('a failed write reverts the switch and logs', async () => {
    stubFetch(500)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderPage('/settings', <SettingsPage />, false, 'header')
    fireEvent.click(screen.getByTestId('settings-creatures-switch'))
    await waitFor(() => expect(screen.getByTestId('settings-creatures-switch')).toBeChecked())
    expect(errorSpy).toHaveBeenCalledWith('[settings] POST /settings failed', expect.any(Error))
  })

  test('leaves the auto mode switch alone', () => {
    renderPage('/settings', <SettingsPage />, true, 'off')
    expect(screen.getByTestId('settings-auto-mode-switch')).toBeChecked()
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

describe('SettingsPage — weekly focus', () => {
  test('the switch reflects the setting: on by default, off when disabled', () => {
    const { unmount } = renderPage('/settings', <SettingsPage />, false, 'header', true)
    expect(screen.getByTestId('settings-weekly-focus-switch')).toBeChecked()
    unmount()
    renderPage('/settings', <SettingsPage />, false, 'header', false)
    expect(screen.getByTestId('settings-weekly-focus-switch')).not.toBeChecked()
  })

  test('is a labelled checkbox, so the keyboard can toggle it', () => {
    renderPage('/settings', <SettingsPage />)
    const toggle = screen.getByTestId('settings-weekly-focus-switch')
    expect(toggle).toHaveAttribute('type', 'checkbox')
    expect(toggle).toHaveAttribute('aria-label', 'Toggle weekly focus')
    expect(screen.getByTestId('settings-weekly-focus-description')).toHaveTextContent(/focus/i)
  })

  test('toggling posts only the flag and flips the switch at once', async () => {
    const fetchMock = stubFetch(200)
    renderPage('/settings', <SettingsPage />)
    fireEvent.click(screen.getByTestId('settings-weekly-focus-switch'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings', expect.objectContaining({ body: JSON.stringify({ weeklyFocusEnabled: false }) })))
    expect(screen.getByTestId('settings-weekly-focus-switch')).not.toBeChecked()
  })

  test('a failed write reverts the switch and logs', async () => {
    stubFetch(500)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderPage('/settings', <SettingsPage />)
    fireEvent.click(screen.getByTestId('settings-weekly-focus-switch'))
    await waitFor(() => expect(screen.getByTestId('settings-weekly-focus-switch')).toBeChecked())
    expect(errorSpy).toHaveBeenCalledWith('[settings] POST /settings failed', expect.any(Error))
  })
})

describe('SettingsPage — QA start consent', () => {
  const qaSwitch = () => screen.getByTestId('settings-qa-preapproval-switch')

  test('is off when the setting is ask-every-time, and when a server predates it', () => {
    const { unmount } = renderPage('/settings', <SettingsPage />, false, 'header', true, 'ask-every-time')
    expect(qaSwitch()).not.toBeChecked()
    unmount()
    renderPage('/settings', <SettingsPage />, false, 'header', true, undefined)
    expect(qaSwitch()).not.toBeChecked()
  })

  test('is on when the recorded setting pre-approves the ui project', () => {
    renderPage('/settings', <SettingsPage />, false, 'header', true, 'cockpit-ai-ui-preapproved')
    expect(qaSwitch()).toBeChecked()
  })

  test('turning it on posts only the recorded value', async () => {
    const fetchMock = stubFetch(200)
    renderPage('/settings', <SettingsPage />, false, 'header', true, 'ask-every-time')
    fireEvent.click(qaSwitch())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings', expect.objectContaining({ body: JSON.stringify({ qaStartPolicy: 'cockpit-ai-ui-preapproved' }) })))
    expect(qaSwitch()).toBeChecked()
  })

  test('turning it off posts ask-every-time', async () => {
    const fetchMock = stubFetch(200)
    renderPage('/settings', <SettingsPage />, false, 'header', true, 'cockpit-ai-ui-preapproved')
    fireEvent.click(qaSwitch())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings', expect.objectContaining({ body: JSON.stringify({ qaStartPolicy: 'ask-every-time' }) })))
    expect(qaSwitch()).not.toBeChecked()
  })

  test('a failed write reverts to the previous value and logs', async () => {
    stubFetch(500)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderPage('/settings', <SettingsPage />, false, 'header', true, 'ask-every-time')
    fireEvent.click(qaSwitch())
    await waitFor(() => expect(qaSwitch()).not.toBeChecked())
    expect(errorSpy).toHaveBeenCalledWith('[settings] POST /settings failed', expect.any(Error))
  })

  test('the auto mode switch is not consent: turning it on leaves QA asking', async () => {
    stubFetch(200)
    renderPage('/settings', <SettingsPage />, false, 'header', true, 'ask-every-time')
    fireEvent.click(screen.getByTestId('settings-auto-mode-switch'))
    await waitFor(() => expect(screen.getByTestId('settings-auto-mode-switch')).toBeChecked())
    expect(qaSwitch()).not.toBeChecked()
  })
})
