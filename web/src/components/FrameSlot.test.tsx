import { describe, expect, test, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FrameSlot } from './FrameSlot'

// A FrameSlot is a portal into an element the app frame already owns.

function addContainer(id: string): HTMLElement {
  const el = document.createElement('div')
  el.id = id
  document.body.appendChild(el)
  return el
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('FrameSlot', () => {
  test('renders its children inside the container, not beside it', () => {
    const container = addContainer('active-cards')
    render(<FrameSlot containerId="active-cards"><span data-testid="child">hi</span></FrameSlot>)

    expect(container).toContainElement(screen.getByTestId('child'))
  })

  test('a missing container renders nothing and logs a [frame-slot] error naming it', () => {
    const log = vi.fn()
    render(<FrameSlot containerId="does-not-exist" log={log}><span data-testid="child" /></FrameSlot>)

    expect(screen.queryByTestId('child')).not.toBeInTheDocument()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[frame-slot]'), 'does-not-exist')
  })

  test('finds a container that is committed in the same render as the slot, without logging', () => {
    const log = vi.fn()
    // The slot renders before its container exists — what happens when a
    // frame region is switched on in the same update that mounts its view.
    render(
      <>
        <FrameSlot containerId="late-container" log={log}><span data-testid="child" /></FrameSlot>
        <div id="late-container" data-testid="late-container" />
      </>,
    )

    expect(screen.getByTestId('late-container')).toContainElement(screen.getByTestId('child'))
    expect(log).not.toHaveBeenCalled()
  })

  test('applies class toggles to the container and reverts them on unmount', () => {
    const container = addContainer('global-progress')
    const { rerender, unmount } = render(<FrameSlot containerId="global-progress" classToggles={{ 'is-visible': true }}>x</FrameSlot>)
    expect(container).toHaveClass('is-visible')

    rerender(<FrameSlot containerId="global-progress" classToggles={{ 'is-visible': false }}>x</FrameSlot>)
    expect(container).not.toHaveClass('is-visible')

    rerender(<FrameSlot containerId="global-progress" classToggles={{ 'is-visible': true }}>x</FrameSlot>)
    unmount()
    expect(container).not.toHaveClass('is-visible')
  })

  test('leaves the container\'s own pre-existing classes alone', () => {
    const container = addContainer('global-progress')
    container.className = 'global-progress'
    const { unmount } = render(<FrameSlot containerId="global-progress" classToggles={{ 'is-visible': true }}>x</FrameSlot>)
    unmount()
    expect(container).toHaveClass('global-progress')
  })
})
