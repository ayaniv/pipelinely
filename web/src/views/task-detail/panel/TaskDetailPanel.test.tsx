import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { MilestoneStatus, Task } from '../../../../../src/types'
import { TaskDetailNavProvider, type TaskDetailNav } from '../detailNav'
import { SNAPSHOT_QUERY_KEY } from '../../../data/snapshot'
import { TaskDetailPanel } from './TaskDetailPanel'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const task = (overrides: Partial<Task> = {}): Task => ({
  slug: 'p', title: 'P', status: 'working', stage: 'dev', stageHistory: [], waitingReason: undefined, verifier: null, worktree: null,
  devUrl: null, branch: 'b', findings: [], findingsParseMismatch: [], qaFailures: [], qaCases: [], qaCasesParseMismatch: [], attentionStatus: 'working', ...overrides,
}) as unknown as Task
const milestone = (id: string, overrides: Partial<MilestoneStatus> = {}): MilestoneStatus => ({ id, name: id, needs: [], estimate: null, specFile: null, wave: 1, task: null, state: 'queued', ...overrides })
const nav = (overrides: Partial<TaskDetailNav> = {}): TaskDetailNav => ({ l1Tab: 'dev', l2Tab: null, milestoneId: null, ...overrides })

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(url.startsWith('/api/stage-scope') ? json(200, { stages: {} }) : url.startsWith('/tech-design/') ? json(200, { html: '<p>doc</p>', summaryHtml: null, testGroups: [] }) : json(200, {}))))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const navApi = (navigation: TaskDetailNav) => ({ nav: navigation, selectL1Tab: vi.fn(), selectStageTab: vi.fn(), selectMilestone: vi.fn(), leaveMilestone: vi.fn() })

function renderPanel(open: Task, navigation: TaskDetailNav, allTasks: Task[] = [open]) {
  const queryClient = new QueryClient()
  queryClient.setQueryData(SNAPSHOT_QUERY_KEY, { tasks: allTasks })
  return render(
    <QueryClientProvider client={queryClient}>
      <TaskDetailNavProvider value={navApi(navigation)}>
        <TaskDetailPanel task={open} nav={navigation} graph={<div data-testid="detail-graph-slot" />} />
      </TaskDetailNavProvider>
    </QueryClientProvider>,
  )
}

const domOrder = (a: HTMLElement, b: HTMLElement) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING

describe('a flat task', () => {
  test('renders the graph slot, then a panel slot holding the bordered stage panel for the default tab', () => {
    renderPanel(task({ status: 'waiting', waitingReason: 'PR open, ready for CR' }), nav())

    expect(domOrder(screen.getByTestId('detail-graph-slot'), screen.getByTestId('detail-panel-slot'))).toBeTruthy()
    expect(within(screen.getByTestId('detail-panel-slot')).getByTestId('l2-panel')).toContainElement(screen.getByTestId('l2-panel-title'))
    expect(screen.getByTestId('l2-panel-title')).toHaveTextContent('CR')
  })

  test('has no L1 tab bar — that is a fan-out parent\'s', () => {
    renderPanel(task(), nav())
    expect(screen.queryByTestId('l1-tabs')).toBeNull()
    expect(screen.queryByTestId('l1-panel')).toBeNull()
  })

  test('an explicit planning tab shows the plan inside the bordered panel', async () => {
    renderPanel(task(), nav({ l2Tab: 'planning' }))
    expect(screen.getByTestId('l2-panel')).toContainElement(screen.getByTestId('tech-design-body'))
    expect(screen.getByTestId('l2-panel-title')).toHaveTextContent('Planning')
    await waitFor(() => expect(screen.getByTestId('tech-design-body')).toHaveTextContent('doc'))
  })
})

describe('a dispatched milestone child opened on its own', () => {
  const child = task({ slug: 'p-m1', projectTitle: 'P', projectBase: 'p' })
  const parent = task({ slug: 'p', milestones: [milestone('M1', { needs: ['M0'], state: 'dispatched', task: child })] })

  test('shows its six-stage panel once its parent declaration is known', () => {
    renderPanel(child, nav(), [parent, child])
    expect(screen.getByTestId('l2-panel-title')).toHaveTextContent('Dev')
    expect(screen.getAllByTestId('milestone-dispatch-row')[0]).toHaveTextContent('needsM0')
  })

  test('shows a loading note, inside the same bordered panel, until then', () => {
    renderPanel(child, nav(), [child])
    expect(within(screen.getByTestId('l2-panel')).getByTestId('milestone-loading-note')).toBeInTheDocument()
  })
})

