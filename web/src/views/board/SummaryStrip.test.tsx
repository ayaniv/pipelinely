import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SummaryStrip } from './SummaryStrip'

describe('SummaryStrip', () => {
  test('renders the working and waiting pulse chips with their counts', () => {
    render(<SummaryStrip counts={{ working: 3, needsYou: 1 }} />)

    expect(screen.getByTestId('pulse-chip-working')).toHaveTextContent('3 working')
    expect(screen.getByTestId('pulse-chip-waiting')).toHaveTextContent('1 waiting')
  })

  test('zeros still render — a quiet board is information', () => {
    render(<SummaryStrip counts={{ working: 0, needsYou: 0 }} />)
    expect(screen.getByTestId('pulse-chip-working')).toHaveTextContent('0 working')
    expect(screen.getByTestId('pulse-chip-waiting')).toHaveTextContent('0 waiting')
  })
})
