import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { render, screen, act, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Snapshot } from '../../data/snapshot'
import { SNAPSHOT_QUERY_KEY } from '../../data/snapshot'
import { ActiveBoard } from './ActiveBoard'
import { createProjectFilterStore } from './boardFilter'
import type { BoardTab } from './boardTabRoutes'
import { clientState } from '../../data/clientState'
import { makeTask } from './testTask'
import { activeViewStore } from '../../data/activeView'
import { isBabysitWired } from './babysitWiring'

vi.mock('./babysitWiring', () => ({ isBabysitWired: vi.fn(() => false) }))
const setBabysitWired = (isWired: boolean) => vi.mocked(isBabysitWired).mockReturnValue(isWired)

// The board's React half, wired the way ShellFrame wires it: every visible
// piece portals into a container the app frame owns, driven by
// the snapshot cache. The sidebar's counts are BoardTabs'.

const SLOT_IDS = ['active-cards', 'active-view-slot', 'summary-strip', 'filter-project-chips', 'weekly-focus-row', 'weekly-focus-dates', 'global-progress']

function snapshotWith(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    tasks: [], activeProject: null, weeklyFocus: '', backlog: [], doneGroups: [],
    settings: { autoMode: false }, orchestratorContextPct: null, isCanonical: false, ...overrides,
  } as Snapshot
}

let queryClient: QueryClient

beforeEach(() => {
  for (const id of SLOT_IDS) {
    const el = document.createElement('div')
    el.id = id
    document.body.appendChild(el)
  }
  queryClient = new QueryClient()
})
afterEach(() => {
  document.body.innerHTML = ''
})

function renderBoard(snapshot: Snapshot | undefined, store = createProjectFilterStore(), activeTab: BoardTab = 'inprogress') {
  if (snapshot) queryClient.setQueryData(SNAPSHOT_QUERY_KEY, snapshot)
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ActiveBoard filterStore={store} activeTab={activeTab} />
    </QueryClientProvider>,
  )
  return { store, ...view }
}

