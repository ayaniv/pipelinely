import '../../testing/flowJsdomShims'
import { describe, expect, test, vi, afterEach, beforeEach, type Mock } from 'vitest'
import { render, screen, act, within, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route, createMemoryRouter, RouterProvider } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TaskDetail } from './TaskDetail'
import { SNAPSHOT_QUERY_KEY } from '../../data/snapshot'
import type { Task } from '../../../../src/types'
import { clientState } from '../../data/clientState'
import { installAppNavigator } from '../../shell/appNavigation'
import { rememberBoardTab } from '../board/boardTabRoutes'

// Wiring test for the route-level view: given a matched /task/:slug and the
// snapshot cache, does it render the right frame (or nothing)? Per-primitive
// behavior (CardMenu's item set, FocusButton's flash, …) is proven by each
// primitive's own test — this only proves TaskDetail wires them to the right
// task data, the shared client state and the router.

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    slug: 'demo-task', title: 'Demo task', mode: 'implement', repo: 'r', branch: 'claude/demo-task',
    worktree: null, devUrl: null, verifier: null, itermSessionId: null, tmuxSession: null, plan: null,
    stageHistory: [], stage: 'dev', findings: [], findingsParseMismatch: [], qaFailures: [], qaCases: [],
    qaCasesParseMismatch: [], showsOnBoard: true, attentionStatus: 'working', autoModeOverride: 'inherit',
    autoMode: true, status: 'working', updatedAt: new Date(), completedAt: null, completedAtSource: null,
    totalInputTokens: 0, totalOutputTokens: 0, sessions: [], ...overrides,
  } as Task
}

function setSnapshot(queryClient: QueryClient, tasks: Task[]) {
  queryClient.setQueryData(SNAPSHOT_QUERY_KEY, {
    tasks, activeProject: null, weeklyFocus: '', backlog: [], doneGroups: [],
    settings: { autoMode: false }, orchestratorContextPct: null, isCanonical: false,
  })
}

function renderAt(path: string, tasks: Task[] | undefined) {
  // The page's own URL, which the app's navigation compares against to decide
  // push vs replace — MemoryRouter's location is separate from it.
  window.history.replaceState(null, '', path)
  const queryClient = new QueryClient()
  if (tasks) setSnapshot(queryClient, tasks)
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/task/:slug" element={<TaskDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...result, queryClient }
}

let navigate: Mock<(to: string, options?: { replace?: boolean }) => void>
let uninstallNavigator: () => void

beforeEach(() => {
  // The React panel lazily fetches the stage-scope blocks and the plan.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ stages: {} }), { status: 200 })))
  navigate = vi.fn()
  uninstallNavigator = installAppNavigator(navigate)
  // The Back pill portals into the header's slot, which the frame owns.
  document.body.innerHTML = '<div id="header-back-slot"></div>'
})

afterEach(() => {
  uninstallNavigator()
  vi.unstubAllGlobals()
  document.body.className = ''
  rememberBoardTab('inprogress')
  window.history.replaceState(null, '', '/')
  if (clientState.isOffFocus('demo-task')) clientState.toggleOffFocus('demo-task')
})

const headActions = () => document.querySelector('.detail-actions') as HTMLElement

