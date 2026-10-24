import { describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PrLink } from './PrLink'

const okJson = (status = 200) => new Response('{}', { status, headers: { 'Content-Type': 'application/json' } })

describe('PrLink', () => {
  test('renders nothing without a PR number', () => {
    const { container } = render(<PrLink slug="demo" prNumber={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  test('shows the GitHub icon and #<n>, carrying the number as data-pr', () => {
    render(<PrLink slug="demo" prNumber="42" />)
    const link = screen.getByTestId('card-pr-link')
    expect(link).toHaveAttribute('data-pr', '42')
    expect(link).toHaveTextContent('#42')
    expect(screen.getByTestId('github-icon')).toBeInTheDocument()
  })

  test('clicking posts open-pr for the slug and does not bubble to the card', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okJson())
    const onCardClick = vi.fn()
    render(<div onClick={onCardClick}><PrLink slug="demo" prNumber="42" fetchImpl={fetchImpl} /></div>)

    fireEvent.click(screen.getByTestId('card-pr-link'))

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledWith('/open-pr/demo', expect.anything()))
    expect(onCardClick).not.toHaveBeenCalled()
  })

  test('a failed open flashes btn-err on the link and logs [action]', async () => {
    const log = vi.fn()
    render(<PrLink slug="demo" prNumber="42" fetchImpl={vi.fn().mockResolvedValue(okJson(500))} log={log} />)

    fireEvent.click(screen.getByTestId('card-pr-link'))

    await waitFor(() => expect(screen.getByTestId('card-pr-link')).toHaveClass('btn-err'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action]'), expect.any(Error))
  })
})
