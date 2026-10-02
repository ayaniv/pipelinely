import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { MilestoneStatus, Task } from '../../../../src/types'
import { createClientState, type ClientState } from '../../data/clientState'
import { makeMilestone, makeTask } from '../../testing/makeTask'
import { MilestoneCard } from './MilestoneCard'

const PLAN_REVIEWED = [{ stage: 'plan-review' as const, at: '2026-01-01T00:00:00Z', note: '' }]
const parent = (milestones: MilestoneStatus[], stageHistory: Task['stageHistory'] = PLAN_REVIEWED) => makeTask({ slug: 'proj', milestones, stageHistory })
const child = (overrides: Partial<Task> = {}) => makeTask({ slug: 'proj-m0', status: 'working', stage: 'dev', contextPct: 30, ...overrides })

let state: ClientState
let onSelect: Mock<(milestoneId: string) => void>
let fetchStub: ReturnType<typeof vi.fn>

beforeEach(() => {
  state = createClientState()
  onSelect = vi.fn<(milestoneId: string) => void>()
  fetchStub = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetchStub)
})
afterEach(() => vi.unstubAllGlobals())

function renderCard(milestone: MilestoneStatus, parentTask = parent([milestone]), isAutoSubmitEnabled = () => false) {
  return render(<MilestoneCard milestone={milestone} parent={parentTask} onSelect={onSelect} isAutoSubmitEnabled={isAutoSubmitEnabled} clientState={state} />)
}

describe('a queued milestone (no child yet)', () => {
  const queued = makeMilestone({ id: 'M0', name: 'Do it', estimate: '4h', needs: ['M9'] })

  test('shows its id, name, needs and estimate, and no stats row', () => {
    renderCard(queued)

    expect(screen.getByTestId('milestone-id')).toHaveTextContent('M0')
    expect(screen.getByTestId('milestone-card')).toHaveAttribute('data-milestone-id', 'M0')
    expect(screen.getByTestId('milestone-est-actual')).toHaveTextContent('est 4h')
    expect(screen.getByTestId('milestone-card').querySelector('.card-ctx-row')).toBeNull()
    expect(screen.queryByTestId('focus-btn')).toBeNull()
  })

  test('says "no estimate" rather than a blank when none was declared', () => {
    renderCard(makeMilestone({ id: 'M0' }))
    expect(screen.getByTestId('milestone-est-actual')).toHaveTextContent('no estimate')
  })

  test('its Start dev is live when the plan was reviewed and its needs are done, and posts stage dev for the child slug', async () => {
    const ready = makeMilestone({ id: 'M0' })
    renderCard(ready, parent([ready]), () => true)

    fireEvent.click(screen.getByTestId('milestone-start-dev-btn'))

    await waitFor(() => expect(fetchStub).toHaveBeenCalled())
    expect(fetchStub).toHaveBeenCalledWith('/stage-skill/proj-m0', expect.objectContaining({ body: JSON.stringify({ stage: 'dev', autoSubmit: true }) }))
  })

  test('its Start dev is disabled until the plan has been reviewed, and then never posts', () => {
    const blocked = makeMilestone({ id: 'M0' })
    renderCard(blocked, parent([blocked], []))

    expect(screen.getByTestId('milestone-start-dev-btn')).toBeDisabled()
    fireEvent.click(screen.getByTestId('milestone-start-dev-btn'))
    expect(fetchStub).not.toHaveBeenCalled()
  })

  test('its Start dev is disabled while a need is not merged', () => {
    const blocker = makeMilestone({ id: 'M9' })
    const waiting = makeMilestone({ id: 'M0', needs: ['M9'] })
    renderCard(waiting, parent([waiting, blocker]))
    expect(screen.getByTestId('milestone-start-dev-btn')).toBeDisabled()
  })

  test('a failed Start dev flashes the failure on the button', async () => {
    fetchStub.mockResolvedValue(new Response('{}', { status: 500 }))
    const ready = makeMilestone({ id: 'M0' })
    renderCard(ready)

    fireEvent.click(screen.getByTestId('milestone-start-dev-btn'))

    await waitFor(() => expect(screen.getByTestId('milestone-start-dev-btn')).toHaveClass('btn-err'))
  })
})

