import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WeeklyFocus } from './WeeklyFocus'

// The weekly-focus banner: click-to-edit free text, saved optimistically via
// POST /weekly-focus. Its two mount points belong to the app frame, so
// they're built here the way shell/AppFrame.tsx has them.

const NOW = new Date(2026, 8, 23)

beforeEach(() => {
  for (const id of ['weekly-focus-row', 'weekly-focus-dates']) {
    const el = document.createElement('div')
    el.id = id
    document.body.appendChild(el)
  }
})
afterEach(() => { document.body.innerHTML = '' })

function setup(text: string, overrides: Partial<Parameters<typeof WeeklyFocus>[0]> = {}) {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
  const log = vi.fn()
  const view = render(<WeeklyFocus text={text} now={NOW} locale="en-US" fetchImpl={fetchImpl} log={log} {...overrides} />)
  return { fetchImpl, log, ...view }
}

const editor = () => screen.getByTestId('weekly-focus-input') as HTMLTextAreaElement

describe('WeeklyFocus: display', () => {
  test('shows the saved text, and a placeholder styled as empty when there is none', () => {
    const { rerender } = setup('ship it')
    expect(screen.getByTestId('weekly-focus-text')).toHaveTextContent('ship it')
    expect(screen.getByTestId('weekly-focus-text')).not.toHaveClass('is-empty')

    rerender(<WeeklyFocus text="" now={NOW} locale="en-US" />)
    expect(screen.getByTestId('weekly-focus-text')).toHaveTextContent("Click to set this week's focus…")
    expect(screen.getByTestId('weekly-focus-text')).toHaveClass('is-empty')
  })

  test('renders the Sunday–Thursday range into its dates slot', () => {
    setup('x')
    expect(screen.getByTestId('weekly-focus-dates')).toHaveTextContent('Sep 20 – Sep 24')
  })
})

