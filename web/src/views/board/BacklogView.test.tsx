import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { BacklogItem } from '../../../../src/types'
import { visibleBacklogRows } from './boardModel'
import { BacklogView, type BacklogViewProps } from './BacklogView'

const item = (description: string, overrides: Partial<BacklogItem> = {}): BacklogItem =>
  ({ description, date: '2026-08-20', context: null, done: false, shelvedSlug: null, project: null, ...overrides })

const ITEMS = [item('First', { project: 'acme-api', context: 'some context' }), item('Second'), item('Third', { project: 'acme-web' })]

function response(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function setup(overrides: Partial<BacklogViewProps> = {}) {
  const fetchImpl = vi.fn().mockResolvedValue(response(200))
  const log = vi.fn()
  const onOpenTask = vi.fn()
  const onResumed = vi.fn()
  const backlog = overrides.backlog ?? ITEMS
  const props: BacklogViewProps = {
    rows: visibleBacklogRows(backlog, new Set()), backlog, isCanonical: true, projectOptions: ['acme-api', 'acme-web'],
    onOpenTask, onResumed, fetchImpl, log, ...overrides,
  }
  const view = render(<BacklogView {...props} />)
  const rerenderWith = (next: Partial<BacklogViewProps>) => {
    const merged = { ...props, ...next }
    view.rerender(<BacklogView {...merged} rows={next.rows ?? visibleBacklogRows(merged.backlog, new Set())} />)
  }
  return { fetchImpl, log, onOpenTask, onResumed, rerenderWith }
}

const rowAt = (index: number) => document.querySelector(`[data-testid="backlog-row"][data-index="${index}"]`) as HTMLElement
const within$ = (index: number) => within(rowAt(index))
const tick = () => act(async () => { await Promise.resolve() })

describe('BacklogView rows', () => {
  test('renders a row per item at its own index, with date, project, title and context', () => {
    setup()

    expect(screen.getAllByTestId('backlog-row')).toHaveLength(3)
    expect(within$(0).getByTestId('backlog-row-date')).toHaveTextContent('2026-08-20')
    expect(within$(0).getByTestId('backlog-row-project')).toHaveTextContent('acme-api')
    expect(within$(0).getByTestId('backlog-row-title')).toHaveTextContent('First')
    expect(rowAt(0).querySelector('.backlog-row-context')).toHaveTextContent('some context')
    expect(rowAt(1).querySelector('.backlog-row-project')).toBeNull()
    expect(rowAt(1).querySelector('.backlog-row-context')).toBeNull()
  })

  test('every row button carries its row\'s index, which the specs and the server routes address it by', () => {
    setup({ isCanonical: true })

    for (const testId of ['backlog-edit-btn', 'backlog-dismiss-btn', 'backlog-play-btn', 'backlog-select-checkbox']) {
      expect(within$(2).getByTestId(testId)).toHaveAttribute('data-index', '2')
    }
  })

  test('a shelved row\'s Resume button carries its index too', () => {
    setup({ backlog: [item('a'), item('Shelved', { shelvedSlug: 'old-task' })] })
    expect(within$(1).getByTestId('backlog-resume-btn')).toHaveAttribute('data-index', '1')
  })

  test('a filtered list keeps each surviving row\'s original index', () => {
    setup({ rows: visibleBacklogRows(ITEMS, new Set(['acme-web'])) })

    expect(screen.getAllByTestId('backlog-row')).toHaveLength(1)
    expect(rowAt(2)).toBeInTheDocument()
  })

  test('an empty list renders the shared empty state', () => {
    setup({ rows: [], backlog: [] })
    expect(screen.getByTestId('board-empty-state')).toBeInTheDocument()
  })

  test('a done item has no checkbox and no edit or run button, but can still be waived', () => {
    setup({ backlog: [item('Old', { done: true })] })

    expect(within$(0).queryByTestId('backlog-select-checkbox')).toBeNull()
    expect(within$(0).queryByTestId('backlog-edit-btn')).toBeNull()
    expect(within$(0).queryByTestId('backlog-play-btn')).toBeNull()
    expect(within$(0).getByTestId('backlog-dismiss-btn')).toBeInTheDocument()
    expect(within$(0).getByTestId('backlog-card')).toHaveClass('is-done')
  })

  test('a shelved item shows its badge and Resume instead of a checkbox and Run', () => {
    setup({ backlog: [item('Shelved', { shelvedSlug: 'old-task' })] })

    expect(within$(0).getByTestId('backlog-shelved-badge')).toHaveTextContent('shelved: old-task')
    expect(rowAt(0)).toHaveAttribute('data-shelved-slug', 'old-task')
    expect(within$(0).queryByTestId('backlog-select-checkbox')).toBeNull()
    expect(within$(0).queryByTestId('backlog-play-btn')).toBeNull()
    expect(within$(0).getByTestId('backlog-resume-btn')).toBeInTheDocument()
  })

  test('clicking a shelved row\'s body opens its task, but clicking a button inside it does not', () => {
    const { onOpenTask } = setup({ backlog: [item('Shelved', { shelvedSlug: 'old-task' })] })

    fireEvent.click(within$(0).getByTestId('backlog-row-title'))
    expect(onOpenTask).toHaveBeenCalledWith('old-task')

    onOpenTask.mockClear()
    fireEvent.click(within$(0).getByTestId('backlog-dismiss-btn'))
    expect(onOpenTask).not.toHaveBeenCalled()
  })

  test('an ordinary row is not clickable, since no task directory stands behind it', () => {
    const { onOpenTask } = setup()
    fireEvent.click(within$(1).getByTestId('backlog-row-title'))
    expect(onOpenTask).not.toHaveBeenCalled()
  })
})

describe('BacklogView selection and the batch bar', () => {
  test('ticking rows opens the bar with the live count, and Clear unticks them all', () => {
    setup()
    expect(screen.getByTestId('backlog-batch-bar')).not.toHaveClass('is-open')

    fireEvent.click(within$(0).getByTestId('backlog-select-checkbox'))
    fireEvent.click(within$(2).getByTestId('backlog-select-checkbox'))

    expect(screen.getByTestId('backlog-batch-bar')).toHaveClass('is-open')
    expect(screen.getByTestId('backlog-selected-count-num')).toHaveTextContent('2')
    expect(screen.getByTestId('backlog-run-selected-btn')).toHaveTextContent(/^Run batch \(2\)$/)
    expect(screen.getByTestId('backlog-delete-selected-count')).toHaveTextContent('2')

    fireEvent.click(screen.getByTestId('backlog-clear-selected-btn'))

    expect(within$(0).getByTestId('backlog-select-checkbox')).not.toBeChecked()
    expect(screen.getByTestId('backlog-batch-bar')).not.toHaveClass('is-open')
  })

  test('a selection follows its item by description when the list is reordered', () => {
    const { rerenderWith } = setup()
    fireEvent.click(within$(0).getByTestId('backlog-select-checkbox'))

    rerenderWith({ backlog: [ITEMS[1], ITEMS[0], ITEMS[2]] })

    expect(within$(1).getByTestId('backlog-row-title')).toHaveTextContent('First')
    expect(within$(1).getByTestId('backlog-select-checkbox')).toBeChecked()
    expect(within$(0).getByTestId('backlog-select-checkbox')).not.toBeChecked()
    expect(screen.getByTestId('backlog-selected-count-num')).toHaveTextContent('1')
  })

  test('an item removed elsewhere drops out of the count', () => {
    const { rerenderWith } = setup()
    fireEvent.click(within$(0).getByTestId('backlog-select-checkbox'))

    rerenderWith({ backlog: [ITEMS[1], ITEMS[2]] })

    expect(screen.getByTestId('backlog-selected-count-num')).toHaveTextContent('0')
    expect(screen.getByTestId('backlog-batch-bar')).not.toHaveClass('is-open')
  })

  test('a selection hidden by the filter is not counted, and returns checked when the filter clears', () => {
    const { rerenderWith } = setup()
    fireEvent.click(within$(0).getByTestId('backlog-select-checkbox'))

    rerenderWith({ rows: visibleBacklogRows(ITEMS, new Set(['acme-web'])) })
    expect(screen.getByTestId('backlog-selected-count-num')).toHaveTextContent('0')

    rerenderWith({ rows: visibleBacklogRows(ITEMS, new Set()) })
    expect(within$(0).getByTestId('backlog-select-checkbox')).toBeChecked()
    expect(screen.getByTestId('backlog-selected-count-num')).toHaveTextContent('1')
  })
})

describe('BacklogView Run', () => {
  test('is disabled with the read-only reason on a non-canonical instance', () => {
    setup({ isCanonical: false })
    const READ_ONLY = 'Read-only — this is not the canonical dashboard instance'

    expect(within$(0).getByTestId('backlog-play-btn')).toBeDisabled()
    expect(within$(0).getByTestId('backlog-play-btn')).toHaveAttribute('title', READ_ONLY)
    expect(screen.getByTestId('backlog-run-selected-btn')).toBeDisabled()
    expect(screen.getByTestId('backlog-run-selected-btn')).toHaveAttribute('title', READ_ONLY)
  })

  test('posts the item and flashes "✓ sent"', async () => {
    const { fetchImpl } = setup()

    fireEvent.click(within$(0).getByTestId('backlog-play-btn'))
    await tick()

    expect(fetchImpl).toHaveBeenCalledWith('/backlog/dispatch', expect.objectContaining({ method: 'POST' }))
    expect(within$(0).getByTestId('backlog-play-btn')).toHaveTextContent('✓ sent')
  })

  test('a failure flashes its reason, marks the button as an error, and logs', async () => {
    const { fetchImpl, log } = setup()
    fetchImpl.mockResolvedValue(response(503))

    fireEvent.click(within$(0).getByTestId('backlog-play-btn'))
    await tick()

    expect(within$(0).getByTestId('backlog-play-btn')).toHaveTextContent('no orchestrator')
    expect(within$(0).getByTestId('backlog-play-btn')).toHaveClass('btn-err')
    expect(log).toHaveBeenCalledWith('[action] POST /backlog/dispatch failed', expect.any(Error))
  })

  test('a second click while the first is in flight sends nothing more', async () => {
    let resolve!: (res: Response) => void
    const { fetchImpl } = setup()
    fetchImpl.mockReturnValue(new Promise<Response>((r) => { resolve = r }))

    fireEvent.click(within$(0).getByTestId('backlog-play-btn'))
    fireEvent.click(within$(0).getByTestId('backlog-play-btn'))
    await act(async () => { resolve(response(200)) })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('BacklogView Run batch', () => {
  test('sends one batch for the whole selection, then clears it and marks each row staged', async () => {
    const { fetchImpl } = setup()
    fireEvent.click(within$(0).getByTestId('backlog-select-checkbox'))
    fireEvent.click(within$(2).getByTestId('backlog-select-checkbox'))

    fireEvent.click(screen.getByTestId('backlog-run-selected-btn'))
    await tick()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/batch-dispatch')
    expect(JSON.parse(init.body).items.map((sent: { description: string }) => sent.description)).toEqual(['First', 'Third'])
    expect(within$(0).getByTestId('backlog-play-btn')).toHaveTextContent('staged')
    expect(within$(2).getByTestId('backlog-play-btn')).toHaveTextContent('staged')
    expect(screen.getByTestId('backlog-selected-count-num')).toHaveTextContent('0')
  })

  test('a failed batch keeps the whole selection and shows the server\'s detail on the button', async () => {
    const { fetchImpl, log } = setup()
    fetchImpl.mockResolvedValue(response(503, { error: 'tab is gone' }))
    fireEvent.click(within$(0).getByTestId('backlog-select-checkbox'))

    fireEvent.click(screen.getByTestId('backlog-run-selected-btn'))
    await tick()

    const run = screen.getByTestId('backlog-run-selected-btn')
    expect(run).toHaveClass('btn-err')
    expect(run).toHaveAttribute('title', 'tab is gone')
    expect(run).toHaveTextContent(/^Run batch \(1\)$/)
    expect(screen.getByTestId('backlog-selected-count-num')).toHaveTextContent('1')
    expect(log).toHaveBeenCalledWith('[action] POST /batch-dispatch failed', expect.any(Error))
  })

  test('sends nothing when the selection is empty', () => {
    const { fetchImpl } = setup()
    fireEvent.click(screen.getByTestId('backlog-run-selected-btn'))
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('BacklogView delete', () => {
  test('a row\'s waive opens the confirm modal with Cancel focused, and Cancel closes it without sending', () => {
    const { fetchImpl } = setup()

    fireEvent.click(within$(0).getByTestId('backlog-dismiss-btn'))

    expect(screen.getByTestId('backlog-delete-headline')).toHaveTextContent('Delete 1 backlog item?')
    expect(screen.getByTestId('backlog-delete-body')).toHaveTextContent('This removes it from the backlog permanently.')
    expect(screen.getByTestId('backlog-delete-modal')).toHaveAttribute('data-count', '1')
    expect(screen.getByTestId('backlog-delete-cancel-btn')).toHaveFocus()

    fireEvent.click(screen.getByTestId('backlog-delete-cancel-btn'))

    expect(screen.queryByTestId('backlog-delete-modal')).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('Escape and a click on the scrim itself close the modal, but a click inside the card does not', () => {
    setup()
    fireEvent.click(within$(0).getByTestId('backlog-dismiss-btn'))
    fireEvent.click(screen.getByTestId('backlog-delete-modal'))
    expect(screen.getByTestId('backlog-delete-modal')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('backlog-delete-scrim'))
    expect(screen.queryByTestId('backlog-delete-modal')).toBeNull()

    fireEvent.click(within$(0).getByTestId('backlog-dismiss-btn'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('backlog-delete-modal')).toBeNull()
  })

  test('a shelved row\'s modal says its directory and branch stay on disk', () => {
    setup({ backlog: [item('Shelved', { shelvedSlug: 'old-task' })] })

    fireEvent.click(within$(0).getByTestId('backlog-dismiss-btn'))

    expect(screen.getByTestId('backlog-delete-body')).toHaveTextContent('Its task directory (old-task) and branch stay on disk')
  })

  test('confirming removes a batch highest index first and posts each item as its own guard', async () => {
    const { fetchImpl } = setup()
    fireEvent.click(within$(0).getByTestId('backlog-select-checkbox'))
    fireEvent.click(within$(2).getByTestId('backlog-select-checkbox'))

    fireEvent.click(screen.getByTestId('backlog-delete-selected-btn'))
    expect(screen.getByTestId('backlog-delete-headline')).toHaveTextContent('Delete 2 backlog items?')
    fireEvent.click(screen.getByTestId('backlog-delete-confirm-btn'))
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(['/backlog/dismiss/2', '/backlog/dismiss/0'])
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).original.description).toBe('Third')
    expect(screen.queryByTestId('backlog-delete-modal')).toBeNull()
    await waitFor(() => expect(screen.getByTestId('backlog-selected-count-num')).toHaveTextContent('0'))
  })

  test('a failure stops the loop, marks the batch button with the reason, and logs', async () => {
    const { fetchImpl, log } = setup()
    fetchImpl.mockResolvedValue(response(409))
    fireEvent.click(within$(0).getByTestId('backlog-select-checkbox'))
    fireEvent.click(within$(2).getByTestId('backlog-select-checkbox'))

    fireEvent.click(screen.getByTestId('backlog-delete-selected-btn'))
    fireEvent.click(screen.getByTestId('backlog-delete-confirm-btn'))

    await waitFor(() => expect(screen.getByTestId('backlog-delete-selected-btn')).toHaveClass('btn-err'))
    expect(screen.getByTestId('backlog-delete-selected-btn')).toHaveAttribute('title', 'changed elsewhere — refresh')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('[action] POST /backlog/dismiss/2 failed', expect.any(Error))
    expect(screen.getByTestId('backlog-selected-count-num')).toHaveTextContent('2')
  })

  test('a failed single-row delete marks that row\'s own button', async () => {
    const { fetchImpl } = setup()
    fetchImpl.mockResolvedValue(response(500))

    fireEvent.click(within$(1).getByTestId('backlog-dismiss-btn'))
    fireEvent.click(screen.getByTestId('backlog-delete-confirm-btn'))

    await waitFor(() => expect(within$(1).getByTestId('backlog-dismiss-btn')).toHaveClass('btn-err'))
    expect(within$(1).getByTestId('backlog-dismiss-btn')).toHaveAttribute('title', 'failed')
    expect(within$(0).getByTestId('backlog-dismiss-btn')).not.toHaveClass('btn-err')
  })

  test('an item that vanished before confirming closes the dialog, so nothing is sent', async () => {
    const { fetchImpl, rerenderWith } = setup()
    fireEvent.click(within$(0).getByTestId('backlog-dismiss-btn'))

    rerenderWith({ backlog: [ITEMS[1], ITEMS[2]] })
    await tick()

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('BacklogView delete modal robustness', () => {
  test('is a labelled modal dialog', () => {
    setup()

    fireEvent.click(within$(0).getByTestId('backlog-dismiss-btn'))

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('aria-labelledby', screen.getByTestId('backlog-delete-headline').id)
  })

  test('returns focus to the button that opened it when it closes', () => {
    setup()
    const trigger = within$(0).getByTestId('backlog-dismiss-btn')
    trigger.focus()
    fireEvent.click(trigger)

    fireEvent.click(screen.getByTestId('backlog-delete-cancel-btn'))

    expect(trigger).toHaveFocus()
  })

  test('keeps Tab inside the dialog', () => {
    setup()
    fireEvent.click(within$(0).getByTestId('backlog-dismiss-btn'))
    const confirm = screen.getByTestId('backlog-delete-confirm-btn')
    confirm.focus()

    fireEvent.keyDown(confirm, { key: 'Tab' })
    expect(screen.getByTestId('backlog-delete-cancel-btn')).toHaveFocus()

    fireEvent.keyDown(screen.getByTestId('backlog-delete-cancel-btn'), { key: 'Tab', shiftKey: true })
    expect(confirm).toHaveFocus()
  })

  test('closes instead of asking "Delete 0 backlog items?" when the pending item vanishes', () => {
    const { rerenderWith } = setup()
    fireEvent.click(within$(0).getByTestId('backlog-dismiss-btn'))

    rerenderWith({ backlog: [ITEMS[1], ITEMS[2]] })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText(/Delete 0/)).toBeNull()
  })

  test('each step of a batch re-finds its item in the live list, so a shift mid-batch hits the right index', async () => {
    let resolveFirst!: (res: Response) => void
    const { fetchImpl, rerenderWith } = setup()
    fetchImpl.mockReturnValueOnce(new Promise<Response>((r) => { resolveFirst = r })).mockResolvedValue(response(200))
    fireEvent.click(within$(0).getByTestId('backlog-select-checkbox'))
    fireEvent.click(within$(2).getByTestId('backlog-select-checkbox'))
    fireEvent.click(screen.getByTestId('backlog-delete-selected-btn'))
    fireEvent.click(screen.getByTestId('backlog-delete-confirm-btn'))
    expect(fetchImpl.mock.calls[0][0]).toBe('/backlog/dismiss/2')

    // Something above index 0 is added while the first request is in flight,
    // so "First" now sits at index 1.
    rerenderWith({ backlog: [item('Newly added'), ...ITEMS.slice(0, 2)] })
    await act(async () => { resolveFirst(response(200)) })

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))
    expect(fetchImpl.mock.calls[1][0]).toBe('/backlog/dismiss/1')
  })
})

describe('BacklogView edit', () => {
  const openEdit = (index: number) => fireEvent.click(within$(index).getByTestId('backlog-edit-btn'))

  test('opens a form seeded from the item, offering every known project', () => {
    setup()

    openEdit(0)

    expect(screen.getByTestId('backlog-edit-desc-input')).toHaveValue('First')
    expect(screen.getByTestId('backlog-edit-project-input')).toHaveValue('acme-api')
    expect(screen.getByTestId('backlog-edit-context-input')).toHaveValue('some context')
    expect([...document.querySelectorAll('#backlog-project-options option')].map((option) => option.getAttribute('value'))).toEqual(['acme-api', 'acme-web'])
  })

  test('Save posts the trimmed edit with the date and original untouched, then closes the form', async () => {
    const { fetchImpl } = setup()
    openEdit(0)
    fireEvent.change(screen.getByTestId('backlog-edit-desc-input'), { target: { value: '  Renamed  ' } })
    fireEvent.change(screen.getByTestId('backlog-edit-project-input'), { target: { value: '' } })
    fireEvent.change(screen.getByTestId('backlog-edit-context-input'), { target: { value: '' } })

    fireEvent.click(screen.getByTestId('backlog-edit-save-btn'))
    await waitFor(() => expect(screen.queryByTestId('backlog-edit-form')).toBeNull())

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/backlog/edit/0')
    expect(JSON.parse(init.body)).toEqual({ description: 'Renamed', date: '2026-08-20', context: null, project: null, original: ITEMS[0] })
  })

  test('an empty description is refused before anything is sent', () => {
    const { fetchImpl } = setup()
    openEdit(0)
    fireEvent.change(screen.getByTestId('backlog-edit-desc-input'), { target: { value: '   ' } })

    fireEvent.click(screen.getByTestId('backlog-edit-save-btn'))

    expect(screen.getByTestId('backlog-edit-error')).toHaveTextContent('Description cannot be empty.')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('a refused save keeps the form and its text, shows the reason, and re-enables Save', async () => {
    const { fetchImpl, log } = setup()
    fetchImpl.mockResolvedValue(response(409))
    openEdit(0)
    fireEvent.change(screen.getByTestId('backlog-edit-desc-input'), { target: { value: 'kept' } })

    fireEvent.click(screen.getByTestId('backlog-edit-save-btn'))

    await waitFor(() => expect(screen.getByTestId('backlog-edit-error')).toHaveTextContent('This item changed elsewhere — refresh and try again.'))
    expect(screen.getByTestId('backlog-edit-desc-input')).toHaveValue('kept')
    expect(screen.getByTestId('backlog-edit-save-btn')).toBeEnabled()
    expect(log).toHaveBeenCalledWith('[action] POST /backlog/edit/0 failed', expect.any(Error))
  })

  test('Cancel closes the form without sending', () => {
    const { fetchImpl } = setup()
    openEdit(0)

    fireEvent.click(screen.getByTestId('backlog-edit-cancel-btn'))

    expect(screen.queryByTestId('backlog-edit-form')).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('what was typed survives the backlog refreshing underneath the open form', () => {
    const { rerenderWith } = setup()
    openEdit(1)
    fireEvent.change(screen.getByTestId('backlog-edit-desc-input'), { target: { value: 'half-typed' } })

    rerenderWith({ backlog: [...ITEMS] })

    expect(screen.getByTestId('backlog-edit-desc-input')).toHaveValue('half-typed')
  })
})

describe('BacklogView Resume', () => {
  const shelved = [item('Shelved', { shelvedSlug: 'old-task' })]

  test('posts the item, flashes "✓ resumed" and tells the board to follow it', async () => {
    const { fetchImpl, onResumed } = setup({ backlog: shelved })

    fireEvent.click(within$(0).getByTestId('backlog-resume-btn'))
    await tick()

    expect(fetchImpl).toHaveBeenCalledWith('/backlog/resume/0', expect.objectContaining({ method: 'POST' }))
    expect(onResumed).toHaveBeenCalledTimes(1)
    expect(within$(0).getByTestId('backlog-resume-btn')).toHaveTextContent('✓ resumed')
  })

  test('a refusal shows the server\'s message on the button and stays on the Backlog tab', async () => {
    const { fetchImpl, onResumed, log } = setup({ backlog: shelved })
    fetchImpl.mockResolvedValue(response(404, { error: 'that task directory is gone' }))

    fireEvent.click(within$(0).getByTestId('backlog-resume-btn'))
    await tick()

    expect(within$(0).getByTestId('backlog-resume-btn')).toHaveTextContent('that task directory is gone')
    expect(onResumed).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('[action] POST /backlog/resume/0 failed', expect.any(Error))
  })
})

describe('BacklogView timing', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  test('an error mark on the batch delete button clears itself', async () => {
    const { fetchImpl } = setup()
    fetchImpl.mockResolvedValue(response(500))
    fireEvent.click(within$(0).getByTestId('backlog-select-checkbox'))
    fireEvent.click(screen.getByTestId('backlog-delete-selected-btn'))
    fireEvent.click(screen.getByTestId('backlog-delete-confirm-btn'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByTestId('backlog-delete-selected-btn')).toHaveClass('btn-err')

    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })

    expect(screen.getByTestId('backlog-delete-selected-btn')).not.toHaveClass('btn-err')
  })
})
