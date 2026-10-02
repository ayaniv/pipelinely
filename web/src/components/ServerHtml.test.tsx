import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ServerHtml } from './ServerHtml'

describe('ServerHtml', () => {
  test('renders the server-built markup under the given testid and class', () => {
    render(<ServerHtml testId="tech-design-body" className="markdown-body" html="<h1>Plan</h1><p>body</p>" />)

    const body = screen.getByTestId('tech-design-body')
    expect(body).toHaveClass('markdown-body')
    expect(body.querySelector('h1')).toHaveTextContent('Plan')
  })

  test('leaves the DOM untouched when re-rendered with an identical string', () => {
    const { rerender } = render(<ServerHtml testId="b" html="<p>same</p>" />)
    const paragraph = screen.getByTestId('b').querySelector('p')

    rerender(<ServerHtml testId="b" html="<p>same</p>" />)

    expect(screen.getByTestId('b').querySelector('p')).toBe(paragraph)
  })
})
