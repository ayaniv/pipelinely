import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HeaderChrome } from './HeaderChrome'
import { ReadOnlyBanner } from './ReadOnlyBanner'
import { SNAPSHOT_QUERY_KEY } from '../../data/snapshot'
import type { Snapshot } from '../../data/snapshot'
import type { Task } from '../../../../src/types'

// The portal targets are elements of the app frame; recreated here
// so the components mount exactly where they do in the page.
function mountFrameContainers() {
  document.body.innerHTML = '<div id="header-chrome"></div><div id="read-only-banner-slot"></div>'
}

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    tasks: [], activeProject: null, weeklyFocus: '', backlog: [], doneGroups: [],
    settings: { autoMode: false }, orchestratorContextPct: null, isCanonical: true, ...overrides,
  } as Snapshot
}

function renderWith(snapshot: Snapshot | undefined, ui: React.ReactElement) {
  const queryClient = new QueryClient()
  if (snapshot) queryClient.setQueryData(SNAPSHOT_QUERY_KEY, snapshot)
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  mountFrameContainers()
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('HeaderChrome', () => {
  test('renders into the #header-chrome container, not beside the React root', () => {
    renderWith(makeSnapshot(), <HeaderChrome />)
    const container = document.getElementById('header-chrome')!
    expect(container).toContainElement(screen.getByTestId('header-spend'))
    expect(container).toContainElement(screen.getByTestId('header-live'))
    expect(container).toContainElement(document.getElementById('theme-toggle')!)
  })

  test('before the first snapshot only the data-free pieces render: no ctx pill, but live status and theme', () => {
    renderWith(undefined, <HeaderChrome />)
    expect(screen.queryByTestId('header-ctx')).not.toBeInTheDocument()
    expect(document.getElementById('header-ctx-slot')).toBeEmptyDOMElement()
    expect(screen.getByTestId('header-live')).toBeInTheDocument()
    expect(document.getElementById('theme-toggle')).toBeInTheDocument()
  })

  test('the spend pill sums active on-board tasks only', () => {
    const priced = { n: 1, contextPct: 10, inputTokens: 1_000_000, outputTokens: 0, current: false, stage: 'dev', sessionId: 's', startedAt: null, updatedAt: null }
    const base = { model: 'claude-sonnet-5', sessions: [priced], showsOnBoard: true, status: 'working' }
    const tasks = [
      { ...base, slug: 'a' },
      { ...base, slug: 'b', status: 'done' },
      { ...base, slug: 'c', showsOnBoard: false },
    ] as unknown as Task[]
    renderWith(makeSnapshot({ tasks }), <HeaderChrome />)
    expect(screen.getByTestId('header-spend')).toHaveTextContent('$2.00')
  })

  test('the auto-submit toggle is absent on a non-remote page', () => {
    renderWith(makeSnapshot(), <HeaderChrome />)
    expect(screen.queryByTestId('auto-submit-toggle')).not.toBeInTheDocument()
  })

  test('a missing container is logged, not silently dropped', () => {
    document.body.innerHTML = ''
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderWith(makeSnapshot(), <HeaderChrome />)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[frame-slot]'), 'header-chrome')
    errorSpy.mockRestore()
  })

  test('the missing-container error is logged once, not on every re-render', () => {
    document.body.innerHTML = ''
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const queryClient = new QueryClient()
    const ui = <QueryClientProvider client={queryClient}><HeaderChrome /></QueryClientProvider>
    const { rerender } = render(ui)
    rerender(ui)
    rerender(ui)
    expect(errorSpy.mock.calls.filter(([message, containerId]) => String(message).includes('[frame-slot]') && containerId === 'header-chrome')).toHaveLength(1)
    errorSpy.mockRestore()
  })
})

describe('ReadOnlyBanner', () => {
  test('shows for a non-canonical snapshot and hides for a canonical one', () => {
    const { unmount } = renderWith(makeSnapshot({ isCanonical: false }), <ReadOnlyBanner />)
    expect(screen.getByTestId('read-only-banner')).toBeInTheDocument()
    unmount()
    mountFrameContainers()
    renderWith(makeSnapshot({ isCanonical: true }), <ReadOnlyBanner />)
    expect(screen.queryByTestId('read-only-banner')).not.toBeInTheDocument()
  })

  test('stays hidden before the first snapshot says which instance this is', () => {
    renderWith(undefined, <ReadOnlyBanner />)
    expect(screen.queryByTestId('read-only-banner')).not.toBeInTheDocument()
  })
})