// React Query notifies its observers on a setTimeout(0) tick, which an async
// act() alone doesn't wait out.
async function updateSnapshot(snapshot: Snapshot) {
  await act(async () => {
    queryClient.setQueryData(SNAPSHOT_QUERY_KEY, snapshot)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const cardsIn = () => within(document.getElementById('active-cards')!).queryAllByTestId('task-card')
const chip = (repo: string) => screen.getByTestId(`filter-chip-project-${repo}`)

describe('ActiveBoard', () => {
  test('renders nothing until the first snapshot has arrived', () => {
    renderBoard(undefined)
    expect(cardsIn()).toHaveLength(0)
    expect(screen.queryByTestId('pulse-chip-working')).not.toBeInTheDocument()
  })

  test('portals the cards, strip, chips, focus and progress into their containers', () => {
    renderBoard(snapshotWith({
      tasks: [makeTask({ slug: 'a', repo: 'r1' })],
      weeklyFocus: 'ship it',
      activeProject: { projectBase: 'proj', current: 1, total: 2 },
    }))

    expect(cardsIn()).toHaveLength(1)
    expect(document.getElementById('summary-strip')).toContainElement(screen.getByTestId('pulse-chip-working'))
    expect(document.getElementById('filter-project-chips')).toContainElement(chip('r1'))
    expect(document.getElementById('weekly-focus-row')).toContainElement(screen.getByTestId('weekly-focus-text'))
    expect(document.getElementById('global-progress')).toHaveClass('is-visible')
  })

  test('renders no focus pane while the Settings switch is off, even with a focus in the snapshot', () => {
    renderBoard(snapshotWith({
      weeklyFocus: 'ship it',
      settings: { autoMode: false, creaturePlacement: 'header', weeklyFocusEnabled: false, qaStartPolicy: 'ask-every-time' },
    }))
    expect(screen.queryByTestId('weekly-focus-text')).not.toBeInTheDocument()
    expect(document.getElementById('weekly-focus-row')).toBeEmptyDOMElement()
    expect(document.getElementById('weekly-focus-dates')).toBeEmptyDOMElement()
  })

  test('renders the focus pane while the switch is on', () => {
    renderBoard(snapshotWith({
      weeklyFocus: 'ship it',
      settings: { autoMode: false, creaturePlacement: 'header', weeklyFocusEnabled: true, qaStartPolicy: 'ask-every-time' },
    }))
    expect(screen.getByTestId('weekly-focus-text')).toHaveTextContent('ship it')
  })

  test('does not list done or off-board tasks, and the pulse counts what is visible', () => {
    renderBoard(snapshotWith({ tasks: [
      makeTask({ slug: 'a', status: 'working', attentionStatus: 'working' }),
      makeTask({ slug: 'b', showsOnBoard: false }),
      makeTask({ slug: 'c', status: 'done' }),
    ] }))
    expect(cardsIn().map((c) => c.getAttribute('data-slug'))).toEqual(['a'])
    expect(screen.getByTestId('pulse-chip-working')).toHaveTextContent('1 working')
  })

  test('re-renders when the snapshot cache changes, keeping an untouched card\'s node', async () => {
    renderBoard(snapshotWith({ tasks: [makeTask({ slug: 'a' }), makeTask({ slug: 'b', waitingReason: 'one' })] }))
    const nodeA = cardsIn()[0]

    await updateSnapshot(snapshotWith({ tasks: [makeTask({ slug: 'a' }), makeTask({ slug: 'b', waitingReason: 'two' })] }))

    expect(cardsIn()[0]).toBe(nodeA)
    expect(screen.getByTestId('card-note')).toHaveTextContent('two')
  })
})

describe('ActiveBoard: project filter', () => {
  const twoRepos = () => snapshotWith({
    tasks: [makeTask({ slug: 'a', repo: 'r1' }), makeTask({ slug: 'b', repo: 'r2' })],
    backlog: [{ description: 'x', date: null, context: null, done: false, shelvedSlug: null, project: 'r3' }] as never,
  })

  test('offers a chip per project on the board, backlog projects included', () => {
    renderBoard(twoRepos())
    expect(['r1', 'r2', 'r3'].map((repo) => chip(repo))).toHaveLength(3)
  })

  test('selecting a chip narrows the cards and the reported count; selecting another adds to it', () => {
    renderBoard(twoRepos())

    fireEvent.click(chip('r1'))
    expect(cardsIn().map((c) => c.getAttribute('data-slug'))).toEqual(['a'])

    fireEvent.click(chip('r2'))
    expect(cardsIn()).toHaveLength(2)
  })

  test('a selected project present only on the backlog leaves the shared empty state and a zero count', () => {
    renderBoard(twoRepos())
    fireEvent.click(chip('r3'))

    expect(screen.getByTestId('board-empty-state')).toBeInTheDocument()
  })

  test('a selection whose project disappears is pruned from the store, not left stranding an empty board', async () => {
    const { store } = renderBoard(twoRepos())
    fireEvent.click(chip('r2'))
    expect(cardsIn()).toHaveLength(1)

    await updateSnapshot(snapshotWith({ tasks: [makeTask({ slug: 'a', repo: 'r1' })] }))

    expect(store.getSelected().size > 0).toBe(false)
    expect(cardsIn().map((c) => c.getAttribute('data-slug'))).toEqual(['a'])
  })
})

describe('ActiveBoard: toolbar', () => {
  afterEach(() => {
    setBabysitWired(false)
    for (const slug of clientState.get().offFocusSlugs) clientState.toggleOffFocus(slug)
  })

  const tasks = () => [makeTask({ slug: 'a', repo: 'r1' }), makeTask({ slug: 'b', repo: 'r2' })]

  test('hides the Push forward pill while it is not wired, keeping New task and the chips', () => {
    renderBoard(snapshotWith({ tasks: tasks() }))
    expect(screen.queryByTestId('push-forward-pill')).toBeNull()
    expect(document.getElementById('summary-strip')).toContainElement(screen.getByTestId('new-task-pill'))
    expect(screen.getByTestId('pulse-chip-working')).toBeInTheDocument()
  })

  test('renders Push forward and New task in the strip on the Active tab only once it is wired', () => {
    setBabysitWired(true)
    const { unmount } = renderBoard(snapshotWith({ tasks: tasks() }))
    expect(document.getElementById('summary-strip')).toContainElement(screen.getByTestId('push-forward-pill'))
    expect(document.getElementById('summary-strip')).toContainElement(screen.getByTestId('new-task-pill'))
    unmount()

    for (const tab of ['done', 'backlog'] as const) {
      const view = renderBoard(snapshotWith({ tasks: tasks() }), undefined, tab)
      expect(screen.queryByTestId('push-forward-pill')).toBeNull()
      expect(screen.queryByTestId('new-task-pill')).toBeNull()
      expect(screen.getByTestId('pulse-chip-working')).toBeInTheDocument()
      view.unmount()
    }
  })

  test('the off focus chip counts visible off-focus tasks and shows on every tab', () => {
    clientState.toggleOffFocus('a')
    renderBoard(snapshotWith({ tasks: tasks() }), undefined, 'done')
    expect(screen.getByTestId('pulse-chip-off-focus')).toHaveAttribute('data-count', '1')
  })

  test('an off-focus task hidden by the project filter is not counted', () => {
    clientState.toggleOffFocus('a')
    const store = createProjectFilterStore()
    renderBoard(snapshotWith({ tasks: tasks() }), store)
    expect(screen.getByTestId('pulse-chip-off-focus')).toHaveAttribute('data-count', '1')
    act(() => { store.toggle('r2') })
    expect(screen.queryByTestId('pulse-chip-off-focus')).toBeNull()
  })

  test('the New task modal offers the same projects as the filter chips', () => {
    renderBoard(snapshotWith({ tasks: tasks() }))
    fireEvent.click(screen.getByTestId('new-task-pill'))
    const modalProjects = screen.getAllByTestId('new-task-project-chip').map((chip) => chip.getAttribute('data-project'))
    expect(modalProjects).toEqual(['r1', 'r2'])
    // This file's afterEach empties <body>, so close the portalled modal first.
    fireEvent.click(screen.getByTestId('new-task-cancel-btn'))
  })

  test('the Push forward needs-you list is built from the visible tasks and the snapshot\'s recorded settings', () => {
    setBabysitWired(true)
    const qaHandOff = makeTask({
      slug: 'qa-ready', repo: 'cockpit-ai', status: 'waiting', waitingReason: 'CR approved, ready for QA',
      verifier: 'npx playwright test --project=ui --grep-invert @pending',
    })
    const { unmount } = renderBoard(snapshotWith({ tasks: [qaHandOff], settings: { autoMode: false, qaStartPolicy: 'ask-every-time' } as Snapshot['settings'] }))
    fireEvent.click(screen.getByTestId('push-forward-needs-you-toggle'))
    expect(screen.getByTestId('needs-you-item')).toHaveAttribute('data-reason', 'qa-consent')
    unmount()

    renderBoard(snapshotWith({ tasks: [qaHandOff], settings: { autoMode: false, qaStartPolicy: 'cockpit-ai-ui-preapproved' } as Snapshot['settings'] }))
    fireEvent.click(screen.getByTestId('push-forward-needs-you-toggle'))
    expect(screen.getByTestId('needs-you-item')).toHaveAttribute('data-reason', 'qa-intent-brief')
  })
})

describe('ActiveBoard: card/table switch', () => {
  afterEach(() => activeViewStore.set('cards'))

  test('shows the switch on the Active tab only', () => {
    const { unmount } = renderBoard(snapshotWith({ tasks: [makeTask({ slug: 'a' })] }))
    expect(screen.getByTestId('active-view-switch')).toBeInTheDocument()
    unmount()
    renderBoard(snapshotWith({ tasks: [makeTask({ slug: 'a' })] }), createProjectFilterStore(), 'done')
    expect(screen.queryByTestId('active-view-switch')).not.toBeInTheDocument()
  })

  test('switching to the table swaps the cards for the lazy table, and back', async () => {
    renderBoard(snapshotWith({ tasks: [makeTask({ slug: 'a' })] }))
    expect(cardsIn()).toHaveLength(1)
    await act(async () => { fireEvent.click(screen.getByTestId('active-view-table')) })
    await waitFor(() => expect(screen.getByTestId('active-table-working')).toBeInTheDocument())
    expect(cardsIn()).toHaveLength(0)
    expect(screen.getByTestId('active-view-table')).toHaveAttribute('aria-pressed', 'true')
    await act(async () => { fireEvent.click(screen.getByTestId('active-view-cards')) })
    expect(cardsIn()).toHaveLength(1)
  })
})

describe('ActiveBoard: parent tasks section', () => {
  const milestone = (id: string, wave: number, state: 'queued' | 'dispatched' | 'done') => ({ id, name: `${id} name`, needs: [], estimate: null, specFile: null, wave, task: null, state })
  const parentOf = (slug: string, repo: string, overrides = {}) => makeTask({ slug, title: `Parent ${slug}`, repo, status: 'working', attentionStatus: 'working', stageHistory: [{ stage: 'plan-review', at: '2026-01-01T00:00:00Z', note: '' }], milestones: [milestone('M1', 1, 'dispatched'), milestone('M2', 2, 'queued')], ...overrides })
  const withParent = () => snapshotWith({ tasks: [parentOf('p1', 'r1'), makeTask({ slug: 'leaf-a', repo: 'r1' }), makeTask({ slug: 'leaf-n', repo: 'r2', attentionStatus: 'needs-you', status: 'waiting' })] })
  const sectionIn = () => within(document.getElementById('active-cards')!).queryByTestId('parent-tasks-section')
  const parentRows = () => within(document.getElementById('active-cards')!).queryAllByTestId('parent-row')

  afterEach(() => { activeViewStore.set('cards') })

  test('card view: the section sits above Needs you, holds the parent, and the parent is no card in any group', () => {
    renderBoard(withParent())
    const container = document.getElementById('active-cards')!
    const section = sectionIn()!
    expect(parentRows().map((row) => row.dataset.slug)).toEqual(['p1'])
    expect(section.compareDocumentPosition(screen.getByTestId('active-group-needs')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(cardsIn().map((c) => c.getAttribute('data-slug')).sort()).toEqual(['leaf-a', 'leaf-n'])
    expect(within(container).queryAllByTestId('plan-card')).toHaveLength(0)
  })

  test('table view: the same section above the groups, and the parent is no row in Needs you or Working', async () => {
    activeViewStore.set('table')
    renderBoard(withParent())
    await waitFor(() => expect(screen.getByTestId('active-table-working')).toBeInTheDocument())
    expect(parentRows().map((row) => row.dataset.slug)).toEqual(['p1'])
    const rowSlugs = within(document.getElementById('active-cards')!).getAllByRole('row').map((row) => row.getAttribute('data-slug')).filter(Boolean)
    expect(rowSlugs).not.toContain('p1')
    expect(rowSlugs).toContain('leaf-a')
  })

  test('the Active count and the waiting/working chips exclude the parent', () => {
    renderBoard(withParent())
    expect(screen.getByTestId('pulse-chip-working')).toHaveTextContent('1 working')
    expect(screen.getByTestId('pulse-chip-waiting')).toHaveTextContent('1 waiting')
  })

  test('a project filter with no parents in it hides the section; one with the parent shows it', () => {
    renderBoard(withParent())
    expect(sectionIn()).toBeInTheDocument()
    fireEvent.click(chip('r2'))
    expect(sectionIn()).not.toBeInTheDocument()
    fireEvent.click(chip('r2'))
    fireEvent.click(chip('r1'))
    expect(parentRows()).toHaveLength(1)
  })

  test('a board of parents only shows the section and not the empty state', () => {
    renderBoard(snapshotWith({ tasks: [parentOf('p1', 'r1')] }))
    expect(parentRows()).toHaveLength(1)
    expect(screen.queryByTestId('board-empty-state')).not.toBeInTheDocument()
  })

  test('no parents: no section', () => {
    renderBoard(snapshotWith({ tasks: [makeTask({ slug: 'a' })] }))
    expect(sectionIn()).not.toBeInTheDocument()
  })
})