describe('TaskDetail', () => {
  test('renders nothing before the snapshot has loaded', () => {
    renderAt('/task/demo-task', undefined)
    expect(screen.queryByTestId('task-detail')).not.toBeInTheDocument()
  })

  test('renders nothing for a slug the loaded snapshot has no matching task for', () => {
    renderAt('/task/does-not-exist', [makeTask()])
    expect(screen.queryByTestId('task-detail')).not.toBeInTheDocument()
  })

  test('renders the full frame for a matched task', async () => {
    renderAt('/task/demo-task', [makeTask({ title: 'Demo task', contextPct: 42 })])

    expect(screen.getByTestId('task-detail')).toBeInTheDocument()
    expect(document.getElementById('detail-title')).toHaveTextContent('Demo task')
    expect(screen.getAllByTestId('detail-meta-label').length).toBeGreaterThan(0)
    expect(within(headActions()).getByTestId('focus-btn')).toBeInTheDocument()
    expect(screen.getByTestId('card-menu-btn')).toBeInTheDocument()
    // The graph and the panel arrive together, once the lazy graph chunk is in.
    expect(await screen.findByTestId('detail-graph-slot')).toBeInTheDocument()
    expect(screen.getByTestId('detail-panel-slot')).toBeInTheDocument()
    // The panel slot is React-rendered from the task itself:
    // a dispatched flat task with no next stage lands on its Dev panel.
    expect(screen.getByTestId('l2-panel')).toContainElement(screen.getByTestId('l2-panel-title'))
    expect(screen.getByTestId('l2-panel-title')).toHaveTextContent('Dev')
  })

  test('a fan-out parent gets the L1 tab bar, opened on Dev when it is already in dev, and switchable', async () => {
    renderAt('/task/demo-task', [makeTask({ stage: 'dev', milestones: [{ id: 'M0', name: 'M0', needs: [], estimate: null, specFile: null, wave: 1, task: null, state: 'queued' }] })])

    expect(await screen.findByTestId('l1-tabs')).toBeInTheDocument()
    expect(screen.getByTestId('l1-tab-dev')).toHaveClass('is-active')

    fireEvent.click(screen.getByTestId('l1-tab-plan'))
    expect(screen.getByTestId('l1-tab-plan')).toHaveClass('is-active')
    expect(screen.getByTestId('l1-tab-dev')).not.toHaveClass('is-active')
  })

  test('a fan-out parent still in planning opens on the Plan tab', () => {
    renderAt('/task/demo-task', [makeTask({ stage: 'planning', milestones: [{ id: 'M0', name: 'M0', needs: [], estimate: null, specFile: null, wave: 1, task: null, state: 'queued' }] })])
    expect(screen.getByTestId('l1-tab-plan')).toHaveClass('is-active')
  })

  test('a flat task has no L1 tab bar', async () => {
    renderAt('/task/demo-task', [makeTask()])
    await screen.findByTestId('detail-panel-slot')
    expect(screen.queryByTestId('l1-tabs')).not.toBeInTheDocument()
  })

  test('omits the ctx row entirely for a task with no recorded context', () => {
    renderAt('/task/demo-task', [makeTask({ contextPct: undefined })])
    expect(screen.getByTestId('detail-ctx-row')).toBeEmptyDOMElement()
  })

  test('a hot, non-done task shows the handover pill in the ctx row', () => {
    renderAt('/task/demo-task', [makeTask({ contextPct: 75, status: 'working' })])
    expect(screen.getByTestId('detail-handover')).toBeInTheDocument()
  })

  test('shows no parent link for a flat task', () => {
    renderAt('/task/demo-task', [makeTask()])
    expect(screen.queryByTestId('detail-parent-link')).not.toBeInTheDocument()
  })

  test('shows a parent link for a milestone child, and navigates to the parent on click', () => {
    renderAt('/task/demo-task', [makeTask({ projectTitle: 'Parent fixture', projectBase: 'parent-task' })])

    const link = screen.getByTestId('detail-parent-link')
    expect(link).toHaveTextContent('Parent fixture')
    fireEvent.click(link)

    expect(navigate).toHaveBeenCalledWith('/task/parent-task', undefined)
  })

  test('a shelved task hides the focus button', () => {
    renderAt('/task/demo-task', [makeTask({ status: 'shelved' })])
    // Scoped to the head's own action row — the Dev stage panel below has a
    // Terminal button of its own.
    expect(within(headActions()).queryByTestId('focus-btn')).not.toBeInTheDocument()
  })

  // Regression guard: a single SSE broadcast missing the open task is not
  // proof it's gone (the /events payload and /api/tasks can momentarily
  // disagree). The view only closes once that's been re-confirmed against
  // /api/tasks (useCloseWhenTaskGone), and must not unmount itself off one
  // incomplete snapshot in the meantime, or a cold /task/<slug> load can land
  // back on the board the instant an unrelated task's file write triggers a
  // refresh.
  test('a transient snapshot missing the open task keeps showing the last-known task rather than unmounting', async () => {
    const { queryClient } = renderAt('/task/demo-task', [makeTask({ title: 'Demo task' })])
    expect(screen.getByTestId('task-detail')).toBeInTheDocument()

    // TanStack Query's notifyManager batches cache-update notifications via
    // a microtask, so an async act() (which awaits one) is needed to
    // actually observe the re-render this triggers — a bare sync call
    // would let this assertion pass regardless of whether the fix works.
    await act(async () => { setSnapshot(queryClient, []) }) // a transient broadcast missing every task, demo-task included

    expect(screen.getByTestId('task-detail')).toBeInTheDocument()
    expect(document.getElementById('detail-title')).toHaveTextContent('Demo task')
  })

  // The sticky fallback above must not leak a stale task's data across a
  // genuine navigation to a different task. Uses createMemoryRouter (an
  // imperative router, same shape as main.tsx's own createBrowserRouter)
  // rather than remounting a fresh <MemoryRouter>, so TaskDetail is the
  // SAME component instance across the navigation — react-router does not
  // remount a matched route element just because its params changed, which
  // is exactly the case the sticky ref has to reset itself for.
  test('switching to a different task clears any stale sticky data from the previous one', async () => {
    const queryClient = new QueryClient()
    setSnapshot(queryClient, [makeTask({ title: 'Demo task' })])
    const router = createMemoryRouter(
      [{ path: '/task/:slug', element: <TaskDetail /> }],
      { initialEntries: ['/task/demo-task'] },
    )
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )
    expect(document.getElementById('detail-title')).toHaveTextContent('Demo task')

    // demo-task transiently missing (see the sticky test above), then back.
    await act(async () => { setSnapshot(queryClient, []) })
    expect(document.getElementById('detail-title')).toHaveTextContent('Demo task')

    // A real navigation to a different task, whose data has already arrived.
    setSnapshot(queryClient, [makeTask({ slug: 'other-task', title: 'Other task' })])
    await act(async () => { await router.navigate('/task/other-task') })

    expect(document.getElementById('detail-title')).toHaveTextContent('Other task')
  })
})

