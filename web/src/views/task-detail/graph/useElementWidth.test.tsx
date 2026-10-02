import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { useElementWidth } from './useElementWidth'

type ObserverCallback = (entries: Array<{ contentRect: { width: number } }>) => void

let callbacks: ObserverCallback[]
const disconnect = vi.fn()

beforeEach(() => {
  callbacks = []
  disconnect.mockClear()
  globalThis.ResizeObserver = class {
    constructor(callback: ObserverCallback) { callbacks.push(callback) }
    observe() {}
    unobserve() {}
    disconnect = disconnect
  } as unknown as typeof ResizeObserver
})
afterEach(() => vi.restoreAllMocks())

function Probe() {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  return <div ref={ref} data-testid="probe">{width}</div>
}

describe('useElementWidth', () => {
  test('is 0 until the element has been measured', () => {
    render(<Probe />)
    expect(screen.getByTestId('probe')).toHaveTextContent('0')
  })

  test('follows the observer, flooring fractional widths', () => {
    render(<Probe />)
    act(() => callbacks[0]([{ contentRect: { width: 512.7 } }]))
    expect(screen.getByTestId('probe')).toHaveTextContent('512')
  })

  test('ignores an empty observer batch', () => {
    render(<Probe />)
    act(() => callbacks[0]([]))
    expect(screen.getByTestId('probe')).toHaveTextContent('0')
  })

  test('disconnects the observer on unmount', () => {
    const { unmount } = render(<Probe />)
    unmount()
    expect(disconnect).toHaveBeenCalledTimes(1)
  })
})
