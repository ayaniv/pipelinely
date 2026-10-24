import { afterEach, describe, expect, test } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { activeViewStore } from '../../data/activeView'
import { ActiveViewSwitch } from './ActiveViewSwitch'

afterEach(() => activeViewStore.set('cards'))

describe('ActiveViewSwitch', () => {
  test('marks the current view pressed and switches on click', () => {
    render(<ActiveViewSwitch />)
    expect(screen.getByTestId('active-view-cards')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('active-view-table')).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(screen.getByTestId('active-view-table'))
    expect(screen.getByTestId('active-view-table')).toHaveAttribute('aria-pressed', 'true')
    expect(activeViewStore.get()).toBe('table')
  })
  // The design draws each option as a 14px stroked icon (an outlined 2x2 grid, three lines), not a text glyph.
  test('each option is an icon with an accessible name, and no glyph text', () => {
    render(<ActiveViewSwitch />)
    const cards = screen.getByTestId('active-view-cards')
    const table = screen.getByTestId('active-view-table')
    expect(cards.querySelector('[data-testid="cards-view-icon"]')).not.toBeNull()
    expect(table.querySelector('[data-testid="table-view-icon"]')).not.toBeNull()
    expect(cards).toHaveTextContent('')
    expect(cards).toHaveAccessibleName('Cards')
    expect(table).toHaveAccessibleName('Table')
  })
})