describe('TaskDetail: page behavior', () => {
  test('holds body.detail-open while mounted, which is what hides the board, and releases it on unmount', () => {
    const { unmount } = renderAt('/task/demo-task', [makeTask()])
    expect(document.body).toHaveClass('detail-open')
    unmount()
    expect(document.body).not.toHaveClass('detail-open')
  })

  test('does not hide the board for a slug that has no task', () => {
    renderAt('/task/nope', [makeTask()])
    expect(document.body).not.toHaveClass('detail-open')
  })

  test('puts the Back pill in the header slot, and it returns to the board tab last shown', () => {
    rememberBoardTab('done')
    renderAt('/task/demo-task', [makeTask()])

    const back = screen.getByTestId('detail-close')
    expect(document.getElementById('header-back-slot')).toContainElement(back)
    fireEvent.click(back)

    expect(navigate).toHaveBeenCalledWith('/done', undefined)
  })

  test('Escape closes the view the same way', () => {
    renderAt('/task/demo-task', [makeTask()])
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(navigate).toHaveBeenCalledWith('/', undefined)
  })

  test('stops listening for Escape once it has unmounted', () => {
    const { unmount } = renderAt('/task/demo-task', [makeTask()])
    unmount()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(navigate).not.toHaveBeenCalled()
  })

  test('the card menu\'s off-focus item flips the shared off-focus state and tags the status line', async () => {
    renderAt('/task/demo-task', [makeTask()])
    fireEvent.click(screen.getByTestId('card-menu-btn'))
    await act(async () => { fireEvent.click(screen.getByTestId('card-menu-toggle-off-focus')) })

    expect(clientState.isOffFocus('demo-task')).toBe(true)
    expect(screen.getByTestId('detail-status-line')).toHaveTextContent('off focus')
  })

  test('the auto-mode select names what "inherit" resolves to from the global setting', () => {
    renderAt('/task/demo-task', [makeTask({ autoModeOverride: 'inherit' })])
    const select = within(screen.getByTestId('detail-auto-mode-slot')).getByTestId('task-auto-mode')
    expect(select).toHaveValue('inherit')
    expect(within(select).getByRole('option', { name: 'Default (manual)' })).toBeInTheDocument()
  })

  test('re-checks /api/tasks before closing when the task vanishes from the snapshot, and closes once it is confirmed gone', async () => {
    const fetchMock = vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url === '/api/tasks' ? { tasks: [] } : { stages: {} }), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
    const { queryClient } = renderAt('/task/demo-task', [makeTask()])
    expect(navigate).not.toHaveBeenCalled()

    await act(async () => { setSnapshot(queryClient, []) })

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/', undefined))
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks', expect.anything())
  })
})

