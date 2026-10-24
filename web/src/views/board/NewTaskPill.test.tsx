import { describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NewTaskPill } from './NewTaskPill'

const open = () => fireEvent.click(screen.getByTestId('new-task-pill'))
const fill = (text: string) => fireEvent.change(screen.getByTestId('new-task-prompt'), { target: { value: text } })

describe('NewTaskPill', () => {
  test('renders closed, and opens the modal on click', () => {
    render(<NewTaskPill projectOptions={['acme-api']} log={vi.fn()} />)
    expect(screen.queryByTestId('new-task-modal')).toBeNull()
    open()
    expect(screen.getByTestId('new-task-modal')).toBeInTheDocument()
  })

  test('a successful start closes the modal, and reopening starts with an empty prompt', async () => {
    const startTask = vi.fn().mockResolvedValue({ ok: true, label: '✓' })
    render(<NewTaskPill projectOptions={['acme-api', 'acme-web']} startTask={startTask} log={vi.fn()} />)
    open()
    fill('Add a CSV export')
    fireEvent.click(screen.getByTestId('new-task-start-btn'))
    await waitFor(() => expect(screen.queryByTestId('new-task-modal')).toBeNull())
    expect(startTask).toHaveBeenCalledWith({ prompt: 'Add a CSV export', project: 'acme-api' }, expect.objectContaining({ log: expect.any(Function) }))
    open()
    expect(screen.getByTestId('new-task-prompt')).toHaveValue('')
  })

  test('a failed start keeps the modal open', async () => {
    const startTask = vi.fn().mockResolvedValue({ ok: false, label: 'empty prompt' })
    render(<NewTaskPill projectOptions={['acme-api']} startTask={startTask} log={vi.fn()} />)
    open()
    fill('Add a CSV export')
    fireEvent.click(screen.getByTestId('new-task-start-btn'))
    expect(await screen.findByTestId('new-task-error')).toBeInTheDocument()
    expect(screen.getByTestId('new-task-modal')).toBeInTheDocument()
  })

  test('dismissing returns focus to the pill and discards the draft', () => {
    render(<NewTaskPill projectOptions={['acme-api']} log={vi.fn()} />)
    screen.getByTestId('new-task-pill').focus()
    open()
    fill('draft')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('new-task-modal')).toBeNull()
    expect(screen.getByTestId('new-task-pill')).toHaveFocus()
    open()
    expect(screen.getByTestId('new-task-prompt')).toHaveValue('')
  })
})
