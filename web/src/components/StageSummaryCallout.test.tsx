import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StageSummaryCallout } from './StageSummaryCallout'

describe('StageSummaryCallout', () => {
  const summary = { head: 'Plan reviewed.', rest: 'Two milestones are ready.' }

  test('renders the head and the rest, in the stage tone, with the icon kind on the container', () => {
    render(<StageSummaryCallout summary={summary} tone="dev" icon="dot" />)
    const callout = screen.getByTestId('card-summary')
    expect(callout).toHaveAttribute('data-icon', 'dot')
    expect(callout.getAttribute('style')).toContain('var(--devSoft)')
    expect(screen.getByTestId('card-summary-head')).toHaveTextContent('Plan reviewed.')
    expect(screen.getByTestId('card-summary-head').getAttribute('style')).toContain('var(--devInk)')
    expect(screen.getByTestId('card-summary-rest')).toHaveTextContent('Two milestones are ready.')
  })

  test('omits the rest line when there is none', () => {
    render(<StageSummaryCallout summary={{ head: 'Ready.', rest: '' }} tone="merge" icon="check" />)
    expect(screen.queryByTestId('card-summary-rest')).not.toBeInTheDocument()
  })

  test('the container testid is a prop, while the head and rest keep the shared ids', () => {
    render(<StageSummaryCallout summary={summary} tone="qa" icon="comment" testId="detail-summary" />)
    expect(screen.getByTestId('detail-summary')).toHaveAttribute('data-icon', 'comment')
    expect(screen.getByTestId('card-summary-head')).toBeInTheDocument()
    expect(screen.getByTestId('card-summary-rest')).toBeInTheDocument()
  })
})
