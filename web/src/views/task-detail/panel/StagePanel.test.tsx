import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Task } from '../../../../../src/types'
import { clientState } from '../../../data/clientState'
import { TaskDetailNavProvider, type TaskDetailNavApi } from '../detailNav'
import type { StagePanelTabId } from '../../../pipelineStages'
import { StagePanel, type StagePanelExtra } from './StagePanel'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function makeChild(overrides: Partial<Task> = {}): Task {
  return {
    slug: 'my-task', title: 'My task', status: 'working', stage: 'dev', stageHistory: [], waitingReason: undefined,
    verifier: null, worktree: null, devUrl: null, branch: 'claude/my-task', findings: [], findingsParseMismatch: [],
    qaFailures: [], qaCases: [], qaCasesParseMismatch: [], attentionStatus: 'working', ...overrides,
  } as unknown as Task
}

const waiting = (waitingReason: string, overrides: Partial<Task> = {}) => makeChild({ status: 'waiting', waitingReason, ...overrides })
const finding = (selected = false) => ({ severity: 'must' as const, category: 'correctness', description: 'Off by one', location: 'a.ts:1', selected })
const failure = (selected = false) => ({ label: 'Case 1', description: 'wrong', location: 'e2e/x:1', selected })
const FLAT_EXTRA: StagePanelExtra = { needs: null, stateLabel: 'Dispatched' }

let navApi: TaskDetailNavApi
let fetchStub: ReturnType<typeof vi.fn>

beforeEach(() => {
  navApi = { nav: { l1Tab: 'dev', l2Tab: null, milestoneId: null }, selectL1Tab: vi.fn(), selectStageTab: vi.fn(), selectMilestone: vi.fn(), leaveMilestone: vi.fn() }
  fetchStub = vi.fn((url: string) => {
    if (url.startsWith('/api/stage-scope')) return Promise.resolve(json(200, { stages: {} }))
    if (url.startsWith('/qa-spec/')) return Promise.resolve(json(200, { titles: ['planned one', 'planned two'] }))
    return Promise.resolve(json(200, {}))
  })
  vi.stubGlobal('fetch', fetchStub)
})

