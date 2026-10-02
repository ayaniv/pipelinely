import '../../../testing/flowJsdomShims'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Task } from '../../../../../src/types'
import { runWaveBatch } from '../../../api/waveBatch'
import { clientState } from '../../../data/clientState'
import { SNAPSHOT_QUERY_KEY } from '../../../data/snapshot'
import { makeMilestone, makeTask } from '../../../testing/makeTask'
import { TaskDetailNavProvider, type TaskDetailNavApi } from '../detailNav'
import { MilestoneGraph } from './MilestoneGraph'

vi.mock('../../../api/waveBatch', () => ({ runWaveBatch: vi.fn(), WAVE_STATUS_VISIBLE_MS: 5000 }))

type ObserverEntry = { target?: Element, contentRect: { width: number, height: number }, borderBoxSize?: Array<{ blockSize: number }> }
let observers: Array<{ callback: (entries: ObserverEntry[]) => void, disconnect: () => void }>

const PLAN_REVIEWED = [{ stage: 'plan-review' as const, at: '2026-01-01T00:00:00Z', note: '' }]
let navApi: TaskDetailNavApi

beforeEach(() => {
  observers = []
  globalThis.ResizeObserver = class {
    private entry: { callback: (entries: ObserverEntry[]) => void, disconnect: () => void }
    constructor(callback: (entries: ObserverEntry[]) => void) {
      this.entry = { callback, disconnect: vi.fn() }
      observers.push(this.entry)
    }
    observe() {}
    unobserve() {}
    disconnect() { this.entry.disconnect() }
  } as unknown as typeof ResizeObserver
  navApi = { nav: { l1Tab: 'dev', l2Tab: null, milestoneId: null }, selectL1Tab: vi.fn(), selectStageTab: vi.fn(), selectMilestone: vi.fn(), leaveMilestone: vi.fn() }
  vi.mocked(runWaveBatch).mockReset()
})
afterEach(() => { clientState.setWaveRunning('parent', 2, false) })

const milestones = [
  makeMilestone({ id: 'M0', wave: 1, state: 'done' }),
  makeMilestone({ id: 'M1', wave: 2, needs: ['M0'] }),
]

function renderGraph(list = milestones, { isCanonical = true, stageHistory = PLAN_REVIEWED }: { isCanonical?: boolean; stageHistory?: Task['stageHistory'] } = {}) {
  const parent = makeTask({ slug: 'parent', milestones: list, stageHistory })
  const queryClient = new QueryClient()
  queryClient.setQueryData(SNAPSHOT_QUERY_KEY, { tasks: [parent], isCanonical })
  const ui = render(
    <QueryClientProvider client={queryClient}>
      <TaskDetailNavProvider value={navApi}>
        <MilestoneGraph task={parent} milestones={list} />
      </TaskDetailNavProvider>
    </QueryClientProvider>,
  )
  return { ...ui, parent }
}

const waveButton = (index: number) => within(screen.getAllByTestId('wave')[index]).getByTestId('wave-batch-btn')

describe('MilestoneGraph', () => {
  test('renders a wave header per wave and a real milestone card per milestone', () => {
    renderGraph()

    expect(screen.getAllByTestId('wave-header')).toHaveLength(2)
    expect(screen.getAllByTestId('milestone-card').map((card) => card.getAttribute('data-milestone-id'))).toEqual(['M0', 'M1'])
  })

  test('each wave header states the rule its wave is under', () => {
    renderGraph()
    const rules = screen.getAllByTestId('wave').map((wave) => wave.querySelector('.wave-rule')?.textContent)
    expect(rules).toEqual(['sequential · alone', 'sequential · alone'])
  })

  test('selecting a milestone card goes through the task detail nav', () => {
    renderGraph()
    fireEvent.click(screen.getAllByTestId('milestone-card')[1])
    expect(navApi.selectMilestone).toHaveBeenCalledWith('M1')
  })

  test('the Run wave button shows the eligible count and is disabled when nothing is eligible', () => {
    renderGraph()

    expect(within(screen.getAllByTestId('wave')[0]).getByTestId('wave-batch-count')).toHaveTextContent('0')
    expect(waveButton(0)).toBeDisabled()
    expect(within(screen.getAllByTestId('wave')[1]).getByTestId('wave-batch-count')).toHaveTextContent('1')
    expect(waveButton(1)).toBeEnabled()
  })

  test('nothing is eligible until the plan has been reviewed', () => {
    renderGraph(milestones, { stageHistory: [] })
    expect(waveButton(1)).toBeDisabled()
  })

  test('clicking Run wave runs that wave of this parent', () => {
    const { parent } = renderGraph()

    fireEvent.click(waveButton(1))

    expect(runWaveBatch).toHaveBeenCalledWith(parent, 2)
  })

  test('a batch in flight disables the button, with the reason as its title, and re-enables when it settles', () => {
    renderGraph()
    act(() => clientState.setWaveRunning('parent', 2, true))

    expect(waveButton(1)).toBeDisabled()
    expect(waveButton(1)).toHaveAttribute('title', 'Staging wave 2…')

    act(() => clientState.setWaveRunning('parent', 2, false))
    expect(waveButton(1)).toBeEnabled()
  })

  test('a non-canonical instance disables it, with the read-only reason as its title', () => {
    renderGraph(milestones, { isCanonical: false })

    expect(waveButton(1)).toBeDisabled()
    expect(waveButton(1).getAttribute('title')).toMatch(/not the canonical/)
    fireEvent.click(waveButton(1))
    expect(runWaveBatch).not.toHaveBeenCalled()
  })

  test('a reported card height pushes the next wave down by it', () => {
    const { container } = renderGraph()
    const waveTwoY = () => {
      const transform = container.querySelector<HTMLElement>('.react-flow__node[data-id="wave-2"]')?.style.transform ?? ''
      return Number(transform.match(/translate\(\s*[\d.]+px,\s*([\d.]+)px/)?.[1])
    }
    const before = waveTwoY()

    act(() => observers.forEach((observer) => observer.callback([{ target: document.createElement('div'), contentRect: { width: 300, height: 900 }, borderBoxSize: [{ blockSize: 900 }] }])))

    expect(waveTwoY()).toBeGreaterThan(before)
  })

  test('disconnects every height observer on unmount', () => {
    const { unmount } = renderGraph()
    unmount()
    // React Flow keeps its own observers too, so assert on the hook's: every
    // node reporting a height must have released its observer.
    expect(observers.filter((observer) => vi.mocked(observer.disconnect).mock.calls.length > 0).length).toBeGreaterThanOrEqual(3)
  })

  test('an empty milestone list draws nothing', () => {
    renderGraph([])
    expect(screen.queryByTestId('wave-header')).not.toBeInTheDocument()
  })
})
