import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { makeTask } from '../../testing/makeTask'
import { SessionsSection } from './SessionsSection'

const session = (overrides: Partial<ReturnType<typeof makeTask>['sessions'][number]> = {}) => ({
  n: 1, contextPct: 40, inputTokens: 1_000_000, outputTokens: 0, current: false, stage: null, sessionId: null, startedAt: null, updatedAt: null, ...overrides,
})

describe('SessionsSection', () => {
  test('a task with no METRICS says so, with no header and no rows', () => {
    const { container } = render(<SessionsSection task={makeTask({ sessions: [] })} isFanout={false} />)
    expect(container.querySelector('.detail-row-note')).not.toBeNull()
    expect(container.querySelector('.sess-head')).toBeNull()
    expect(screen.queryAllByTestId('session-row')).toHaveLength(0)
  })

  test('renders a header and one row per session, labelled by stage', () => {
    const { container } = render(<SessionsSection task={makeTask({ model: 'claude-sonnet-5', sessions: [session({ stage: 'planning' }), session({ n: 2, stage: 'dev' })] })} isFanout={false} />)
    expect(container.querySelector('.sess-note')).toHaveTextContent('per Claude session')
    expect(screen.getAllByTestId('session-label').map((label) => label.textContent)).toEqual(['planning', 'dev'])
  })

  test('a fan-out parent says its note covers the parent and every milestone', () => {
    const { container } = render(<SessionsSection task={makeTask({ sessions: [session()] })} isFanout />)
    expect(container.querySelector('.sess-note')).toHaveTextContent('parent + every milestone')
  })

  test('marks the live session and falls back to #N for one with no stage', () => {
    render(<SessionsSection task={makeTask({ sessions: [session({ n: 3, current: true })] })} isFanout={false} />)
    expect(screen.getByTestId('session-label')).toHaveTextContent('#3 · live')
    expect(screen.getByTestId('session-row')).toHaveClass('is-current')
  })

  test('shows ctx and a priced cost, capping the bar at 100%', () => {
    const { container } = render(<SessionsSection task={makeTask({ model: 'claude-sonnet-5', sessions: [session({ contextPct: 130 })] })} isFanout={false} />)
    const row = screen.getByTestId('session-row')
    expect(row).toHaveTextContent('130% ctx')
    expect(row).toHaveTextContent('$2.00')
    expect((container.querySelector('.session-bar span') as HTMLElement).style.width).toBe('100%')
  })

  test('an unrecorded ctx and an unpriced model read as dashes, never zeros', () => {
    render(<SessionsSection task={makeTask({ model: 'unpriced-model', sessions: [session({ contextPct: null })] })} isFanout={false} />)
    const cells = screen.getByTestId('session-row').querySelectorAll('span')
    const texts = Array.from(cells).map((cell) => cell.textContent)
    expect(texts).toContain('—')
    expect(texts.filter((text) => text === '—')).toHaveLength(2)
  })
})
