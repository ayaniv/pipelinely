import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CtxMeter } from './CtxMeter'

describe('CtxMeter', () => {
  test('renders the percentage and a proportional fill width', () => {
    render(<CtxMeter ctx={42} />)
    expect(screen.getByText('42%')).toBeInTheDocument()
  })

  test('labels itself "ctx" by default', () => {
    render(<CtxMeter ctx={42} />)
    expect(screen.getByTestId('card-ctx-label')).toHaveTextContent('ctx')
  })

  // The table's Ctx column is already headed "Ctx", so the design drops the per-row label there.
  test('an unlabelled meter renders no "ctx" label but still the bar and the percentage', () => {
    render(<CtxMeter ctx={42} isLabelled={false} testIds={{ fill: 'the-fill' }} />)
    expect(screen.queryByTestId('card-ctx-label')).not.toBeInTheDocument()
    expect(screen.getByTestId('the-fill')).toHaveStyle({ width: '42%' })
    expect(screen.getByText('42%')).toBeInTheDocument()
  })

  test('an unlabelled meter with no ctx still shows the em dash and an empty bar', () => {
    render(<CtxMeter ctx={null} isLabelled={false} testIds={{ fill: 'the-fill' }} />)
    expect(screen.queryByTestId('card-ctx-label')).not.toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByTestId('the-fill')).toHaveStyle({ width: '0%' })
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

  test('a fill colour overrides the fill at every level, while the value still turns amber when hot', () => {
    render(<CtxMeter ctx={75} fillColor="var(--crC)" testIds={{ fill: 'the-fill', pct: 'the-pct' }} />)
    expect(screen.getByTestId('the-fill')).toHaveAttribute('style', expect.stringContaining('background: var(--crC)'))
    expect(screen.getByTestId('the-pct')).toHaveAttribute('style', expect.stringContaining('color: var(--amberInk)'))
  })

  // The design's card and table meters (the stage-toned ones) keep a --surface2 track even when hot;
  // only the untoned header and task-view meters tint the track amber.
  test('a stage-toned meter keeps its surface2 track when hot', () => {
    render(<CtxMeter ctx={75} fillColor="var(--crC)" testIds={{ track: 'the-track' }} />)
    expect(screen.getByTestId('the-track')).toHaveAttribute('style', expect.stringContaining('background: var(--surface2)'))
  })

  test('a fill colour is used when cool too', () => {
    render(<CtxMeter ctx={40} fillColor="var(--mergeC)" testIds={{ fill: 'the-fill' }} />)
    expect(screen.getByTestId('the-fill')).toHaveAttribute('style', expect.stringContaining('background: var(--mergeC)'))
  })

  test('testids are omitted entirely when not provided', () => {
    render(<CtxMeter ctx={10} />)
    expect(screen.queryByTestId('undefined')).not.toBeInTheDocument()
  })
})
