import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, test } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { Creature } from './Creature'
import type { TaskCreature } from '../../../src/types'

const PIP: TaskCreature = { name: 'Pip', color: '#a8d8c9', shape: '32% 64% 44% 47% / 63% 60% 47% 55%' }

describe('Creature', () => {
  test('is a coloured body carrying the stored shape, its name and the tooltip', () => {
    render(<Creature creature={PIP} size={24} isWorking={false} />)
    const body = screen.getByTestId('creature')
    expect(body).toHaveAttribute('data-name', 'Pip')
    expect(body).toHaveAttribute('title', 'Pip is on this task')
    expect(body.style.backgroundColor).toBe('rgb(168, 216, 201)')
    expect(body.style.borderRadius).toBe(PIP.shape)
  })

  test('scales with its size prop; the visor and eyes size themselves from the same variable', () => {
    render(<Creature creature={PIP} size={30} isWorking={false} />)
    const body = screen.getByTestId('creature')
    expect(body.style.width).toBe('30px')
    expect(body.style.height).toBe('30px')
    expect(body.style.getPropertyValue('--creature-size')).toBe('30px')
  })

  test('draws a visor with two eyes and no image or svg', () => {
    render(<Creature creature={PIP} size={24} isWorking={false} />)
    const body = screen.getByTestId('creature')
    expect(within(within(body).getByTestId('creature-visor')).getAllByTestId('creature-eye')).toHaveLength(2)
    expect(body.querySelector('img, svg')).toBeNull()
  })

  test('a working task\'s creature carries the is-working class', () => {
    render(<Creature creature={PIP} size={24} isWorking />)
    expect(screen.getByTestId('creature')).toHaveClass('creature', 'is-working')
  })

  test('a creature whose task is not working has no is-working class', () => {
    render(<Creature creature={PIP} size={24} isWorking={false} />)
    expect(screen.getByTestId('creature')).not.toHaveClass('is-working')
  })
})

// jsdom does no layout, so the drawing's rules are pinned where they are
// defined. The ui spec (e2e/creature-eyes-animation-shadow.spec.ts) measures them.
describe('the creature styles', () => {
  const css = readFileSync(path.join(process.cwd(), 'web/src/styles/app.css'), 'utf-8')
  const ruleFor = (selector: string) => css.match(new RegExp(`\\n\\s*${selector.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`))?.[1] ?? ''

  test('an eye is a circle: width and height are one expression, fully rounded', () => {
    const rule = ruleFor('.creature-eye')
    const width = rule.match(/(?:^|;|\s)width:\s*([^;]+);/)?.[1]
    const height = rule.match(/(?:^|;|\s)height:\s*([^;]+);/)?.[1]
    expect(width).toBeTruthy()
    expect(height).toBe(width)
    expect(rule).toMatch(/border-radius:\s*50%/)
  })

  // A fractional diameter is pixel-snapped per edge, so an eye paints oval or
  // lopsided; QA measured this at 22, 23 and 30px.
  test('the eye diameter is rounded to a whole pixel so it paints round', () => {
    expect(ruleFor('.creature-eye')).toMatch(/--creature-eye-size:\s*round\([^;]*,\s*1px\)\s*;/)
  })

  // An empty rule would satisfy every negative match below, so each lookup must find a rule first.
  test.each(['.creature', '.creature-visor', '.creature-eye', '.creature.is-working'])('the rule for %s is found', (selector) => {
    expect(ruleFor(selector)).not.toBe('')
  })

  test.each(['.creature', '.creature-visor', '.creature-eye'])('%s is drawn flat, with no shadow', (selector) => {
    expect(ruleFor(selector)).not.toMatch(/box-shadow|drop-shadow|text-shadow/)
  })

  test('only a working creature is animated, and reduced motion switches it off', () => {
    expect(ruleFor('.creature')).not.toMatch(/animation/)
    expect(ruleFor('.creature.is-working')).toMatch(/animation:/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*\.creature\.is-working[^}]*animation:\s*none/)
  })
})

describe('Creature height', () => {
  test('a non-square body takes its own height while the visor variable follows the width', () => {
    render(<Creature creature={PIP} size={22} heightPx={20} isWorking={false} />)
    const body = screen.getByTestId('creature')
    expect(body.style.width).toBe('22px')
    expect(body.style.height).toBe('20px')
    expect(body.style.getPropertyValue('--creature-size')).toBe('22px')
  })
})

describe('Creature without a visor', () => {
  test('a bare body draws its two eyes straight on the colour, with no visor', () => {
    render(<Creature creature={PIP} size={22} heightPx={20} hasVisor={false} isWorking={false} />)
    const body = screen.getByTestId('creature')
    expect(within(body).queryByTestId('creature-visor')).not.toBeInTheDocument()
    expect(within(body).getAllByTestId('creature-eye')).toHaveLength(2)
    expect(body).toHaveClass('is-bare')
  })

  test('the default creature keeps its visor and is not bare', () => {
    render(<Creature creature={PIP} size={24} isWorking={false} />)
    expect(screen.getByTestId('creature')).not.toHaveClass('is-bare')
    expect(screen.getByTestId('creature-visor')).toBeInTheDocument()
  })
})