afterEach(() => {
  clientState.settleMerge('my-task', null)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function renderStage(tab: StagePanelTabId, child: Task | null, extra: StagePanelExtra = FLAT_EXTRA, openTaskSlug = 'my-task') {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TaskDetailNavProvider value={navApi}>
        <StagePanel tab={tab} child={child} extra={extra} openTaskSlug={openTaskSlug} />
      </TaskDetailNavProvider>
    </QueryClientProvider>,
  )
}

describe('Dev stage', () => {
  test('a flat task shows its dispatch state and only a verifier row — "needs" is milestone jargon', () => {
    renderStage('dev', makeChild({ verifier: 'npm test' }))

    expect(screen.getByTestId('milestone-dispatch-label')).toHaveTextContent('Dispatched')
    const rows = screen.getAllByTestId('milestone-dispatch-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('verifiernpm test')
  })

  test('a milestone shows its needs row too, in its own words for a root milestone', () => {
    const { unmount } = renderStage('dev', makeChild(), { needs: ['M0', 'M1'], stateLabel: 'Queued' })
    expect(screen.getAllByTestId('milestone-dispatch-row')[0]).toHaveTextContent('needsM0, M1')
    expect(screen.getAllByTestId('milestone-dispatch-row')[1]).toHaveTextContent('verifiernone declared')
    unmount()

    renderStage('dev', makeChild(), { needs: [], stateLabel: 'Queued' })
    expect(screen.getAllByTestId('milestone-dispatch-row')[0]).toHaveTextContent('nothing — this is a root milestone')
  })

  test('Start Dev is live for a task whose plan was just reviewed, and posts for that task', async () => {
    renderStage('dev', waiting('plan reviewed, ready for dev'))

    fireEvent.click(screen.getByTestId('l2-cta'))

    await waitFor(() => expect(fetchStub).toHaveBeenCalledWith('/stage-skill/my-task', expect.objectContaining({ body: JSON.stringify({ stage: 'dev', autoSubmit: false }) })))
  })

  test('Start Dev is disabled for an already-dispatched task with nothing to hand off', () => {
    renderStage('dev', makeChild())
    expect(screen.getByTestId('l2-cta')).toBeDisabled()
  })

  test('an undispatched milestone (no task) stages Start Dev against its milestone slug, live only when ready', async () => {
    const { unmount } = renderStage('dev', null, { needs: ['M0'], stateLabel: 'Queued', readyForDev: false, milestoneSlug: 'parent-m1' })
    expect(screen.getByTestId('l2-cta')).toBeDisabled()
    unmount()

    renderStage('dev', null, { needs: ['M0'], stateLabel: 'Queued', readyForDev: true, milestoneSlug: 'parent-m1' })
    fireEvent.click(screen.getByTestId('l2-cta'))
    await waitFor(() => expect(fetchStub).toHaveBeenCalledWith('/stage-skill/parent-m1', expect.anything()))
  })

  test('secondaries: Terminal always for a dispatched task, VS Code only with a worktree, Browse App only with a dev URL', () => {
    const { unmount } = renderStage('dev', makeChild())
    expect(screen.getByTestId('focus-btn')).toBeInTheDocument()
    expect(screen.queryByTestId('vscode-btn')).toBeNull()
    expect(screen.queryByTestId('browse-btn')).toBeNull()
    unmount()

    renderStage('dev', makeChild({ worktree: '/wt', devUrl: 'http://localhost:1' }))
    expect(screen.getByTestId('vscode-btn')).toBeInTheDocument()
    expect(screen.getByTestId('browse-btn')).toBeInTheDocument()
  })

  test('an undispatched milestone has no secondaries at all', () => {
    renderStage('dev', null, { needs: [], stateLabel: 'Queued', milestoneSlug: 'p-m0' })
    expect(screen.queryByTestId('focus-btn')).toBeNull()
  })
})

describe('CR stage', () => {
  test('an undispatched milestone says so, with nothing to act on — no footer', () => {
    renderStage('cr', null)
    expect(screen.getByTestId('not-dispatched-note')).toBeInTheDocument()
    expect(screen.queryByTestId('detail-panel-footer')).toBeNull()
  })

  test('lists the findings read-only, with a button through to the triage tab', () => {
    renderStage('cr', makeChild({ findings: [finding()] }))

    expect(screen.getAllByTestId('finding-row')).toHaveLength(1)
    expect(screen.queryByTestId('triage-checkbox')).toBeNull()

    fireEvent.click(screen.getByTestId('select-findings-btn'))
    expect(navApi.selectStageTab).toHaveBeenCalledWith('cr-fixes')
  })

  test('with no findings, says code review either has not run or found nothing, and offers no triage button', () => {
    renderStage('cr', makeChild())
    expect(screen.getByTestId('cr-no-findings-note')).toBeInTheDocument()
    expect(screen.queryByTestId('select-findings-btn')).toBeNull()
  })

  test('Start Code Review is live when the PR is open and waiting for CR', () => {
    renderStage('cr', waiting('PR open, ready for CR'))
    expect(screen.getByTestId('l2-cta')).toBeEnabled()
    expect(screen.getByTestId('l2-cta')).toHaveTextContent('Start Code Review')
  })

  test('Open PR appears only once a PR number resolves', () => {
    const { unmount } = renderStage('cr', makeChild())
    expect(screen.queryByTestId('open-pr-btn')).toBeNull()
    unmount()
    renderStage('cr', makeChild({ prNumber: '904' } as Partial<Task>))
    expect(screen.getByTestId('open-pr-btn')).toBeInTheDocument()
  })

  test('surfaces a findings parse mismatch instead of silently dropping bullets', () => {
    renderStage('cr', makeChild({ findingsParseMismatch: ['Must Fix declared 3, parsed 2'] }))
    expect(screen.getByTestId('cr-parse-mismatch-warning')).toHaveTextContent('Bullet parse mismatch — Must Fix declared 3, parsed 2')
  })
})

describe('CR-fixes stage', () => {
  test('the triage checklist reflects the persisted selection, and the Fix CTA counts it', () => {
    renderStage('cr-fixes', waiting('triage and dispatch cr-fixes', { findings: [finding(true), finding(false), finding(true)] }))

    expect(screen.getByTestId('triage-checklist')).toHaveAttribute('data-endpoint', 'triage')
    expect(screen.getByTestId('checklist-selected-count')).toHaveTextContent('2')
    expect(screen.getByTestId('l2-cta')).toHaveTextContent('Fix 2 CR Comments')
    expect(screen.getByTestId('l2-cta')).toBeEnabled()
    expect(screen.getByTestId('skip-cta')).toBeEnabled()
  })

  test('the CTA is singular for one, and disabled — with Skip still live — for none', () => {
    const { unmount } = renderStage('cr-fixes', waiting('triage and dispatch cr-fixes', { findings: [finding(true)] }))
    expect(screen.getByTestId('l2-cta')).toHaveTextContent('Fix 1 CR Comment')
    expect(screen.getByTestId('l2-cta')).not.toHaveTextContent('Comments')
    unmount()

    renderStage('cr-fixes', waiting('triage and dispatch cr-fixes', { findings: [finding(false)] }))
    expect(screen.getByTestId('l2-cta')).toBeDisabled()
    expect(screen.getByTestId('skip-cta')).toBeEnabled()
  })

  test('nothing is live while the task is not waiting on cr-fixes', () => {
    renderStage('cr-fixes', makeChild({ findings: [finding(true)] }))
    expect(screen.getByTestId('l2-cta')).toBeDisabled()
    expect(screen.getByTestId('skip-cta')).toBeDisabled()
  })

  test('ticking a box updates the count and the CTA at once and persists to /triage', async () => {
    renderStage('cr-fixes', waiting('triage and dispatch cr-fixes', { findings: [finding(false), finding(false)] }))
    expect(screen.getByTestId('l2-cta')).toBeDisabled()

    fireEvent.click(screen.getAllByTestId('triage-checkbox')[1])

    expect(screen.getByTestId('checklist-selected-count')).toHaveTextContent('1')
    expect(screen.getByTestId('l2-cta')).toBeEnabled()
    await waitFor(() => expect(fetchStub).toHaveBeenCalledWith('/triage/my-task', expect.objectContaining({ body: JSON.stringify({ selected: [1] }) })))
  })

  test('moving to another milestone mid-POST never shows the first milestone\'s optimistic selection', async () => {
    fetchStub.mockImplementation((url: string) => (url.startsWith('/triage/') ? new Promise(() => {}) : Promise.resolve(json(200, { stages: {} }))))
    const cr = (slug: string) => waiting('triage and dispatch cr-fixes', { slug, findings: [finding(false), finding(false)] })
    const { rerender } = renderStage('cr-fixes', cr('parent-m0'))

    fireEvent.click(screen.getAllByTestId('triage-checkbox')[0])
    expect(screen.getByTestId('checklist-selected-count')).toHaveTextContent('1')

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <StagePanel tab="cr-fixes" child={cr('parent-m1')} extra={FLAT_EXTRA} openTaskSlug="parent" />
      </QueryClientProvider>,
    )

    expect(screen.getByTestId('checklist-selected-count')).toHaveTextContent('0')
    expect(screen.getByTestId('l2-cta')).toBeDisabled()
  })

  test('with no findings, says none are recorded yet and shows no checklist', () => {
    renderStage('cr-fixes', waiting('triage and dispatch cr-fixes'))
    expect(screen.getByTestId('cr-fixes-no-findings-note')).toBeInTheDocument()
    expect(screen.queryByTestId('triage-checklist')).toBeNull()
  })

  test('an undispatched milestone says so', () => {
    renderStage('cr-fixes', null)
    expect(screen.getByTestId('not-dispatched-note')).toBeInTheDocument()
  })
})

describe('QA stage', () => {
  test('lists the recorded cases, with the parse-mismatch warning above when the counts disagree', () => {
    renderStage('qa', makeChild({ qaCases: [{ label: 'C1', description: 'd', location: 'l', passed: true }], qaCasesParseMismatch: ['declared 2, parsed 1'] }))

    expect(screen.getAllByTestId('qa-case-row')).toHaveLength(1)
    expect(screen.getByTestId('qa-parse-mismatch-warning')).toBeInTheDocument()
    expect(screen.queryByTestId('planned-qa-case-list')).toBeNull()
  })

  test('with no report yet, previews the planned cases from the declared spec (fetched only now)', async () => {
    renderStage('qa', makeChild({ qaSpecFile: 'e2e/x.spec.ts' } as Partial<Task>))

    expect(await screen.findByTestId('planned-qa-case-list')).toBeInTheDocument()
    expect(screen.getAllByTestId('planned-qa-case-row')).toHaveLength(2)
    expect(fetchStub).toHaveBeenCalledWith('/qa-spec/my-task', expect.anything())
  })

  test('never fetches the preview once real results exist, or when no spec is declared', async () => {
    const { unmount } = renderStage('qa', makeChild({ qaSpecFile: 'e2e/x.spec.ts', qaCases: [{ label: 'C', description: 'd', location: 'l', passed: true }] } as Partial<Task>))
    unmount()
    renderStage('qa', makeChild())
    await waitFor(() => expect(fetchStub).toHaveBeenCalledWith('/api/stage-scope', expect.anything()))

    expect(fetchStub).not.toHaveBeenCalledWith(expect.stringContaining('/qa-spec/'), expect.anything())
  })

  test('with neither, says the case list arrives with the QA skill', () => {
    renderStage('qa', makeChild())
    expect(screen.getByTestId('qa-cases-pending-note')).toHaveClass('detail-row-note', 'sess-note')
  })

  test('Start QA is live once CR is approved, and a milestone with no task says not dispatched', () => {
    const { unmount } = renderStage('qa', waiting('CR approved, ready for QA'))
    expect(screen.getByTestId('l2-cta')).toBeEnabled()
    unmount()
    renderStage('qa', null)
    expect(screen.getByTestId('not-dispatched-note')).toBeInTheDocument()
    expect(screen.queryByTestId('l2-cta')).toBeNull()
  })
})

describe('QA-fixes stage', () => {
  test('the failing cases are a triage checklist on /qa-triage, and Fix counts the selection', async () => {
    renderStage('qa-fixes', waiting('triage and dispatch qa-fixes', { qaFailures: [failure(true), failure(true)] }))

    expect(screen.getByTestId('triage-checklist')).toHaveAttribute('data-endpoint', 'qa-triage')
    expect(screen.getByTestId('l2-cta')).toHaveTextContent('Fix 2 QA Comments')

    fireEvent.click(screen.getAllByTestId('triage-checkbox')[0])
    await waitFor(() => expect(fetchStub).toHaveBeenCalledWith('/qa-triage/my-task', expect.objectContaining({ body: JSON.stringify({ selected: [1] }) })))
    expect(screen.getByTestId('l2-cta')).toHaveTextContent('Fix 1 QA Comment')
  })

  test('with no failing cases, says QA either has not run or found nothing', () => {
    renderStage('qa-fixes', waiting('triage and dispatch qa-fixes'))
    expect(screen.getByTestId('qa-fixes-no-failures-note')).toBeInTheDocument()
  })
})

describe('Merge stage', () => {
  const merged = (overrides: Partial<Task> = {}) => makeChild({ stageHistory: [{ stage: 'merge', at: '2026-08-10T10:00:00Z', note: 'ok' }], ...overrides })
  const withPr = { stageHistory: [{ stage: 'merge', at: '2026-08-10T10:00:00Z', note: 'ok' }, { stage: 'dev', at: '2026-08-09T10:00:00Z', note: 'PR #904 opened: x' }], prNumber: '904' } as Partial<Task>

  test('with a PR, Merge is the primary and Open PR / Mark done are secondaries', () => {
    renderStage('merge', makeChild(withPr))

    const footer = screen.getByTestId('detail-panel-footer')
    expect(within(footer).getByTestId('merge-pr-btn')).toBeInTheDocument()
    expect(within(footer).getByTestId('open-pr-btn')).toBeInTheDocument()
    expect(within(footer).getByTestId('mark-done-btn').querySelector('svg')).toBeNull()
  })

  test('with no PR to merge, Mark done is the primary (with the arrow) and there is no Merge or Open PR', () => {
    renderStage('merge', merged())

    expect(screen.queryByTestId('merge-pr-btn')).toBeNull()
    expect(screen.queryByTestId('open-pr-btn')).toBeNull()
    expect(screen.getByTestId('mark-done-btn').querySelector('svg')).not.toBeNull()
  })

  test('shows the empty-stage panel until the merge stage has recorded something', () => {
    const { unmount } = renderStage('merge', makeChild())
    expect(screen.getByTestId('milestone-stage-empty')).toBeInTheDocument()
    unmount()
    renderStage('merge', merged())
    expect(screen.queryByTestId('milestone-stage-empty')).toBeNull()
  })

  test('shows the merge failure banner, one line per reason, with its tone', () => {
    clientState.beginMerge('my-task')
    clientState.settleMerge('my-task', { tone: 'error', lines: ['check "ci" failing', 'branch behind main'] })
    renderStage('merge', makeChild(withPr))

    const banner = screen.getByTestId('merge-banner')
    expect(banner).toHaveAttribute('data-tone', 'error')
    expect(within(banner).getAllByTestId('merge-banner-line').map((li) => li.textContent)).toEqual(['check "ci" failing', 'branch behind main'])
  })

  test('no banner element at all when there is nothing to report', () => {
    renderStage('merge', makeChild(withPr))
    expect(screen.queryByTestId('merge-banner')).toBeNull()
  })

  test('an undispatched milestone says so', () => {
    renderStage('merge', null)
    expect(screen.getByTestId('not-dispatched-note')).toBeInTheDocument()
  })
})
