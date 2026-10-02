import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserRouter, RouterProvider } from 'react-router'
import type { BacklogItem } from '../../../../src/types'
import type { Snapshot } from '../../data/snapshot'
import { SNAPSHOT_QUERY_KEY } from '../../data/snapshot'
import { sidebarStore } from '../../shell/sidebarState'
import { BoardTabs } from './BoardTabs'
import { useActiveBoardTab } from './boardTabRoutes'
import { createProjectFilterStore } from './boardFilter'
import { makeTask } from './testTask'

// BoardTabs wired the way ShellFrame wires it: the tab bar, the account row,
// the three panels and the standup button each portal into a container the
// app frame owns, driven by the snapshot cache, the project filter and the
// active tab (which the frame derives from the router's location).

const SLOT_IDS = ['tab-bar', 'sidebar-account-slot', 'backlog-section', 'done-groups', 'work-density', 'standup-slot']
const PANEL_TABS = ['inprogress', 'backlog', 'done', 'you']

const backlogItem = (description: string, project: string | null): BacklogItem =>
  ({ description, date: null, context: null, done: false, shelvedSlug: null, project })

function snapshotWith(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    tasks: [makeTask({ slug: 'active-api', repo: 'acme-api' }), makeTask({ slug: 'active-web', repo: 'acme-web' })],
    activeProject: null, weeklyFocus: '',
    backlog: [backlogItem('one', 'acme-api'), backlogItem('two', 'acme-web'), backlogItem('three', null)],
    doneGroups: [
      { dateKey: '2026-09-02', label: 'Today', tasks: [makeTask({ slug: 'done-api', repo: 'acme-api', title: 'Done API' }), makeTask({ slug: 'done-web', repo: 'acme-web', title: 'Done Web' })] },
    ],
    settings: { autoMode: false }, orchestratorContextPct: null, isCanonical: true, ...overrides,
  } as Snapshot
}

let queryClient: QueryClient

beforeEach(() => {
  const board = document.createElement('div')
  board.id = 'board'
  document.body.appendChild(board)
  for (const tab of PANEL_TABS) {
    const panel = document.createElement('section')
    panel.className = 'tab-panel'
    panel.dataset.tabPanel = tab
    // The real markup gives the backlog panel the id its slot portals into.
    if (tab === 'backlog') panel.id = 'backlog-section'
    board.appendChild(panel)
  }
  for (const id of SLOT_IDS.filter((slotId) => slotId !== 'backlog-section')) {
    const el = document.createElement('div')
    el.id = id
    document.body.appendChild(el)
  }
  queryClient = new QueryClient()
  sidebarStore.openMobile()
})
afterEach(() => {
  document.body.innerHTML = ''
  document.body.className = ''
  sidebarStore.closeMobile()
})

function TabsHarness({ store }: { store: ReturnType<typeof createProjectFilterStore> }) {
  return <BoardTabs activeTab={useActiveBoardTab()} filterStore={store} />
}

function renderTabs(snapshot: Snapshot | undefined, { path = '/', store = createProjectFilterStore() } = {}) {
  if (snapshot) queryClient.setQueryData(SNAPSHOT_QUERY_KEY, snapshot)
  // A real browser router over jsdom's history, so navigation is observable.
  window.history.replaceState({}, '', path)
  const router = createBrowserRouter([{ path: '*', element: <TabsHarness store={store} /> }])
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router, store }
}

