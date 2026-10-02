import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { StandupButton } from './StandupButton'

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}

describe('StandupButton', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  test('copies the text, says "copied", then reverts', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    render(<StandupButton text={'• One\n• Two'} log={vi.fn()} />)

    await act(async () => { fireEvent.click(screen.getByTestId('standup-btn')) })

    expect(writeText).toHaveBeenCalledWith('• One\n• Two')
    expect(screen.getByTestId('standup-btn')).toHaveTextContent('copied')
    act(() => { vi.advanceTimersByTime(1600) })
    expect(screen.getByTestId('standup-btn')).toHaveTextContent('copy standup')
  })

  test('with nothing to copy it does nothing', async () => {
    const writeText = vi.fn()
    stubClipboard(writeText)
    render(<StandupButton text={null} log={vi.fn()} />)

    await act(async () => { fireEvent.click(screen.getByTestId('standup-btn')) })

    expect(writeText).not.toHaveBeenCalled()
    expect(screen.getByTestId('standup-btn')).toHaveTextContent('copy standup')
  })

  test('a clipboard that refuses is logged and reported on the button', async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error('denied')))
    const log = vi.fn()
    render(<StandupButton text="• One" log={log} />)

    await act(async () => { fireEvent.click(screen.getByTestId('standup-btn')) })

    expect(log).toHaveBeenCalledWith('[action] could not copy standup text', expect.any(Error))
    expect(screen.getByTestId('standup-btn')).toHaveTextContent('copy failed')
  })

  test('a browser with no clipboard API is logged rather than throwing', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    const log = vi.fn()
    render(<StandupButton text="• One" log={log} />)

    await act(async () => { fireEvent.click(screen.getByTestId('standup-btn')) })

    expect(log).toHaveBeenCalledWith('[action] could not copy standup text', expect.any(Error))
  })
})
