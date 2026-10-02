import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { MilestoneStatus } from '../../../../src/types'
import { createClientState, type ClientState } from '../../data/clientState'
import { makeMilestone, makeTask } from '../../testing/makeTask'
import { MilestoneDetailHead } from './MilestoneDetailHead'

let state: ClientState
let onBack: Mock<() => void>

beforeEach(() => {
  state = createClientState()
  onBack = vi.fn<() => void>()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })))
})
afterEach(() => vi.unstubAllGlobals())

const parent = makeTask({ slug: 'proj', title: 'Big project' })
const renderHead = (milestone: MilestoneStatus) => render(<MilestoneDetailHead parent={parent} milestone={milestone} onBackToMilestones={onBack} clientState={state} />)

describe('MilestoneDetailHead', () => {
  test('the parent link names the parent task and steps back to the milestone list', () => {
    renderHead(makeMilestone({ id: 'M1', name: 'Wire it' }))

    const link = screen.getByTestId('milestone-parent-link')
    expect(link).toHaveAttribute('aria-label', 'Back to Big project')
    fireEvent.click(link)
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  test('an undispatched milestone shows its id, name and "not dispatched", with no actions', () => {
    renderHead(makeMilestone({ id: 'M1', name: 'Wire it' }))

    expect(screen.getByTestId('milestone-detail-id')).toHaveTextContent('M1')
    expect(screen.getByTestId('milestone-title')).toHaveTextContent('Wire it')
    expect(screen.getByTestId('milestone-detail-head')).toHaveTextContent('not dispatched')
    expect(screen.queryByTestId('focus-btn')).toBeNull()
    expect(screen.queryByTestId('card-menu-btn')).toBeNull()
    expect(screen.getByTestId('milestone-meta')).toBeEmptyDOMElement()
  })

  test('a dispatched milestone shows its child\'s slug, ctx, meta and actions', () => {
    const child = makeTask({ slug: 'proj-m1', contextPct: 25, status: 'working' })
    renderHead(makeMilestone({ id: 'M1', state: 'dispatched', task: child }))

    expect(screen.getByTestId('milestone-detail-head')).toHaveTextContent('proj-m1')
    expect(screen.getByTestId('milestone-ctx-value')).toHaveTextContent('25%')
    expect(screen.getByTestId('milestone-meta')).not.toBeEmptyDOMElement()
    expect(screen.getByTestId('focus-btn')).toBeInTheDocument()
    expect(screen.getByTestId('card-menu-btn')).toBeInTheDocument()
    expect(screen.queryByTestId('milestone-handover')).toBeNull()
  })

  test('offers the handover pill on a hot ctx while the child is not done', () => {
    renderHead(makeMilestone({ id: 'M1', state: 'dispatched', task: makeTask({ slug: 'proj-m1', contextPct: 85 }) }))
    expect(screen.getByTestId('milestone-handover')).toBeInTheDocument()
  })

  test('offers no handover once the child is done, however hot its last ctx was', () => {
    renderHead(makeMilestone({ id: 'M1', state: 'done', task: makeTask({ slug: 'proj-m1', contextPct: 85, status: 'done' }) }))
    expect(screen.queryByTestId('milestone-handover')).toBeNull()
  })

  test('the pill carries the status label of the milestone\'s state', () => {
    renderHead(makeMilestone({ id: 'M1', state: 'done' }))
    expect(screen.getByTestId('milestone-status-pill')).toHaveTextContent('merged')
  })
})