describe('a dispatched milestone', () => {
  const dispatched = () => makeMilestone({ id: 'M0', state: 'dispatched', task: child() })

  test('shows its child\'s slug, stats and terminal/menu controls, and the child\'s own footer CTA', () => {
    renderCard(dispatched())

    expect(screen.getByTestId('milestone-card')).toHaveTextContent('proj-m0')
    expect(screen.getByTestId('card-tok-label')).toBeInTheDocument()
    expect(screen.getByTestId('card-cost')).toBeInTheDocument()
    expect(screen.getByTestId('focus-btn')).toBeInTheDocument()
    expect(screen.getByTestId('card-menu-btn')).toBeInTheDocument()
    expect(screen.getByTestId('card-cta-btn')).toBeInTheDocument()
    expect(screen.queryByTestId('milestone-start-dev-btn')).toBeNull()
  })

  test('offers the handover pill only when ctx is hot', () => {
    const { unmount } = renderCard(makeMilestone({ id: 'M0', state: 'dispatched', task: child({ contextPct: 85 }) }))
    expect(screen.getByTestId('ms-card-handover')).toBeInTheDocument()
    unmount()

    renderCard(dispatched())
    expect(screen.queryByTestId('ms-card-handover')).toBeNull()
  })

  test('shows the wave dispatch status from the shared state, tinted by outcome, with the server detail as its title', () => {
    state.setDispatchStatuses(['proj-m0'], { ok: false, label: 'no orchestrator', detail: 'tab is gone' })
    renderCard(dispatched())

    const status = screen.getByTestId('ms-dispatch-status')
    expect(status).toHaveTextContent('no orchestrator')
    expect(status).toHaveClass('btn-err')
    expect(status).toHaveAttribute('title', 'tab is gone')
  })

  test('a successful dispatch reads as ok; with none recorded the status is empty', () => {
    const { unmount } = renderCard(dispatched())
    expect(screen.getByTestId('ms-dispatch-status')).toBeEmptyDOMElement()
    unmount()

    state.setDispatchStatuses(['proj-m0'], { ok: true, label: 'staged', detail: undefined })
    renderCard(dispatched())
    expect(screen.getByTestId('ms-dispatch-status')).toHaveClass('btn-ok')
  })
})

describe('a merged milestone', () => {
  test('reads merged, shows the time it took, and has no footer and no handover', () => {
    const merged = child({ status: 'done', stage: null, contextPct: 90, completedAt: '2026-01-01T02:30:00Z', stageHistory: [{ stage: 'dev', at: '2026-01-01T00:00:00Z', note: '' }] })
    renderCard(makeMilestone({ id: 'M0', state: 'done', estimate: '2h', task: merged }))

    expect(screen.getByTestId('milestone-est-actual')).toHaveTextContent('est 2h · took 2h30m')
    expect(screen.getByTestId('milestone-card').querySelector('.card-footer')).toBeNull()
    expect(screen.queryByTestId('ms-card-handover')).toBeNull()
  })
})

describe('selecting the milestone', () => {
  const dispatched = () => makeMilestone({ id: 'M0', state: 'dispatched', task: child() })

  test('a click on the card selects it', () => {
    renderCard(dispatched())
    fireEvent.click(screen.getByTestId('milestone-card'))
    expect(onSelect).toHaveBeenCalledWith('M0')
  })

  test.each(['Enter', ' '])('the %j key on the card itself selects it, so keyboard users can open it', (key) => {
    renderCard(dispatched())
    fireEvent.keyDown(screen.getByTestId('milestone-card'), { key })
    expect(onSelect).toHaveBeenCalledWith('M0')
  })

  test('other keys do nothing', () => {
    renderCard(dispatched())
    fireEvent.keyDown(screen.getByTestId('milestone-card'), { key: 'a' })
    expect(onSelect).not.toHaveBeenCalled()
  })

  test('a click on an inner control is that control\'s own, never "open this milestone"', () => {
    renderCard(dispatched())
    fireEvent.click(screen.getByTestId('focus-btn'))
    fireEvent.click(screen.getByTestId('card-menu-btn'))
    fireEvent.click(within(screen.getByTestId('card-menu')).getByTestId('card-menu-toggle-off-focus'))
    expect(onSelect).not.toHaveBeenCalled()
  })

  test('Enter on an inner control does not hijack it into selecting the milestone', () => {
    renderCard(dispatched())
    fireEvent.keyDown(screen.getByTestId('focus-btn'), { key: 'Enter' })
    expect(onSelect).not.toHaveBeenCalled()
  })

  test('the card menu\'s off-focus toggle writes the shared state', () => {
    renderCard(dispatched())
    fireEvent.click(screen.getByTestId('card-menu-btn'))
    fireEvent.click(screen.getByTestId('card-menu-toggle-off-focus'))
    expect(state.isOffFocus('proj-m0')).toBe(true)
  })
})
