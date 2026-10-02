import { afterEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { Task } from '../../../../../src/types'
import { NotDispatchedNote, PanelBody, PanelFooter, PanelHeader } from './PanelLayout'

afterEach(() => vi.unstubAllGlobals())

function withClient(node: ReactNode) {
  return <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>
}

function stubStageScope(response: Response) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
}

const scopeResponse = (stages: unknown) => new Response(JSON.stringify({ stages }), { status: 200 })
const child = (overrides: Partial<Task> = {}) => ({ slug: 't', status: 'working', stage: null, stageHistory: [], findings: [], qaFailures: [], qaCases: [], ...overrides }) as unknown as Task

describe('PanelHeader', () => {
  test('shows the stage label as the title and a status pill', () => {
    stubStageScope(scopeResponse({}))
    render(withClient(<PanelHeader stageId="cr-fixes" child={child()} />))

    expect(screen.getByTestId('l2-panel-title')).toHaveTextContent('CR fixes')
    expect(screen.getByTestId('l2-panel-pill')).toHaveTextContent('nothing selected')
  })

  test('shows the recorded outcome as a subtitle only when the stage recorded one', () => {
    stubStageScope(scopeResponse({}))
    const { rerender } = render(withClient(<PanelHeader stageId="plan-review" child={child()} />))
    expect(screen.queryByTestId('detail-panel-meta')).toBeNull()

    rerender(withClient(<PanelHeader stageId="plan-review" child={child({ stageHistory: [{ stage: 'plan-review', at: '2026-08-10T10:00:00Z', note: 'looks good' }] })} />))
    expect(screen.getByTestId('detail-panel-meta')).toHaveTextContent('looks good')
  })

  test('an undispatched milestone (no task) reads "not started"', () => {
    stubStageScope(scopeResponse({}))
    render(withClient(<PanelHeader stageId="qa" child={null} />))
    expect(screen.getByTestId('l2-panel-pill')).toHaveTextContent('not started')
  })

  test('renders the stage scope block — steps and constraint chips — once its resource loads', async () => {
    stubStageScope(scopeResponse({ dev: { steps: ['Read the plan', 'Write tests first'], constraints: ['No duplication'] } }))
    render(withClient(<PanelHeader stageId="dev" child={child()} />))

    expect(await screen.findByTestId('stage-scope-dev')).toBeInTheDocument()
    expect(screen.getAllByTestId('stage-scope-step')).toHaveLength(2)
    expect(screen.getByTestId('stage-scope-constraint')).toHaveTextContent('No duplication')
  })

  test('the scope block is keyed by chain id, so code-review reads as stage-scope-cr', async () => {
    stubStageScope(scopeResponse({ 'code-review': { steps: ['Review'], constraints: [] } }))
    render(withClient(<PanelHeader stageId="cr" child={child()} />))

    expect(await screen.findByTestId('stage-scope-cr')).toBeInTheDocument()
    expect(screen.queryByTestId('stage-scope-constraints')).toBeNull()
  })

  test.each([
    ['a stage with no skill entry (merge)', 'merge', {}],
    ['a stage whose skill was unreadable (null)', 'dev', { dev: null }],
    ['a stage that parsed to zero steps', 'dev', { dev: { steps: [], constraints: [] } }],
  ] as const)('renders no scope block for %s', async (_name, stageId, stages) => {
    stubStageScope(scopeResponse(stages))
    render(withClient(<PanelHeader stageId={stageId} child={child()} />))

    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.queryByTestId(/^stage-scope-/)).toBeNull()
  })

  test('renders no scope block when the scope request fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    stubStageScope(new Response(null, { status: 500 }))
    render(withClient(<PanelHeader stageId="dev" child={child()} />))

    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.queryByTestId('stage-scope-dev')).toBeNull()
  })
})

describe('PanelBody / PanelFooter / NotDispatchedNote', () => {
  test('the body wraps its children in the padded body slot', () => {
    render(<PanelBody><span data-testid="inner" /></PanelBody>)
    expect(screen.getByTestId('inner').parentElement).toHaveClass('l2-panel-body')
  })

  test('the footer puts the primary and the secondaries in their own slots, and renders both slots even with no secondaries', () => {
    const { container } = render(<PanelFooter primary={<button data-testid="primary" />} />)

    expect(screen.getByTestId('detail-panel-footer')).toBeInTheDocument()
    expect(screen.getByTestId('primary').parentElement).toHaveClass('l2-footer-primary')
    expect(container.querySelector('.l2-footer-secondary')).toBeEmptyDOMElement()
  })

  test('the not-dispatched note says so', () => {
    render(<NotDispatchedNote />)
    expect(screen.getByTestId('not-dispatched-note')).toBeInTheDocument()
  })
})
