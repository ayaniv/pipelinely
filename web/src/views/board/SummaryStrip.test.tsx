import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SummaryStrip } from './SummaryStrip'

describe('SummaryStrip', () => {
  test('renders the working and waiting pulse chips with their counts', () => {
    render(<SummaryStrip counts={{ working: 3, needsYou: 1 }} offFocusCount={0} />)

    expect(screen.getByTestId('pulse-chip-working')).toHaveTextContent('3 working')
    expect(screen.getByTestId('pulse-chip-waiting')).toHaveTextContent('1 waiting')
  })

  test('zeros still render — a quiet board is information', () => {
    render(<SummaryStrip counts={{ working: 0, needsYou: 0 }} offFocusCount={0} />)
    expect(screen.getByTestId('pulse-chip-working')).toHaveTextContent('0 working')
    expect(screen.getByTestId('pulse-chip-waiting')).toHaveTextContent('0 waiting')
  })

  test('shows an off focus chip after the waiting chip, carrying its count', () => {
    render(<SummaryStrip counts={{ working: 1, needsYou: 1 }} offFocusCount={2} />)
    const chip = screen.getByTestId('pulse-chip-off-focus')
    expect(chip).toHaveTextContent('2 off focus')
    expect(chip).toHaveAttribute('data-count', '2')
    expect(screen.getByTestId('pulse-chip-waiting').compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test('renders no off focus chip when nothing is off focus', () => {
    render(<SummaryStrip counts={{ working: 1, needsYou: 1 }} offFocusCount={0} />)
    expect(screen.queryByTestId('pulse-chip-off-focus')).toBeNull()
  })
})
