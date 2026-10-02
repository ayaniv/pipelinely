import { describe, expect, test } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { LivePill } from './LivePill'
import { setConnectionStatus } from '../../data/connectionStatus'

describe('LivePill', () => {
  test('the dot, its halo and the text agree on each status', () => {
    render(<LivePill />)
    const dot = screen.getByTestId('header-live-dot')
    const halo = screen.getByTestId('header-live-halo')
    const text = screen.getByTestId('header-live-text')

    act(() => setConnectionStatus('live'))
    expect(text).toHaveTextContent('live')
    expect(text).toHaveClass('is-live')
    expect(dot).toHaveClass('is-live')
    expect(halo).toHaveClass('is-live')

    act(() => setConnectionStatus('reconnecting'))
    expect(text).toHaveTextContent('reconnecting')
    expect(text).not.toHaveClass('is-live')
    expect(dot).toHaveClass('is-error')
    expect(dot).not.toHaveClass('is-live')
    expect(halo).toHaveClass('is-error')
  })
})
