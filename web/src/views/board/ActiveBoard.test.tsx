import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Snapshot } from '../../data/snapshot'
import { SNAPSHOT_QUERY_KEY } from '../../data/snapshot'
import { ActiveBoard } from './ActiveBoard'
import { createProjectFilterStore } from './boardFilter'
import { makeTask } from './testTask'

// The board's React half, wired the way ShellFrame wires it: every visible
// piece portals into a container the app frame owns, driven by
// the snapshot cache. The sidebar's counts are BoardTabs'.

const SLOT_IDS = ['active-cards', 'summary-strip', 'filter-project-chips', 'weekly-focus-row', 'weekly-focus-dates', 'global-progress']

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

function renderBoard(snapshot: Snapshot | undefined, store = createProjectFilterStore()) {
  if (snapshot) queryClient.setQueryData(SNAPSHOT_QUERY_KEY, snapshot)
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ActiveBoard filterStore={store} />
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