describe('TaskDetail: Result tab', () => {
  const resultDoc = { file: 'AUDIT.md', isTruncated: false, totalBytes: 15, mtimeMs: 1000 }

  // The snapshot carries only metadata; the tab fetches the markdown itself.
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url.startsWith('/result-doc/') ? { ...resultDoc, markdown: '# Audit heading' } : { stages: {} }), { status: 200 }))))
  })

  test('a task with no result document has no view tabs', () => {
    renderAt('/task/demo-task', [makeTask()])
    expect(screen.queryByTestId('task-view-tabs')).not.toBeInTheDocument()
  })

  test('a task with a result document offers Pipeline and Result tabs, defaulting to Pipeline', () => {
    renderAt('/task/demo-task', [makeTask({ resultDoc })])
    expect(screen.getByTestId('task-view-tab-pipeline')).toHaveClass('is-active')
    expect(screen.getByTestId('task-view-tab-result')).not.toHaveClass('is-active')
    expect(screen.getByTestId('detail-panel-slot')).toBeInTheDocument()
    expect(screen.queryByTestId('result-tab')).not.toBeInTheDocument()
  })

  test('?stage=result opens on the Result tab and hides the pipeline', async () => {
    renderAt('/task/demo-task?stage=result', [makeTask({ resultDoc })])
    expect(screen.getByTestId('task-view-tab-result')).toHaveClass('is-active')
    expect(await screen.findByTestId('result-doc-body')).toHaveTextContent('Audit heading')
    expect(screen.queryByTestId('detail-panel-slot')).not.toBeInTheDocument()
  })

  test('the markdown is not requested until the Result tab is opened', async () => {
    renderAt('/task/demo-task', [makeTask({ resultDoc })])
    const urls = () => (fetch as ReturnType<typeof vi.fn>).mock.calls.map(([url]) => String(url))
    expect(urls().some((url) => url.startsWith('/result-doc/'))).toBe(false)
    act(() => screen.getByTestId('task-view-tab-result').click())
    await screen.findByTestId('result-doc-body')
    expect(urls().filter((url) => url.startsWith('/result-doc/'))).toEqual(['/result-doc/demo-task'])
  })

  test('clicking the Result tab switches to it, and Pipeline switches back', async () => {
    renderAt('/task/demo-task', [makeTask({ resultDoc })])
    act(() => screen.getByTestId('task-view-tab-result').click())
    expect(await screen.findByTestId('result-doc-body')).toBeInTheDocument()
    act(() => screen.getByTestId('task-view-tab-pipeline').click())
    expect(screen.getByTestId('detail-panel-slot')).toBeInTheDocument()
  })

  test('keeps the stepper in the Pipeline view', () => {
    renderAt('/task/demo-task', [makeTask({ resultDoc })])
    expect(screen.getByTestId('detail-stepper-slot')).toBeInTheDocument()
  })

  test('hides the stepper in the Result view, where a stage click would silently drop ?stage=result', () => {
    renderAt('/task/demo-task?stage=result', [makeTask({ resultDoc })])
    expect(screen.queryByTestId('detail-stepper-slot')).not.toBeInTheDocument()
  })

  test('the tab bar controls the one panel below it', () => {
    renderAt('/task/demo-task?stage=result', [makeTask({ resultDoc })])
    expect(screen.getByTestId('task-view-panel')).toHaveAttribute('role', 'tabpanel')
    expect(screen.getByTestId('task-view-panel')).toHaveAttribute('id', screen.getByTestId('task-view-tab-result').getAttribute('aria-controls'))
  })

  test('the panel names the active tab as its accessible label', () => {
    renderAt('/task/demo-task?stage=result', [makeTask({ resultDoc })])
    expect(screen.getByTestId('task-view-panel')).toHaveAttribute('aria-labelledby', 'task-view-tab-result')
  })

  test('?stage=result on a task with no document falls back to the pipeline', () => {
    renderAt('/task/demo-task?stage=result', [makeTask()])
    expect(screen.getByTestId('detail-panel-slot')).toBeInTheDocument()
    expect(screen.queryByTestId('result-tab')).not.toBeInTheDocument()
  })
})
