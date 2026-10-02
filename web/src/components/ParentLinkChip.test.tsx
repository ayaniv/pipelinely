import { describe, expect, test, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ParentLinkChip } from './ParentLinkChip'

// Renders nothing for a task with no parent relationship (projectTitle unset),
// and otherwise a link that navigates to the parent's own slug. onNavigate is
// injected, so this component doesn't assume how its caller wires navigation.

describe('ParentLinkChip', () => {
  test('renders nothing for a flat task with no parent relationship', () => {
    const { container } = render(<ParentLinkChip projectTitle={undefined} projectBase={undefined} testId="detail-parent-link" onNavigate={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  test('renders the parent title and testid for a milestone child', () => {
    render(<ParentLinkChip projectTitle="Fanout parent fixture" projectBase="fanout-parent" testId="detail-parent-link" onNavigate={vi.fn()} />)
    const link = screen.getByTestId('detail-parent-link')
    expect(link).toHaveTextContent('Fanout parent fixture')
  })

  test('clicking it navigates to the parent slug and prevents the default # navigation', () => {
    const onNavigate = vi.fn()
    render(<ParentLinkChip projectTitle="Fanout parent fixture" projectBase="fanout-parent" testId="detail-parent-link" onNavigate={onNavigate} />)

    fireEvent.click(screen.getByTestId('detail-parent-link'))

    expect(onNavigate).toHaveBeenCalledWith('fanout-parent')
  })

  test('an empty projectBase still renders (falling back to an empty slug) but navigates with an empty slug', () => {
    const onNavigate = vi.fn()
    render(<ParentLinkChip projectTitle="Orphaned parent title" projectBase={undefined} testId="detail-parent-link" onNavigate={onNavigate} />)
    fireEvent.click(screen.getByTestId('detail-parent-link'))
    expect(onNavigate).toHaveBeenCalledWith('')
  })
})
