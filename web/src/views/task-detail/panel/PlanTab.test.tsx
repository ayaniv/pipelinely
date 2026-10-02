import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Task } from '../../../../../src/types'
import type { TechDesign } from '../../../data/taskResources'
import { PlanTab } from './PlanTab'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const task = (overrides: Partial<Task> = {}) => ({
  slug: 'my-task', title: 'My task', status: 'working', stage: null, stageHistory: [], waitingReason: undefined, findings: [], qaFailures: [], qaCases: [], ...overrides,
}) as unknown as Task

const DESIGN: TechDesign = { html: '<h1>The plan</h1><p>body</p>', summaryHtml: '<p>the <code>summary</code></p>', testGroups: [] }

let fetchStub: ReturnType<typeof vi.fn>

// One route table: /api/stage-scope always answers with no scopes, the
// tech-design route answers with whatever the test wants.
function stubBackend(techDesign: Response | Promise<Response>) {
  fetchStub = vi.fn((url: string) => {
    if (url.startsWith('/api/stage-scope')) return Promise.resolve(json(200, { stages: {} }))
    if (url.startsWith('/tech-design/')) return Promise.resolve(techDesign)
    return Promise.resolve(new Response(null, { status: 200 }))
  })
  vi.stubGlobal('fetch', fetchStub)
}

