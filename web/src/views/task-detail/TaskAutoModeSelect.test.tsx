import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { TaskAutoModeSelect } from './TaskAutoModeSelect'

const task = { slug: 'demo-task', autoModeOverride: 'inherit' as const }
const option = (value: string) => screen.getByTestId('task-auto-mode').querySelector(`option[value="${value}"]`)!

describe('TaskAutoModeSelect', () => {
  test('selects the task\'s stored override', () => {
    render(<TaskAutoModeSelect task={{ ...task, autoModeOverride: 'manual' }} isGlobalAutoMode={false} />)
    expect(screen.getByTestId('task-auto-mode')).toHaveValue('manual')
  })

  test.each([
    [true, 'Default (auto)'],
    [false, 'Default (manual)'],
  ])('with the global switch %s, the inherit option reads "%s"', (isGlobalAutoMode, label) => {
    render(<TaskAutoModeSelect task={task} isGlobalAutoMode={isGlobalAutoMode} />)
    expect(option('inherit')).toHaveTextContent(label)
  })

  test('changing it POSTs the override for this task', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    render(<TaskAutoModeSelect task={task} isGlobalAutoMode={false} fetchImpl={fetchImpl} log={vi.fn()} />)

    fireEvent.change(screen.getByTestId('task-auto-mode'), { target: { value: 'auto' } })

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledWith('/task-auto-mode/demo-task', expect.objectContaining({ method: 'POST', body: JSON.stringify({ override: 'auto' }) })))
  })

  test('a failed POST is logged, not swallowed', async () => {
    const log = vi.fn()
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
    render(<TaskAutoModeSelect task={task} isGlobalAutoMode={false} fetchImpl={fetchImpl} log={log} />)

    fireEvent.change(screen.getByTestId('task-auto-mode'), { target: { value: 'manual' } })

    await waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('/task-auto-mode/demo-task'), expect.any(Error)))
  })

  test('a change from elsewhere (the snapshot) replaces the shown value', () => {
    const { rerender } = render(<TaskAutoModeSelect task={task} isGlobalAutoMode={false} />)
    rerender(<TaskAutoModeSelect task={{ ...task, autoModeOverride: 'auto' }} isGlobalAutoMode={false} />)
    expect(screen.getByTestId('task-auto-mode')).toHaveValue('auto')
  })
})
