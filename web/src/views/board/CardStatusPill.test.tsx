import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CardStatusPill } from './CardStatusPill'
import { makeTask } from './testTask'

// Names the STAGE (Planning/Dev/…), carries
// attention by color alone, and falls back to the status label when a task
// has no stage.

describe('CardStatusPill', () => {
  test('labels the pill with the folded stage name', () => {
    render(<CardStatusPill task={makeTask({ stage: 'code-review' })} />)
    expect(screen.getByTestId('card-status-pill')).toHaveTextContent('Code review')
  })

  test('falls back to the attention label when the task has no stage', () => {
    render(<CardStatusPill task={makeTask({ stage: null, attentionStatus: 'needs-you' })} />)
    expect(screen.getByTestId('card-status-pill')).toHaveTextContent('Needs you')
  })

  test('a working task gets the live dot and halo; others do not', () => {
    const { container, rerender } = render(<CardStatusPill task={makeTask({ attentionStatus: 'working' })} />)
    expect(container.querySelector('.card-status-dot')).toHaveClass('is-live')
    expect(container.querySelector('.card-status-dot-halo')).toBeInTheDocument()

    rerender(<CardStatusPill task={makeTask({ attentionStatus: 'paused', status: 'paused' })} />)
    expect(container.querySelector('.card-status-dot')).not.toHaveClass('is-live')
    expect(container.querySelector('.card-status-dot-halo')).not.toBeInTheDocument()
  })

  test('a Needs-you pill takes the stage tone and names the stage the card is at', () => {
    render(<CardStatusPill task={makeTask({ status: 'waiting', attentionStatus: 'needs-you', stage: 'plan-review', waitingReason: 'plan reviewed, ready for dev' })} />)
    const pill = screen.getByTestId('card-status-pill')
    expect(pill).toHaveTextContent('Dev')
    expect(pill.getAttribute('style')).toContain('var(--devSoft)')
  })

  test('a Working pill stays on the accent whatever the stage', () => {
    render(<CardStatusPill task={makeTask({ status: 'working', attentionStatus: 'working', stage: 'qa' })} />)
    expect(screen.getByTestId('card-status-pill').getAttribute('style')).toContain('var(--accentSoft)')
  })

  test('an orphaned task reads as the amber "Orphaned?" state regardless of attention', () => {
    const { container } = render(<CardStatusPill task={makeTask({ stage: null, orphaned: true, attentionStatus: 'working' })} />)
    expect(screen.getByTestId('card-status-pill')).toHaveTextContent('Orphaned?')
    expect(container.querySelector('.card-status-dot')).not.toHaveClass('is-live')
  })
})