function renderPlanTab(props: { task?: Task; stage?: 'planning' | 'plan-review' } = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <PlanTab task={props.task ?? task()} stage={props.stage ?? 'planning'} />
    </QueryClientProvider>,
  )
}

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('PlanTab document body', () => {
  test('while loading, shows a loading note inside the body and disables Plannotator', () => {
    stubBackend(new Promise<Response>(() => {}))
    renderPlanTab()

    expect(within(screen.getByTestId('tech-design-body')).getByTestId('tech-design-loading')).toBeInTheDocument()
    expect(screen.getByTestId('plannotator-btn')).toBeDisabled()
  })

  test('once loaded, renders the server-rendered document and enables Plannotator', async () => {
    stubBackend(json(200, DESIGN))
    renderPlanTab()

    expect(await screen.findByRole('heading', { name: 'The plan' })).toBeInTheDocument()
    expect(screen.queryByTestId('tech-design-loading')).toBeNull()
    expect(screen.getByTestId('plannotator-btn')).toBeEnabled()
    expect(screen.getByTestId('plannotator-btn')).toHaveAttribute('title', expect.stringContaining('$TASKS_DIR/my-task/tech-design.md'))
  })

  test('a task with no tech-design.md says so, with no overview and Plannotator disabled', async () => {
    stubBackend(new Response(null, { status: 404 }))
    renderPlanTab()

    expect(await screen.findByTestId('tech-design-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('plan-summary')).toBeNull()
    expect(screen.getByTestId('plannotator-btn')).toBeDisabled()
    expect(screen.getByTestId('plannotator-btn')).toHaveAttribute('title', 'No tech-design.md yet')
  })

  test('a failed load reads the same as an absent plan, and is logged', async () => {
    stubBackend(new Response(null, { status: 500 }))
    renderPlanTab()

    expect(await screen.findByTestId('tech-design-empty')).toBeInTheDocument()
    expect(screen.getByTestId('plannotator-btn')).toBeDisabled()
    expect(console.error).toHaveBeenCalledWith('[tech-design] load for my-task failed', expect.any(Error))
  })

  test('shows the recorded round for this stage next to the file name', async () => {
    stubBackend(json(200, DESIGN))
    renderPlanTab({ task: task({ stageHistory: [{ stage: 'plan-review', at: '2026-08-10T10:00:00Z', note: 'ok' }, { stage: 'plan-review', at: '2026-08-11T10:00:00Z', note: 'ok' }] }), stage: 'plan-review' })

    expect(await screen.findByTestId('tech-design-source')).toHaveTextContent('tech-design.md · round 2')
  })
})

describe('PlanTab overview', () => {
  test('renders the summary, then the derived test list grouped by milestone', async () => {
    stubBackend(json(200, {
      ...DESIGN,
      testGroups: [
        { milestoneId: 'M0', name: 'Foundation', specFile: 'e2e/a.spec.ts', titles: ['does a'], missingSpecFiles: [], hasWorktree: true },
        { milestoneId: 'M1', name: 'Feature', specFile: 'e2e/b.spec.ts', titles: [], missingSpecFiles: ['e2e/b.spec.ts'], hasWorktree: true },
      ],
    }))
    renderPlanTab()

    expect(await screen.findByTestId('plan-summary-body')).toContainHTML('<code>summary</code>')
    const groups = screen.getAllByTestId('plan-tests-group')
    expect(groups).toHaveLength(2)
    expect(groups[0]).toHaveAttribute('data-plan-milestone-id', 'M0')
    expect(within(groups[0]).getByTestId('plan-tests-group-milestone')).toHaveTextContent('M0 — Foundation')
    expect(within(groups[0]).getByTestId('plan-tests-group-spec')).toHaveTextContent('e2e/a.spec.ts')
    expect(within(groups[0]).getAllByTestId('planned-qa-case-row')).toHaveLength(1)
    expect(within(groups[1]).getByTestId('plan-tests-missing-spec')).toHaveTextContent('e2e/b.spec.ts not found in the worktree')
  })

  test('a missing spec with no worktree on disk says that instead', async () => {
    stubBackend(json(200, { ...DESIGN, testGroups: [{ milestoneId: null, name: null, specFile: 'e2e/a.spec.ts', titles: [], missingSpecFiles: ['e2e/a.spec.ts'], hasWorktree: false }] }))
    renderPlanTab()

    expect(await screen.findByTestId('plan-tests-missing-spec')).toHaveTextContent('no worktree on disk to read it from')
    expect(screen.queryByTestId('plan-tests-group-milestone')).toBeNull()
  })

  test('a plan with no Summary section and no declared spec says both', async () => {
    stubBackend(json(200, { html: '<p>x</p>', summaryHtml: null, testGroups: [] }))
    renderPlanTab()

    expect(await screen.findByTestId('plan-summary-missing')).toBeInTheDocument()
    expect(screen.getByTestId('plan-tests-empty')).toBeInTheDocument()
  })
})

describe('PlanTab header and footer', () => {
  test('titles itself by the stage it was opened for', async () => {
    stubBackend(json(200, DESIGN))
    const { unmount } = renderPlanTab({ stage: 'planning' })
    expect(screen.getByTestId('l2-panel-title')).toHaveTextContent('Planning')
    unmount()
    renderPlanTab({ stage: 'plan-review' })
    expect(screen.getByTestId('l2-panel-title')).toHaveTextContent('Plan Review')
    await waitFor(() => expect(fetchStub).toHaveBeenCalled())
  })

  test('the Planning tab has no CTA of its own — there is no planning skill to start', async () => {
    stubBackend(json(200, DESIGN))
    renderPlanTab({ stage: 'planning' })
    await screen.findByRole('heading', { name: 'The plan' })
    expect(screen.queryByTestId('detail-panel-footer')).toBeNull()
  })

  test('Plan Review hosts "Start Plan Review", live only once the plan is waiting for review', async () => {
    stubBackend(json(200, DESIGN))
    const { unmount } = renderPlanTab({ stage: 'plan-review', task: task({ status: 'waiting', waitingReason: 'plan ready for review' }) })
    expect(screen.getByTestId('plan-review-cta')).toBeEnabled()
    unmount()

    renderPlanTab({ stage: 'plan-review', task: task({ status: 'waiting', waitingReason: 'plan reviewed, ready for dev' }) })
    expect(screen.getByTestId('plan-review-cta')).toBeDisabled()
    await waitFor(() => expect(fetchStub).toHaveBeenCalled())
  })
})

describe('PlanTab Plannotator', () => {
  test('POSTs to /annotate-plan and flashes the outcome on the button', async () => {
    stubBackend(json(200, DESIGN))
    renderPlanTab()
    await screen.findByRole('heading', { name: 'The plan' })

    fireEvent.click(screen.getByTestId('plannotator-btn'))

    await waitFor(() => expect(screen.getByTestId('plannotator-btn')).toHaveClass('btn-ok'))
    expect(fetchStub).toHaveBeenCalledWith('/annotate-plan/my-task', { method: 'POST' })
  })
})
