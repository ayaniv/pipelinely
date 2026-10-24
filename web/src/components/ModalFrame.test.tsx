import { useRef } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ModalFrame } from './ModalFrame'

function Harness({ onCancel }: { onCancel: () => void }) {
  const firstRef = useRef<HTMLButtonElement>(null)
  return (
    <ModalFrame scrimTestId="m-scrim" cardTestId="m-card" labelledBy="m-title" onCancel={onCancel} initialFocusRef={firstRef} dataAttributes={{ 'data-count': 3 }}>
      <div id="m-title">Title</div>
      <button ref={firstRef} type="button" data-testid="m-first">first</button>
      <button type="button" disabled data-testid="m-disabled">skipped</button>
      <button type="button" data-testid="m-last">last</button>
    </ModalFrame>
  )
}

describe('ModalFrame', () => {
  test('is a labelled modal dialog portalled to the body, carrying the caller\'s testids and data attributes', () => {
    const { container } = render(<Harness onCancel={vi.fn()} />)
    const card = screen.getByTestId('m-card')
    expect(card).toHaveAttribute('role', 'dialog')
    expect(card).toHaveAttribute('aria-modal', 'true')
    expect(card).toHaveAttribute('aria-labelledby', 'm-title')
    expect(card).toHaveAttribute('data-count', '3')
    expect(container).not.toContainElement(card)
    expect(document.body).toContainElement(screen.getByTestId('m-scrim'))
  })

  test('moves focus to the initial element on open', () => {
    render(<Harness onCancel={vi.fn()} />)
    expect(screen.getByTestId('m-first')).toHaveFocus()
  })

  test('Escape cancels', () => {
    const onCancel = vi.fn()
    render(<Harness onCancel={onCancel} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  test('a click on the scrim cancels, one inside the card does not', () => {
    const onCancel = vi.fn()
    render(<Harness onCancel={onCancel} />)
    fireEvent.click(screen.getByTestId('m-card'))
    expect(onCancel).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('m-scrim'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  test('Tab from the last enabled control wraps to the first, and Shift+Tab from the first wraps to the last', () => {
    render(<Harness onCancel={vi.fn()} />)
    screen.getByTestId('m-last').focus()
    fireEvent.keyDown(screen.getByTestId('m-last'), { key: 'Tab' })
    expect(screen.getByTestId('m-first')).toHaveFocus()
    fireEvent.keyDown(screen.getByTestId('m-first'), { key: 'Tab', shiftKey: true })
    expect(screen.getByTestId('m-last')).toHaveFocus()
  })

  test('Tab between the ends is left to the browser', () => {
    render(<Harness onCancel={vi.fn()} />)
    const notPrevented = fireEvent.keyDown(screen.getByTestId('m-first'), { key: 'Tab' })
    expect(notPrevented).toBe(true)
    expect(screen.getByTestId('m-first')).toHaveFocus()
  })

  test('hands focus back to whatever opened it when it closes', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const { unmount } = render(<Harness onCancel={vi.fn()} />)
    expect(opener).not.toHaveFocus()
    unmount()
    expect(opener).toHaveFocus()
  })

  test('does not try to refocus an opener that has left the page', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const { unmount } = render(<Harness onCancel={vi.fn()} />)
    opener.remove()
    expect(() => unmount()).not.toThrow()
  })
})
