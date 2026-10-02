import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MergeBanner } from './MergeBanner'

describe('MergeBanner', () => {
  test('renders nothing when there is no banner', () => {
    const { container } = render(<MergeBanner banner={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  test('renders one line item per blocker, tagged with its tone', () => {
    render(<MergeBanner banner={{ tone: 'error', lines: ['checks failing', 'behind main'] }} />)

    expect(screen.getByTestId('merge-banner')).toHaveAttribute('data-tone', 'error')
    expect(screen.getAllByTestId('merge-banner-line').map((li) => li.textContent)).toEqual(['checks failing', 'behind main'])
  })

  test('a warning tone is carried through', () => {
    render(<MergeBanner banner={{ tone: 'warning', lines: ['cleanup needs a hand'] }} />)
    expect(screen.getByTestId('merge-banner')).toHaveAttribute('data-tone', 'warning')
  })
})
