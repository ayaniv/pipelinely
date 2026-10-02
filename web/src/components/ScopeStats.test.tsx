import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Scope } from '../taskScope'
import { InlineCardMetrics, StatGrid } from './ScopeStats'

const row = (overrides: Partial<Scope['rows'][number]['s']> = {}, model = 'claude-sonnet-5') => ({
  s: { n: 1, contextPct: 40, inputTokens: 1_000_000, outputTokens: 0, current: false, stage: null, sessionId: null, startedAt: null, updatedAt: null, ...overrides },
  slug: 'a',
  prefix: null,
  model,
})
const scopeOf = (overrides: Partial<Scope> = {}): Scope => ({ rows: [row()], ctx: 40, ctxLive: false, model: 'claude-sonnet-5', ctxSub: null, ...overrides })

describe('StatGrid', () => {
  it('renders CTX, sessions, model, tokens and cost from the scope', () => {
    const { container } = render(<StatGrid scope={scopeOf()} />)
    expect(screen.getByTestId('ctx-value')).toHaveTextContent('40%')
    expect(screen.getByTestId('sess-count')).toHaveTextContent('1')
    expect(container.querySelector('.model-sonnet')).toHaveTextContent('Sonnet')
    expect(container).toHaveTextContent('1.0M')
    expect(container.querySelector('.cost-green, .cost-yellow, .cost-red')).toHaveTextContent('$2.00')
  })

  it('reads a scope with no ctx and no priced model as dashes, never zeros', () => {
    const { container } = render(<StatGrid scope={scopeOf({ ctx: null, model: undefined, rows: [row({}, 'unpriced')] })} />)
    expect(screen.getByTestId('ctx-value')).toHaveTextContent('—')
    expect(container.querySelectorAll('.cost-dash').length).toBeGreaterThanOrEqual(2)
  })

  it('counts an empty scope as one session', () => {
    render(<StatGrid scope={scopeOf({ rows: [] })} />)
    expect(screen.getByTestId('sess-count')).toHaveTextContent('1')
  })

  it('shows the hottest-session sub-label beside a known ctx', () => {
    render(<StatGrid scope={scopeOf({ ctxSub: 'hottest live · M2 · dev' })} />)
    expect(screen.getByTestId('ctx-sub')).toHaveTextContent('hottest live · M2 · dev')
  })

  it.each([
    ['a live ctx past the threshold when warnings are allowed', { ctx: 85, ctxLive: true }, true, true],
    ['a stale ctx past the threshold — that session already ended', { ctx: 85, ctxLive: false }, true, false],
    ['a live ctx below the threshold', { ctx: 60, ctxLive: true }, true, false],
    ['a live ctx past the threshold when warnings are not allowed', { ctx: 85, ctxLive: true }, false, false],
  ])('warns for %s: %s', (_label, scope, allowWarn, isWarned) => {
    const { container } = render(<StatGrid scope={scopeOf(scope)} allowWarn={allowWarn} />)
    expect(!!container.querySelector('.ctx-high')).toBe(isWarned)
  })
})

describe('InlineCardMetrics', () => {
  it('renders only TOK and COST, with the cost flagged when it is high', () => {
    const { container } = render(<InlineCardMetrics scope={scopeOf({ rows: [row({ inputTokens: 1_000_000 }, 'claude-opus-5')], model: 'claude-opus-5' })} />)
    expect(screen.getByTestId('card-tok-label')).toHaveTextContent('TOK')
    expect(screen.getByTestId('card-cost-label')).toHaveTextContent('COST')
    expect(screen.getByTestId('card-cost')).toHaveTextContent('$5.00')
    expect(container.querySelector('.cost-high')).not.toBeNull()
    expect(screen.queryByTestId('ctx-value')).toBeNull()
  })

  it('does not flag a cheap or unpriced cost', () => {
    const { container } = render(<InlineCardMetrics scope={scopeOf({ rows: [row({}, 'unpriced')] })} />)
    expect(screen.getByTestId('card-cost')).toHaveTextContent('—')
    expect(container.querySelector('.cost-high')).toBeNull()
  })
})
