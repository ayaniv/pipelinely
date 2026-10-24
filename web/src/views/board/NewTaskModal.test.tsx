import { describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { NewTaskModal, type NewTaskModalProps } from './NewTaskModal'

const OPTIONS = ['acme-api', 'acme-web', 'cockpit-ai']

function setup(overrides: Partial<NewTaskModalProps> = {}) {
  const onCancel = vi.fn()
  const onSubmit = vi.fn().mockResolvedValue({ ok: true, label: '✓' })
  const props: NewTaskModalProps = { projectOptions: OPTIONS, onCancel, onSubmit, log: vi.fn(), ...overrides }
  render(<NewTaskModal {...props} />)
  return { onCancel, onSubmit, log: props.log }
}

const chips = () => screen.getAllByTestId('new-task-project-chip')
const selectedChips = () => chips().filter((chip) => chip.getAttribute('aria-pressed') === 'true')
const type = (text: string) => fireEvent.change(screen.getByTestId('new-task-prompt'), { target: { value: text } })
const start = () => screen.getByTestId('new-task-start-btn')

describe('NewTaskModal', () => {
  test('opens as a dialog with the prompt focused and the first project selected', () => {
    setup()
    expect(screen.getByTestId('new-task-modal')).toHaveAttribute('role', 'dialog')
    expect(screen.getByTestId('new-task-prompt')).toHaveFocus()
    expect(chips().map((chip) => chip.getAttribute('data-project'))).toEqual(OPTIONS)
    expect(selectedChips().map((chip) => chip.getAttribute('data-project'))).toEqual(['acme-api'])
  })

  test('the prompt and the project chips have accessible names', () => {
    setup()
    expect(screen.getByTestId('new-task-prompt')).toHaveAccessibleName('Task prompt')
    expect(screen.getByTestId('new-task-project-group')).toHaveAccessibleName('Project')
  })

  test('picking a chip moves the single selection', () => {
    setup()
    fireEvent.click(chips()[2])
    expect(selectedChips().map((chip) => chip.getAttribute('data-project'))).toEqual(['cockpit-ai'])
  })

  test('Start in Claude is disabled until the trimmed prompt is non-empty', () => {
    setup()
    expect(start()).toBeDisabled()
    type('   ')
    expect(start()).toBeDisabled()
    type('Add a CSV export')
    expect(start()).toBeEnabled()
  })

  test('submits the trimmed prompt with the selected project', async () => {
    const { onSubmit } = setup()
    fireEvent.click(chips()[1])
    type('  Add a CSV export  ')
    fireEvent.click(start())
    expect(onSubmit).toHaveBeenCalledWith({ prompt: 'Add a CSV export', project: 'acme-web' })
  })

  test('clicking Start with a blank prompt submits nothing', () => {
    const { onSubmit } = setup()
    type('   ')
    fireEvent.click(start())
    expect(onSubmit).not.toHaveBeenCalled()
  })

  test('a failed outcome keeps the modal open, shows the reason and re-enables Start', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: false, label: 'no server' })
    const { onCancel } = setup({ onSubmit })
    type('Add a CSV export')
    fireEvent.click(start())
    expect(await screen.findByTestId('new-task-error')).toHaveTextContent('no server')
    expect(screen.getByTestId('new-task-modal')).toBeInTheDocument()
    expect(onCancel).not.toHaveBeenCalled()
    expect(start()).toBeEnabled()
  })

  test('a thrown submit is logged and shown as a failure rather than closing the modal', async () => {
    const boom = new Error('boom')
    const { log } = setup({ onSubmit: vi.fn().mockRejectedValue(boom) })
    type('Add a CSV export')
    fireEvent.click(start())
    expect(await screen.findByTestId('new-task-error')).toBeInTheDocument()
    expect(log).toHaveBeenCalledWith('[agent-action] new task submit threw', boom)
  })

  test('Start is disabled while a submit is in flight, so it cannot double-submit', () => {
    const onSubmit = vi.fn().mockReturnValue(new Promise(() => {}))
    setup({ onSubmit })
    type('Add a CSV export')
    fireEvent.click(start())
    expect(start()).toBeDisabled()
    fireEvent.click(start())
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  test('Cancel and Escape dismiss', () => {
    const { onCancel } = setup()
    fireEvent.click(screen.getByTestId('new-task-cancel-btn'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  test('with no projects on the board it still submits, with no project', () => {
    const { onSubmit } = setup({ projectOptions: [] })
    expect(screen.queryAllByTestId('new-task-project-chip')).toHaveLength(0)
    type('Add a CSV export')
    fireEvent.click(start())
    expect(onSubmit).toHaveBeenCalledWith({ prompt: 'Add a CSV export', project: null })
  })

  test('a selected project that leaves the list falls back to the first one', () => {
    const onCancel = vi.fn()
    const props: NewTaskModalProps = { projectOptions: OPTIONS, onCancel, onSubmit: vi.fn(), log: vi.fn() }
    const { rerender } = render(<NewTaskModal {...props} />)
    fireEvent.click(screen.getAllByTestId('new-task-project-chip')[2])
    rerender(<NewTaskModal {...props} projectOptions={['acme-api', 'acme-web']} />)
    const pressed = screen.getAllByTestId('new-task-project-chip').filter((chip) => chip.getAttribute('aria-pressed') === 'true')
    expect(pressed.map((chip) => chip.getAttribute('data-project'))).toEqual(['acme-api'])
  })
})
