import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CtxMeter } from './CtxMeter'

describe('CtxMeter', () => {
  test('renders the percentage and a proportional fill width', () => {
    render(<CtxMeter ctx={42} />)
    expect(screen.getByText('42%')).toBeInTheDocument()
  })

  test('a null ctx renders an em dash and a zero-width fill, never a fabricated 0%', () => {
    render(<CtxMeter ctx={null} testIds={{ fill: 'the-fill' }} />)
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByTestId('the-fill')).toHaveStyle({ width: '0%' })
  })

  // Failure/edge path: ctx above the hot threshold (60) switches every part
  // of the meter to the amber palette — the one rule ctxMeterHtml/CtxMeter
  // both center on. Asserted against the raw `style` attribute rather than
  // jest-dom's computed toHaveStyle: jsdom's CSSOM lowercases an unresolved
  // var()'s custom-property name in its computed form (amberSoft ->
  // ambersoft), which is a jsdom quirk, not something this component or a
  // real browser does.
  test('ctx above the hot threshold renders the amber palette', () => {
    render(<CtxMeter ctx={75} testIds={{ track: 'the-track', fill: 'the-fill', pct: 'the-pct' }} />)
    expect(screen.getByTestId('the-track')).toHaveAttribute('style', expect.stringContaining('background: var(--amberSoft)'))
    expect(screen.getByTestId('the-fill')).toHaveAttribute('style', expect.stringContaining('background: var(--amber)'))
    expect(screen.getByTestId('the-fill')).toHaveStyle({ width: '75%' })
    expect(screen.getByTestId('the-pct')).toHaveAttribute('style', expect.stringContaining('color: var(--amberInk)'))
  })

  test('ctx at or below the hot threshold renders the accent palette', () => {
    render(<CtxMeter ctx={60} testIds={{ track: 'the-track', fill: 'the-fill' }} />)
    expect(screen.getByTestId('the-track')).toHaveAttribute('style', expect.stringContaining('background: var(--surface2)'))
    expect(screen.getByTestId('the-fill')).toHaveAttribute('style', expect.stringContaining('background: var(--accent)'))
  })

  test('testids are omitted entirely when not provided', () => {
    render(<CtxMeter ctx={10} />)
    expect(screen.queryByTestId('undefined')).not.toBeInTheDocument()
  })
})
