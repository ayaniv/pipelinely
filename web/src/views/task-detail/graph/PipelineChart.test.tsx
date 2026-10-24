import '../../../testing/flowJsdomShims'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { MilestoneStatus, StageEvent, Stage } from '../../../../../src/types'
import { makeMilestone, makeTask } from '../../../testing/makeTask'
import { PipelineChart } from './PipelineChart'
import { parentStageChainModel } from './parentStageModel'

// dashboard-v4-inner-view M1. The chart's viewport is applied by hand through
// the React Flow instance (never a `key` or fitView), so what these pin is
// when it is re-applied and what happens when React Flow rejects it. jsdom
// has no pan/zoom engine, so the instance is a spy and the engine is "ready".
const { setViewport, containerWidth } = vi.hoisted(() => ({ setViewport: vi.fn(), containerWidth: { current: 0 } }))

vi.mock('@xyflow/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xyflow/react')>()),
  useReactFlow: () => ({ setViewport }),
  useStore: () => true,
}))
vi.mock('./useElementWidth', async () => {
  const { createRef } = await import('react')
  return { useElementWidth: () => [createRef(), containerWidth.current] }
})

const PLANNED: StageEvent[] = [
  { stage: 'planning', at: '2026-08-10T09:00:00Z', note: 'done' },
  { stage: 'plan-review', at: '2026-08-10T10:00:00Z', note: 'looks good' },
]

const dispatched = (id: string, stage: Stage): MilestoneStatus =>
  makeMilestone({ id, wave: 1, state: 'dispatched', task: makeTask({ slug: `p-${id.toLowerCase()}`, stage, status: 'working' }) })

function modelFor(milestones: MilestoneStatus[]) {
  const parent = makeTask({ slug: 'p', stage: 'dev', status: 'waiting', stageHistory: PLANNED, milestones })
  return parentStageChainModel(parent, 'dev')
}

// One stable function: the chart re-applies its viewport when `log` changes.
const silentLog = vi.fn()
const inDev = [dispatched('M0', 'dev')]
const inReview = [dispatched('M0', 'code-review')]

function chart(milestones: MilestoneStatus[], log = silentLog) {
  return <PipelineChart model={modelFor(milestones)} reworkMilestoneIds={[]} onSelect={vi.fn()} log={log} />
}

beforeEach(() => {
  setViewport.mockReset()
  setViewport.mockResolvedValue(true)
  containerWidth.current = 600
})

describe('PipelineChart viewport', () => {
  test('applies the computed viewport once the chart is measured', () => {
    render(chart(inDev))
    expect(setViewport).toHaveBeenCalledTimes(1)
  })

  test('moves the viewport when the current stage advances in a chart wider than its box', () => {
    const { rerender } = render(chart(inDev))
    const [{ x: devX }] = setViewport.mock.calls[0]

    rerender(chart(inReview))

    expect(setViewport).toHaveBeenCalledTimes(2)
    expect(setViewport.mock.calls[1][0].x).not.toBe(devX)
  })

  test('a live snapshot that changes nothing about the chart leaves the viewport where the user panned it', () => {
    const { rerender } = render(chart(inDev))
    rerender(chart([dispatched('M0', 'dev')]))
    expect(setViewport).toHaveBeenCalledTimes(1)
  })

  test('logs, rather than swallows, a viewport React Flow rejects', async () => {
    const failure = new Error('no pan/zoom engine')
    setViewport.mockRejectedValue(failure)
    const log = vi.fn()

    render(chart(inDev, log))

    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('[pipeline-chart] could not apply the viewport', failure))
  })
})
