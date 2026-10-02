import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { CopySlugButton } from './CopySlugButton'

// Shared by the task-detail head and the board's session card — same button, same "copied" flash, same testids.

beforeEach(() => {
  vi.useFakeTimers()
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('CopySlugButton', () => {
  test('copies the slug to the clipboard and flashes "copied" for a moment', async () => {
    render(<CopySlugButton slug="demo-task" />)
    expect(screen.getByTestId('card-copied')).not.toBeVisible()

    await act(async () => { fireEvent.click(screen.getByTestId('card-copy-btn')) })

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('demo-task')
    expect(screen.getByTestId('card-copied')).toBeVisible()

    act(() => { vi.advanceTimersByTime(1400) })
    expect(screen.getByTestId('card-copied')).not.toBeVisible()
  })

  test('a clipboard failure is logged, not swallowed', async () => {
    const log = vi.fn()
    ;(navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('denied'))
    render(<CopySlugButton slug="demo-task" log={log} />)

    await act(async () => { fireEvent.click(screen.getByTestId('card-copy-btn')) })

    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action] could not copy slug'), expect.any(Error))
  })

  test('a missing clipboard API is logged too', async () => {
    Object.assign(navigator, { clipboard: undefined })
    const log = vi.fn()
    render(<CopySlugButton slug="demo-task" log={log} />)

    await act(async () => { fireEvent.click(screen.getByTestId('card-copy-btn')) })

    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action] could not copy slug'), expect.anything())
  })

  test('does not flash "copied" when the write failed', async () => {
    ;(navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('denied'))
    render(<CopySlugButton slug="demo-task" log={vi.fn()} />)

    await act(async () => { fireEvent.click(screen.getByTestId('card-copy-btn')) })

    expect(screen.getByTestId('card-copied')).not.toBeVisible()
  })
})