describe('a fan-out parent', () => {
  const m0 = milestone('M0', { state: 'done', task: task({ slug: 'p-m0', status: 'done' }) })
  const parent = task({ slug: 'p', milestones: [m0, milestone('M1', { needs: ['M0'] })], stageHistory: [{ stage: 'plan-review', at: 'x', note: '' }] } as Partial<Task>)

  test('leads with the L1 tab bar, then an l1-panel holding the graph slot and the panel slot in that order', () => {
    renderPanel(parent, nav())

    const tabs = screen.getByTestId('l1-tabs')
    const l1Panel = screen.getByTestId('l1-panel')
    expect(domOrder(tabs, l1Panel)).toBeTruthy()
    expect(l1Panel).toContainElement(screen.getByTestId('detail-graph-slot'))
    expect(l1Panel).toContainElement(screen.getByTestId('detail-panel-slot'))
    expect(domOrder(screen.getByTestId('detail-graph-slot'), screen.getByTestId('detail-panel-slot'))).toBeTruthy()
    expect(screen.getByTestId('l1-tab-dev')).toHaveClass('is-active')
  })

  test('on the Dev tab with no milestone opened, the panel slot is empty', () => {
    renderPanel(parent, nav())
    expect(screen.getByTestId('detail-panel-slot')).toBeEmptyDOMElement()
  })

  test('on a plan tab, shows the plan directly in the panel slot — not inside a bordered stage panel', async () => {
    renderPanel(parent, nav({ l1Tab: 'plan' }))

    expect(within(screen.getByTestId('detail-panel-slot')).getByTestId('tech-design-body')).toBeInTheDocument()
    expect(screen.queryByTestId('l2-panel')).toBeNull()
    expect(screen.getByTestId('l2-panel-title')).toHaveTextContent('Planning')
    await waitFor(() => expect(screen.getByTestId('tech-design-body')).toHaveTextContent('doc'))
  })

  test('opened into a milestone, shows that milestone\'s stage panel in the bordered card', () => {
    renderPanel(parent, nav({ milestoneId: 'M0' }))
    expect(within(screen.getByTestId('l2-panel')).getByTestId('l2-panel-title')).toHaveTextContent('Dev')
  })
})

describe('crash isolation', () => {
  test('a throw while rendering the panel is contained to the panel slot — the graph and tab bar stay up — and logged', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // A finding with no fields: the CR checklist dereferences them.
    const broken = task({ status: 'waiting', waitingReason: 'PR open, ready for CR', findings: [null as never] })

    renderPanel(broken, nav({ l2Tab: 'cr' }))

    expect(screen.getByTestId('view-error-task-detail-panel')).toBeInTheDocument()
    expect(screen.getByTestId('detail-graph-slot')).toBeInTheDocument()
    expect(console.error).toHaveBeenCalledWith('[view:task-detail-panel] crashed', expect.anything(), expect.anything())
  })

  test('opening a different task resets the boundary, so one bad task does not blank the next', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = task({ slug: 'bad', findings: [null as never] })
    const healthy = task({ slug: 'good' })
    const queryClient = new QueryClient()
    queryClient.setQueryData(SNAPSHOT_QUERY_KEY, { tasks: [broken, healthy] })
    const ui = (open: Task) => (
      <QueryClientProvider client={queryClient}>
        <TaskDetailNavProvider value={navApi(nav({ l2Tab: 'cr' }))}>
          <TaskDetailPanel task={open} nav={nav({ l2Tab: 'cr' })} graph={null} />
        </TaskDetailNavProvider>
      </QueryClientProvider>
    )
    const { rerender } = render(ui(broken))
    expect(screen.getByTestId('view-error-task-detail-panel')).toBeInTheDocument()

    rerender(ui(healthy))

    expect(screen.queryByTestId('view-error-task-detail-panel')).toBeNull()
    expect(screen.getByTestId('l2-panel-title')).toBeInTheDocument()
  })
})
