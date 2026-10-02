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

  test('an orphaned task reads as the amber "Orphaned?" state regardless of attention', () => {
    const { container } = render(<CardStatusPill task={makeTask({ stage: null, orphaned: true, attentionStatus: 'working' })} />)
    expect(screen.getByTestId('card-status-pill')).toHaveTextContent('Orphaned?')
    expect(container.querySelector('.card-status-dot')).not.toHaveClass('is-live')
  })
})
