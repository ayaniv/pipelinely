import { describe, expect, test, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { setConnectionStatus, useConnectionStatus } from './connectionStatus'

function Probe() {
  return <span data-testid="probe">{useConnectionStatus()}</span>
}

describe('connectionStatus', () => {
  test('starts as connecting and follows live/reconnecting updates', () => {
    render(<Probe />)
    expect(screen.getByTestId('probe')).toHaveTextContent('connecting')

    act(() => setConnectionStatus('live'))
    expect(screen.getByTestId('probe')).toHaveTextContent('live')

    act(() => setConnectionStatus('reconnecting'))
    expect(screen.getByTestId('probe')).toHaveTextContent('reconnecting')
  })

  test('an unknown status is logged and leaves the state alone', () => {
    const log = vi.fn()
    render(<Probe />)
    act(() => setConnectionStatus('live'))

    act(() => setConnectionStatus('bogus', log))

    expect(screen.getByTestId('probe')).toHaveTextContent('live')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[connection]'))
  })
})
