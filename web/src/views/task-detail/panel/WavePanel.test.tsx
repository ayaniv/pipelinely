import { Suspense } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { MilestoneStatus, StageEvent, Task } from '../../../../../src/types'
import { clientState } from '../../../data/clientState'
import { SNAPSHOT_QUERY_KEY } from '../../../data/snapshot'
import { READ_ONLY_INSTANCE_TITLE } from '../../../components/readOnly'
import { makeMilestone, makeTask } from '../../../testing/makeTask'
import { WavePanel } from './WavePanel'

// React Flow is not under test here; what matters is the header's button.
vi.mock('../graph/WaveGraph', () => ({ WaveGraph: () => <div data-testid="wave-graph-stub" /> }))

const PLAN_REVIEWED: StageEvent[] = [{ stage: 'plan-review', at: '2026-08-10T10:00:00Z', note: null }]
const merged = (id: string, wave: number) => makeMilestone({ id, wave, state: 'done', task: makeTask({ slug: `p-${id.toLowerCase()}`, stage: null, status: 'done' }) })
const inReview = (id: string, wave: number) => makeMilestone({ id, wave, state: 'dispatched', task: makeTask({ slug: `p-${id.toLowerCase()}`, stage: 'code-review' }) })
const queued = (id: string, wave: number, needs: string[] = []) => makeMilestone({ id, wave, needs })

const parent = (milestones: MilestoneStatus[]): Task => makeTask({ slug: 'p', milestones, stageHistory: PLAN_REVIEWED })

function renderPanel(task: Task, isCanonical = true) {
  const queryClient = new QueryClient()
  queryClient.setQueryData(SNAPSHOT_QUERY_KEY, { tasks: [task], isCanonical })
  return render(
    <QueryClientProvider client={queryClient}>
      <Suspense fallback={null}><WavePanel task={task} /></Suspense>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
})
afterEach(() => {
  vi.unstubAllGlobals()
  clientState.clearDispatchStatuses(['p-m1', 'p-m2'])
})

describe('WavePanel', () => {
  test('the header names the stage and where the waves stand, over the graph', async () => {
    renderPanel(parent([merged('M0', 1), queued('M1', 2, ['M0'])]))

    // The lazy graph suspends the whole panel until its chunk is in.
    expect(await screen.findByTestId('wave-graph-stub')).toBeInTheDocument()
    expect(screen.getByTestId('wave-panel-title')).toBeInTheDocument()
    expect(screen.getByTestId('wave-panel-meta')).toHaveTextContent('wave 2 of 2 · 1 of 2 merged')
  })

  test('Run next wave is enabled for a runnable wave and carries its number', async () => {
    renderPanel(parent([merged('M0', 1), queued('M1', 2, ['M0'])]))

    const button = await screen.findByTestId('run-next-wave-btn')
    expect(button).toBeEnabled()
    expect(button).toHaveAttribute('data-wave', '2')
  })

  test('clicking it stages the wave through /batch-dispatch', async () => {
    renderPanel(parent([merged('M0', 1), queued('M1', 2, ['M0'])]))

    await act(async () => { fireEvent.click(await screen.findByTestId('run-next-wave-btn')) })

    const [url, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/batch-dispatch$/)
    expect(JSON.parse(String(init.body))).toEqual({ kind: 'wave', slugs: ['p-m1'] })
  })

  test('an unfinished earlier wave disables it and names what it waits on', async () => {
    renderPanel(parent([inReview('M0', 1), queued('M1', 2, ['M0'])]))

    const button = await screen.findByTestId('run-next-wave-btn')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'Waiting on wave 1 · M0 in review')
  })

  test('a read-only dashboard disables it with the read-only reason', async () => {
    renderPanel(parent([merged('M0', 1), queued('M1', 2, ['M0'])]), false)

    const button = await screen.findByTestId('run-next-wave-btn')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', READ_ONLY_INSTANCE_TITLE)
  })

  test('every wave merged disables it', async () => {
    renderPanel(parent([merged('M0', 1), merged('M1', 2)]))

    const button = await screen.findByTestId('run-next-wave-btn')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'Every wave is merged')
  })

  test('a refused batch shows its outcome on the status line and leaves the button usable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 409 })))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    renderPanel(parent([merged('M0', 1), queued('M1', 2, ['M0'])]))

    await act(async () => { fireEvent.click(await screen.findByTestId('run-next-wave-btn')) })

    expect(await screen.findByTestId('run-next-wave-status')).toHaveAttribute('data-ok', 'false')
    expect(screen.getByTestId('run-next-wave-btn')).toBeEnabled()
  })

  test('an outcome recorded for a milestone outside the target wave is not shown as the wave\'s', async () => {
    clientState.setDispatchStatuses(['p-m2'], { ok: false, label: 'Refused', detail: undefined })
    renderPanel(parent([queued('M1', 1), queued('M2', 2, ['M1'])]))

    await screen.findByTestId('run-next-wave-btn')
    expect(screen.queryByTestId('run-next-wave-status')).toBeNull()
  })

  test('there is no status line before anything was run', async () => {
    renderPanel(parent([merged('M0', 1), queued('M1', 2, ['M0'])]))

    await screen.findByTestId('run-next-wave-btn')
    expect(screen.queryByTestId('run-next-wave-status')).toBeNull()
  })

  test('a parent with no milestones shows a note instead of a graph', () => {
    renderPanel(parent([]))

    expect(screen.getByTestId('wave-panel-empty-note')).toBeInTheDocument()
    expect(screen.queryByTestId('run-next-wave-btn')).toBeNull()
  })
})
