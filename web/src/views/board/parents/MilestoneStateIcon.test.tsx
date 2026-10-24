import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MilestoneStateIcon } from './MilestoneStateIcon'

describe('MilestoneStateIcon', () => {
  test('each of the three states draws a different shape, so state never rests on colour alone', () => {
    const shapes = (['done', 'working', 'idle'] as const).map((state) => {
      const { container, unmount } = render(<MilestoneStateIcon state={state} label={`M1 · name · ${state}`} />)
      const html = container.innerHTML
      unmount()
      return html
    })
    expect(new Set(shapes).size).toBe(3)
  })

  test('done carries a tick, working a spinner arc, idle neither', () => {
    const { unmount } = render(<MilestoneStateIcon state="done" label="done one" />)
    expect(screen.getByTestId('milestone-icon-tick')).toBeInTheDocument()
    unmount()
    const working = render(<MilestoneStateIcon state="working" label="working one" />)
    expect(screen.getByTestId('milestone-icon-arc')).toBeInTheDocument()
    expect(screen.queryByTestId('milestone-icon-tick')).not.toBeInTheDocument()
    working.unmount()
    render(<MilestoneStateIcon state="idle" label="idle one" />)
    expect(screen.queryByTestId('milestone-icon-tick')).not.toBeInTheDocument()
    expect(screen.queryByTestId('milestone-icon-arc')).not.toBeInTheDocument()
  })

  test('is a labelled image whose label and hover title are the same text', () => {
    render(<MilestoneStateIcon state="working" label="M1 · Workspace billing model · working" />)
    const icon = screen.getByTestId('milestone-icon')
    expect(icon).toHaveAttribute('role', 'img')
    expect(icon).toHaveAttribute('aria-label', 'M1 · Workspace billing model · working')
    expect(icon.querySelector('title')).toHaveTextContent('M1 · Workspace billing model · working')
    expect(icon).toHaveAttribute('data-state', 'working')
  })

  // The v4 HTML draws all three on a 24-unit grid; the working ring is a 3-unit stroke.
  test('draws on the design\'s 24-unit grid', () => {
    render(<MilestoneStateIcon state="working" label="x" />)
    const icon = screen.getByTestId('milestone-icon')
    expect(icon).toHaveAttribute('viewBox', '0 0 24 24')
    expect(screen.getByTestId('milestone-icon-arc')).toHaveAttribute('stroke-width', '3')
  })

  test('is 15px', () => {
    render(<MilestoneStateIcon state="idle" label="x" />)
    expect(screen.getByTestId('milestone-icon')).toHaveAttribute('width', '15')
    expect(screen.getByTestId('milestone-icon')).toHaveAttribute('height', '15')
  })
})

// jsdom runs no animation or media queries, so the rules are pinned where they
// are defined; e2e/parent-tasks-section.spec.ts measures them in a browser.
describe('the milestone icon styles', () => {
  const css = readFileSync(path.join(process.cwd(), 'web/src/styles/app.css'), 'utf-8')
  const ruleFor = (selector: string) => css.match(new RegExp(`\\n\\s*${selector.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`))?.[1] ?? ''

  test('the working arc spins for 1s, linear, forever', () => {
    expect(ruleFor('.milestone-icon-spin')).toMatch(/animation:\s*milestoneSpin\s+1s\s+linear\s+infinite/)
  })

  test('under prefers-reduced-motion the spin stops and the static ring-with-arc remains', () => {
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*?\.milestone-icon-spin[^}]*\}/)?.[0] ?? ''
    expect(reduced).toMatch(/animation:\s*none/)
  })

  test('idle is a 2px border2 ring', () => {
    expect(ruleFor('.milestone-icon-idle-ring')).toMatch(/stroke:\s*var\(--border2\)/)
    expect(ruleFor('.milestone-icon-idle-ring')).toMatch(/stroke-width:\s*2/)
  })
})