async function updateSnapshot(snapshot: Snapshot) {
  await act(async () => {
    queryClient.setQueryData(SNAPSHOT_QUERY_KEY, snapshot)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const count = (tab: string) => screen.getByTestId(`tab-count-${tab}`)
const panel = (tab: string) => document.querySelector(`.tab-panel[data-tab-panel="${tab}"]`) as HTMLElement

describe('BoardTabs counts', () => {
  test('shows each tab\'s live count from the snapshot', () => {
    renderTabs(snapshotWith())

    expect(count('inprogress')).toHaveTextContent('2')
    expect(count('backlog')).toHaveTextContent('3')
    expect(count('done')).toHaveTextContent('2')
  })

  test('before the first snapshot the tab bar is there with unloaded counts, and each panel says it is loading', () => {
    renderTabs(undefined)

    expect(count('backlog')).toHaveTextContent('–')
    expect(screen.getByTestId('sidebar-account')).toBeInTheDocument()
    expect(screen.queryByTestId('backlog-row')).not.toBeInTheDocument()
    expect(screen.queryByTestId('board-empty-state')).not.toBeInTheDocument()
    expect(within(panel('backlog')).getByTestId('snapshot-loading')).toBeInTheDocument()
    expect(within(document.getElementById('done-groups')!).getByTestId('snapshot-loading')).toBeInTheDocument()
    expect(within(document.getElementById('work-density')!).getByTestId('snapshot-loading')).toBeInTheDocument()
  })

  test('while the stream cannot connect and no snapshot ever arrived, the panels show an error, not an empty board', async () => {
    const { setConnectionStatus } = await import('../../data/connectionStatus')
    act(() => setConnectionStatus('reconnecting'))
    renderTabs(undefined)

    expect(within(panel('backlog')).getByTestId('snapshot-error')).toBeInTheDocument()
    act(() => setConnectionStatus('live'))
  })

  test('the project filter narrows the counts of all three tabs', () => {
    const { store } = renderTabs(snapshotWith())

    act(() => store.toggle('acme-api'))

    expect(count('inprogress')).toHaveTextContent('1')
    expect(count('backlog')).toHaveTextContent('1')
    expect(count('done')).toHaveTextContent('1')
  })

  test('a selected project that left the board no longer narrows anything', () => {
    const { store } = renderTabs(snapshotWith())

    act(() => store.toggle('gone'))

    expect(count('backlog')).toHaveTextContent('3')
  })

  test('a live snapshot updates the counts', async () => {
    renderTabs(snapshotWith())

    await updateSnapshot(snapshotWith({ backlog: [backlogItem('only', null)], doneGroups: [] }))

    expect(count('backlog')).toHaveTextContent('1')
    expect(count('done')).toHaveTextContent('0')
  })
})

describe('BoardTabs panels', () => {
  test('renders the backlog rows, done rows and density calendar into their panels', () => {
    renderTabs(snapshotWith())

    expect(within(panel('backlog')).getAllByTestId('backlog-row')).toHaveLength(3)
    expect(within(document.getElementById('done-groups')!).getAllByTestId('done-row')).toHaveLength(2)
    expect(within(document.getElementById('work-density')!).getAllByTestId('density-cell')).toHaveLength(53 * 7)
  })

  test('the project filter narrows the backlog and done panels but never the You calendar', () => {
    const { store } = renderTabs(snapshotWith({
      doneGroups: [{ dateKey: 'k', label: 'Today', tasks: [makeTask({ slug: 'a', repo: 'acme-api', sessions: [{ startedAt: new Date().toISOString() }] as never }), makeTask({ slug: 'b', repo: 'acme-web' })] }],
    }))
    const totalBefore = screen.getByTestId('density-total').getAttribute('data-count')

    act(() => store.toggle('acme-web'))

    expect(within(panel('backlog')).getAllByTestId('backlog-row')).toHaveLength(1)
    expect(within(document.getElementById('done-groups')!).getAllByTestId('done-row')).toHaveLength(1)
    expect(screen.getByTestId('density-total')).toHaveAttribute('data-count', totalBefore!)
  })

  test('the tab bar and account row follow the active tab', () => {
    renderTabs(snapshotWith(), { path: '/backlog' })
    expect(screen.getByTestId('tab-btn-backlog')).toHaveClass('is-active')
    expect(screen.getByTestId('tab-btn-inprogress')).not.toHaveClass('is-active')
  })

  test('a cold load of /you activates the account row', () => {
    renderTabs(snapshotWith(), { path: '/you' })
    expect(screen.getByTestId('sidebar-account')).toHaveClass('is-active')
  })

  test('the standup button exists on the Done tab only', async () => {
    const { router } = renderTabs(snapshotWith(), { path: '/' })
    expect(screen.queryByTestId('standup-btn')).not.toBeInTheDocument()

    await act(() => router.navigate('/done'))
    expect(screen.getByTestId('standup-btn')).toBeInTheDocument()

    await act(() => router.navigate('/you'))
    expect(screen.queryByTestId('standup-btn')).not.toBeInTheDocument()
  })
})

describe('BoardTabs navigation', () => {
  test('clicking a tab navigates to its URL and closes the mobile sidebar drawer', async () => {
    const { router } = renderTabs(snapshotWith())

    await act(async () => { fireEvent.click(screen.getByTestId('tab-btn-backlog')) })

    expect(router.state.location.pathname).toBe('/backlog')
    expect(sidebarStore.get().isMobileOpen).toBe(false)
  })

  test('the account row opens the You tab, and the default tab goes back to bare "/"', async () => {
    const { router } = renderTabs(snapshotWith(), { path: '/done' })

    await act(async () => { fireEvent.click(screen.getByTestId('sidebar-account')) })
    expect(router.state.location.pathname).toBe('/you')

    await act(async () => { fireEvent.click(screen.getByTestId('tab-btn-inprogress')) })
    expect(router.state.location.pathname).toBe('/')
  })

  test('clicking the tab that is already showing adds no history entry', async () => {
    const { router } = renderTabs(snapshotWith(), { path: '/backlog' })
    const before = window.history.length

    await act(async () => { fireEvent.click(screen.getByTestId('tab-btn-backlog')) })

    expect(window.history.length).toBe(before)
    expect(router.state.location.pathname).toBe('/backlog')
  })

  test('from an open task detail, the tab URL replaces the task route, which is what closes it', async () => {
    const { router } = renderTabs(snapshotWith(), { path: '/task/active-api' })

    await act(async () => { fireEvent.click(screen.getByTestId('tab-btn-done')) })

    expect(router.state.location.pathname).toBe('/done')
  })

  test('resuming a backlog item follows it to the Active tab', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchImpl)
    const shelved = { ...backlogItem('shelved one', 'acme-api'), shelvedSlug: 'old-task' }
    const { router } = renderTabs(snapshotWith({ backlog: [shelved] }), { path: '/backlog' })

    await act(async () => { fireEvent.click(screen.getByTestId('backlog-resume-btn')) })

    expect(router.state.location.pathname).toBe('/')
    vi.unstubAllGlobals()
  })
})
