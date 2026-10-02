import '../../../testing/flowJsdomShims'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { StageEvent, Task } from '../../../../../src/types'
import type { ChainStageId } from '../../../pipelineStages'
import { makeTask } from '../../../testing/makeTask'
import { TaskDetailNavProvider, type TaskDetailNavApi } from '../detailNav'
import { StageChainGraph, type StageChainGraphProps } from './StageChainGraph'

const event = (stageValue: string): StageEvent => ({ stage: stageValue as StageEvent['stage'], at: '2026-01-01T00:00:00Z', note: null })

let navApi: TaskDetailNavApi

function renderChain(props: StageChainGraphProps, l2Tab: ChainStageId | null = null) {
  navApi = { nav: { l1Tab: 'dev', l2Tab, milestoneId: null }, selectL1Tab: vi.fn(), selectStageTab: vi.fn(), selectMilestone: vi.fn(), leaveMilestone: vi.fn() }
  return render(<TaskDetailNavProvider value={navApi}><StageChainGraph {...props} /></TaskDetailNavProvider>)
}

const flatTask = (overrides: Partial<Task> = {}) => makeTask({ stageHistory: [event('planning'), event('dev')], ...overrides })

beforeEach(() => { navApi = undefined as never })

describe('StageChainGraph', () => {
  test('renders one node button per visible stage of the flat chain, the selected one marked current', () => {
    renderChain({ child: flatTask(), stages: 'flat' }, 'cr')

    for (const id of ['planning', 'dev', 'cr', 'qa', 'merge']) expect(screen.getByTestId(`stage-chain-${id}`)).toBeInTheDocument()
    expect(screen.queryByTestId('stage-chain-plan-review')).toBeNull()
    expect(screen.getByTestId('stage-chain-cr')).toHaveAttribute('aria-current', 'step')
    expect(screen.getByTestId('stage-chain-dev')).toHaveAttribute('aria-current', 'false')
  })

  test('with nothing selected the chain highlights the task\'s default stage', () => {
    renderChain({ child: flatTask(), stages: 'flat' })
    expect(screen.getByTestId('stage-chain-dev')).toHaveAttribute('aria-current', 'step')
  })

  test('clicking a node selects that node\'s stage through the detail nav', () => {
    renderChain({ child: flatTask(), stages: 'flat' }, 'dev')

    fireEvent.click(screen.getByTestId('stage-chain-qa'))

    expect(navApi.selectStageTab).toHaveBeenCalledWith('qa')
  })

  test('a grouped node routes to the folded stage that is in play (Planning → Plan Review)', () => {
    renderChain({ child: flatTask({ stage: 'plan-review' }), stages: 'flat' }, 'plan-review')

    expect(screen.getByTestId('stage-chain-planning')).toHaveAttribute('aria-current', 'step')
    fireEvent.click(screen.getByTestId('stage-chain-planning'))
    expect(navApi.selectStageTab).toHaveBeenCalledWith('plan-review')
  })

  test('the compact stepper names the selected stage and disables prev at the start', () => {
    renderChain({ child: makeTask({ stageHistory: [event('dev')] }), stages: 'milestone' }, 'dev')

    expect(screen.getByTestId('stepper-position')).toHaveTextContent('1/4')
    expect(screen.getByTestId('stepper-prev')).toBeDisabled()
    expect(screen.getByTestId('stepper-next')).toBeEnabled()
  })

  test('the compact prev/next select the neighbouring stage', () => {
    renderChain({ child: makeTask({ stageHistory: [event('dev')] }), stages: 'milestone' }, 'cr')

    fireEvent.click(screen.getByTestId('stepper-next'))
    fireEvent.click(screen.getByTestId('stepper-prev'))

    expect(navApi.selectStageTab).toHaveBeenNthCalledWith(1, 'qa')
    expect(navApi.selectStageTab).toHaveBeenNthCalledWith(2, 'dev')
  })

  test('the compact next is disabled and inert at the last stage', () => {
    renderChain({ child: makeTask({ stageHistory: [event('dev')] }), stages: 'milestone' }, 'merge')

    expect(screen.getByTestId('stepper-next')).toBeDisabled()
    fireEvent.click(screen.getByTestId('stepper-next'))
    expect(navApi.selectStageTab).not.toHaveBeenCalled()
  })

  test('the milestone rail adds the state word to every node; the flat one does not', () => {
    const { unmount } = renderChain({ child: makeTask(), stages: 'milestone' })
    expect(screen.getAllByTestId('stage-node-data')).toHaveLength(4)
    expect(screen.getByTestId('stepper-wide')).toHaveClass('is-milestone')
    unmount()

    renderChain({ child: makeTask(), stages: 'flat' })
    expect(screen.queryByTestId('stage-node-data')).not.toBeInTheDocument()
  })

  test('an undispatched milestone (no child) draws every node pending and no gap note', () => {
    renderChain({ child: null, stages: 'milestone' })

    expect(screen.getByTestId('stage-chain-dev')).toHaveClass('is-pending')
    expect(screen.queryByTestId('stage-chain-no-data')).not.toBeInTheDocument()
  })

  test('a task with no TIMELINE explains the gap', () => {
    renderChain({ child: makeTask({ stageHistory: [] }), stages: 'flat' })
    expect(screen.getByTestId('stage-chain-no-data')).toBeInTheDocument()
  })

  test('arrow keys move focus along the chain without clicking', () => {
    renderChain({ child: flatTask(), stages: 'flat' })
    const cr = screen.getByTestId('stage-chain-cr')
    cr.focus()

    fireEvent.keyDown(cr, { key: 'ArrowRight' })
    expect(screen.getByTestId('stage-chain-qa')).toHaveFocus()
    fireEvent.keyDown(screen.getByTestId('stage-chain-qa'), { key: 'ArrowLeft' })
    expect(cr).toHaveFocus()
    expect(navApi.selectStageTab).not.toHaveBeenCalled()
  })

  test('in an RTL document ArrowLeft is the next stage', () => {
    document.documentElement.dir = 'rtl'
    try {
      renderChain({ child: flatTask(), stages: 'flat' })
      const cr = screen.getByTestId('stage-chain-cr')
      cr.focus()

      fireEvent.keyDown(cr, { key: 'ArrowLeft' })
      expect(screen.getByTestId('stage-chain-qa')).toHaveFocus()
    } finally {
      document.documentElement.dir = ''
    }
  })

  test('fails loudly outside a task detail rather than drawing an unselectable chain', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<StageChainGraph child={makeTask()} stages="flat" />)).toThrow(/TaskDetailNavProvider/)
  })
})