describe('WeeklyFocus: editing', () => {
  test('clicking opens an editor seeded with the current text and focused', () => {
    setup('ship it')
    fireEvent.click(screen.getByTestId('weekly-focus-text'))

    expect(editor()).toHaveValue('ship it')
    expect(editor()).toHaveFocus()
    expect(screen.queryByTestId('weekly-focus-text')).not.toBeInTheDocument()
  })

  test('Enter saves the trimmed text and shows it immediately', async () => {
    const { fetchImpl } = setup('old')
    fireEvent.click(screen.getByTestId('weekly-focus-text'))
    fireEvent.change(editor(), { target: { value: '  new focus  ' } })
    fireEvent.keyDown(editor(), { key: 'Enter' })

    expect(screen.getByTestId('weekly-focus-text')).toHaveTextContent('new focus')
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    expect(fetchImpl).toHaveBeenCalledWith('/weekly-focus', expect.objectContaining({ body: JSON.stringify({ text: 'new focus' }) }))
  })

  test('Shift+Enter is not a save — it stays a multi-line editor', () => {
    const { fetchImpl } = setup('old')
    fireEvent.click(screen.getByTestId('weekly-focus-text'))
    fireEvent.keyDown(editor(), { key: 'Enter', shiftKey: true })

    expect(editor()).toBeInTheDocument()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('blurring the editor saves it', async () => {
    const { fetchImpl } = setup('old')
    fireEvent.click(screen.getByTestId('weekly-focus-text'))
    fireEvent.change(editor(), { target: { value: 'blurred' } })
    fireEvent.blur(editor())

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('weekly-focus-text')).toHaveTextContent('blurred')
  })

  test('Escape cancels: nothing is sent, the old text returns, and the follow-up blur does not save', () => {
    const { fetchImpl } = setup('old')
    fireEvent.click(screen.getByTestId('weekly-focus-text'))
    fireEvent.change(editor(), { target: { value: 'discard me' } })
    const input = editor()
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.blur(input)

    expect(screen.getByTestId('weekly-focus-text')).toHaveTextContent('old')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('saving twice from one edit (Enter, then the blur it causes) sends one request', async () => {
    const { fetchImpl } = setup('old')
    fireEvent.click(screen.getByTestId('weekly-focus-text'))
    const input = editor()
    fireEvent.change(input, { target: { value: 'once' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
  })

  test('clearing the text saves the empty string and shows the placeholder', async () => {
    const { fetchImpl } = setup('old')
    fireEvent.click(screen.getByTestId('weekly-focus-text'))
    fireEvent.change(editor(), { target: { value: '   ' } })
    fireEvent.keyDown(editor(), { key: 'Enter' })

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledWith('/weekly-focus', expect.objectContaining({ body: JSON.stringify({ text: '' }) })))
    expect(screen.getByTestId('weekly-focus-text')).toHaveClass('is-empty')
  })
})

describe('WeeklyFocus: reconciliation with the server', () => {
  test('a new server value replaces the optimistic one', async () => {
    const { rerender } = setup('old')
    fireEvent.click(screen.getByTestId('weekly-focus-text'))
    fireEvent.change(editor(), { target: { value: 'mine' } })
    fireEvent.keyDown(editor(), { key: 'Enter' })
    expect(screen.getByTestId('weekly-focus-text')).toHaveTextContent('mine')

    rerender(<WeeklyFocus text="changed elsewhere" now={NOW} locale="en-US" />)
    expect(screen.getByTestId('weekly-focus-text')).toHaveTextContent('changed elsewhere')
  })

  test('a snapshot arriving mid-edit does not clobber the draft', () => {
    const { rerender } = setup('old')
    fireEvent.click(screen.getByTestId('weekly-focus-text'))
    fireEvent.change(editor(), { target: { value: 'typing' } })

    rerender(<WeeklyFocus text="server moved on" now={NOW} locale="en-US" />)

    expect(editor()).toHaveValue('typing')
  })

  test('a failed save reverts to the server\'s value and logs, rather than showing text that was not saved', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
    const log = vi.fn()
    setup('old', { fetchImpl, log })
    fireEvent.click(screen.getByTestId('weekly-focus-text'))
    fireEvent.change(editor(), { target: { value: 'lost' } })
    fireEvent.keyDown(editor(), { key: 'Enter' })

    await waitFor(() => expect(screen.getByTestId('weekly-focus-text')).toHaveTextContent('old'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action]'), expect.any(Error))
  })

  test('once the server has moved on, the optimistic text is gone for good — a later return to the old value shows the server\'s', async () => {
    const { rerender } = setup('old')
    fireEvent.click(screen.getByTestId('weekly-focus-text'))
    fireEvent.change(editor(), { target: { value: 'mine' } })
    fireEvent.keyDown(editor(), { key: 'Enter' })
    await waitFor(() => expect(screen.getByTestId('weekly-focus-text')).toHaveTextContent('mine'))

    rerender(<WeeklyFocus text="mine-confirmed" now={NOW} locale="en-US" />)
    rerender(<WeeklyFocus text="old" now={NOW} locale="en-US" />)

    expect(screen.getByTestId('weekly-focus-text')).toHaveTextContent('old')
  })

  test('an earlier save failing after a newer one started does not wipe the newer optimistic text', async () => {
    let failFirst: (res: Response) => void = () => {}
    const fetchImpl = vi.fn()
      .mockReturnValueOnce(new Promise<Response>((resolve) => { failFirst = resolve }))
      .mockResolvedValue(new Response(null, { status: 200 }))
    setup('old', { fetchImpl, log: vi.fn() })

    fireEvent.click(screen.getByTestId('weekly-focus-text'))
    fireEvent.change(editor(), { target: { value: 'first' } })
    fireEvent.keyDown(editor(), { key: 'Enter' })
    fireEvent.click(screen.getByTestId('weekly-focus-text'))
    fireEvent.change(editor(), { target: { value: 'second' } })
    fireEvent.keyDown(editor(), { key: 'Enter' })

    failFirst(new Response(null, { status: 500 }))
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.getByTestId('weekly-focus-text')).toHaveTextContent('second')
  })
})
