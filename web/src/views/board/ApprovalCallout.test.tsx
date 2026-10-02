import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ApprovalPrompt } from '../../../../src/approvalPrompt'
import type { Logger } from '../../log'
import { ERROR_FLASH_MS } from '../../components/useActionFlash'
import { ApprovalCallout } from './ApprovalCallout'

const PROMPT: ApprovalPrompt = {
  session: 'worker-foo-cr2',
  question: 'Do you want to proceed?',
  summary: 'Bash command — npm test',
  options: [{ number: 1, label: 'Yes' }, { number: 2, label: 'Yes, and don\'t ask again for npm test commands in ~/worktrees/answer-demo' }, { number: 3, label: 'No' }],
  fingerprint: '0123456789abcdef',
}
const NEXT_DIALOG: ApprovalPrompt = { ...PROMPT, question: 'Do you want to make this edit?', fingerprint: 'fedcba9876543210' }
const UNCONFIRMED_BODY = { outcome: 'unconfirmed', error: 'The key was sent, but the dialog is still showing. Check the terminal.' }
const DIALOG_CHANGED_BODY = { reason: 'dialog-changed', error: 'The dialog changed since you last saw it, so nothing was sent.' }

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let fetchImpl: ReturnType<typeof vi.fn>
let log: ReturnType<typeof vi.fn<Logger>>

function callout(prompt: ApprovalPrompt) {
  return <ApprovalCallout slug="foo" prompt={prompt} fetchImpl={fetchImpl as unknown as typeof fetch} log={log} />
}

function renderCallout(prompt: ApprovalPrompt = PROMPT) {
  return render(callout(prompt))
}

function allOptions() {
  return screen.getAllByTestId('card-approval-option')
}

function heldFetch() {
  let resolveFetch: (res: Response) => void = () => {}
  fetchImpl.mockReturnValue(new Promise<Response>((resolve) => { resolveFetch = resolve }))
  return (res: Response) => resolveFetch(res)
}

function optionButton(key: string) {
  return screen.getAllByTestId('card-approval-option').find((button) => button.getAttribute('data-key') === key)!
}

beforeEach(() => {
  fetchImpl = vi.fn()
  log = vi.fn<Logger>()
})

describe('ApprovalCallout', () => {
  test('names the state, the summary and the session the dialog is in', () => {
    renderCallout()

    expect(screen.getByTestId('card-approval')).toHaveAttribute('data-session', 'worker-foo-cr2')
    expect(screen.getByTestId('card-approval-label')).toHaveTextContent('Needs you: waiting for approval')
    expect(screen.getByTestId('card-approval-summary')).toHaveTextContent('Bash command — npm test')
  })

  test('shows the full summary in the row itself, not behind a hover title', () => {
    renderCallout()
    expect(screen.getByTestId('card-approval-summary').textContent).toBe(PROMPT.summary)
    expect(screen.getByTestId('card-approval-summary')).not.toHaveAttribute('title')
  })

  describe('before any click', () => {
    test('shows the dialog question', () => {
      renderCallout()
      expect(screen.getByTestId('card-approval-question')).toHaveTextContent('Do you want to proceed?')
    })

    test('shows one button per option in order, then Cancel last, each with its key', () => {
      renderCallout()

      const buttons = screen.getAllByTestId('card-approval-option')
      expect(buttons.map((button) => button.getAttribute('data-key'))).toEqual(['1', '2', '3', 'Escape'])
      expect(within(buttons[0]).getByTestId('card-approval-option-key')).toHaveTextContent('1')
      expect(within(buttons[0]).getByTestId('card-approval-option-label')).toHaveTextContent('Yes')
      expect(within(buttons[3]).getByTestId('card-approval-option-key')).toHaveTextContent('Esc')
      expect(within(buttons[3]).getByTestId('card-approval-option-label')).toHaveTextContent('Cancel')
    })

    test('shows a long label in full, not behind a hover title, so a persistent grant\'s scope is readable', () => {
      renderCallout()
      const label = within(optionButton('2')).getByTestId('card-approval-option-label')
      expect(label.textContent).toBe(PROMPT.options[1].label)
      expect(label).not.toHaveAttribute('title')
    })

    test('says which key a button sends and where', () => {
      renderCallout()
      expect(optionButton('2')).toHaveAttribute('title', 'Sends the key 2 to worker-foo-cr2')
      expect(optionButton('Escape')).toHaveAttribute('title', 'Sends the key Esc to worker-foo-cr2')
    })

    test('gives every button an accessible name with its key and label, and a description naming the target session', () => {
      renderCallout()
      expect(optionButton('1')).toHaveAccessibleName('Send key 1: Yes')
      expect(optionButton('Escape')).toHaveAccessibleName('Send key Esc: Cancel')
      for (const button of allOptions()) expect(button).toHaveAccessibleDescription('Sends to worker-foo-cr2')
    })

    test('groups the buttons under the question', () => {
      renderCallout()
      const group = screen.getByTestId('card-approval-options')
      expect(group).toHaveAttribute('role', 'group')
      expect(group).toHaveAttribute('aria-labelledby', screen.getByTestId('card-approval-question').id)
      expect(group).toHaveAccessibleName(PROMPT.question)
    })

    test('focuses no option by default', () => {
      renderCallout()
      for (const button of allOptions()) expect(button).not.toHaveFocus()
    })

    test('makes Cancel as prominent as the approving options: same style, none primary', () => {
      renderCallout()
      const classNames = screen.getAllByTestId('card-approval-option').map((button) => button.className)
      expect(new Set(classNames).size).toBe(1)
      expect(classNames[0]).not.toContain('btn-primary')
    })

    test('sends nothing on render, hover or focus', () => {
      renderCallout()
      fireEvent.mouseOver(optionButton('1'))
      fireEvent.focus(optionButton('1'))
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    test('shows no result line', () => {
      renderCallout()
      expect(screen.queryByTestId('card-approval-result')).toBeNull()
    })

    test('a prompt with no options still names the state but offers no buttons', () => {
      renderCallout({ ...PROMPT, options: [] })
      expect(screen.getByTestId('card-approval-label')).toBeInTheDocument()
      expect(screen.queryByTestId('card-approval-option')).toBeNull()
    })
  })

  describe('a click', () => {
    test('posts once with the prompt\'s session, the picked option and the fingerprint it rendered', async () => {
      fetchImpl.mockResolvedValue(jsonResponse(200, { outcome: 'answered' }))
      renderCallout()

      fireEvent.click(optionButton('2'))

      await waitFor(() => expect(screen.getByTestId('card-approval-result')).toHaveAttribute('data-outcome', 'answered'))
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      const [url, init] = fetchImpl.mock.calls[0]
      expect(url).toBe('/answer-dialog/foo')
      expect(JSON.parse(init.body)).toEqual({ session: 'worker-foo-cr2', option: 2, fingerprint: '0123456789abcdef' })
    })

    test('Cancel posts the cancel option', async () => {
      fetchImpl.mockResolvedValue(jsonResponse(200, { outcome: 'answered' }))
      renderCallout()

      fireEvent.click(optionButton('Escape'))

      await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
      expect(JSON.parse(fetchImpl.mock.calls[0][1].body).option).toBe('cancel')
    })

    test('marks every button disabled while the request is in flight, and a second click sends nothing', async () => {
      const resolveFetch = heldFetch()
      renderCallout()

      fireEvent.click(optionButton('1'))
      await waitFor(() => expect(optionButton('1')).toHaveAttribute('aria-disabled', 'true'))
      for (const button of allOptions()) expect(button).toHaveAttribute('aria-disabled', 'true')
      fireEvent.click(optionButton('1'))
      fireEvent.click(optionButton('3'))

      resolveFetch(jsonResponse(409, DIALOG_CHANGED_BODY))
      await waitFor(() => expect(screen.getByTestId('card-approval-result')).toBeInTheDocument())
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    test('keeps keyboard focus on the clicked button while in flight and after the response', async () => {
      const resolveFetch = heldFetch()
      renderCallout()

      optionButton('1').focus()
      fireEvent.click(optionButton('1'))
      await waitFor(() => expect(optionButton('1')).toHaveAttribute('aria-disabled', 'true'))
      expect(optionButton('1')).not.toBeDisabled()
      expect(optionButton('1')).toHaveFocus()

      resolveFetch(jsonResponse(409, DIALOG_CHANGED_BODY))
      await waitFor(() => expect(screen.getByTestId('card-approval-result')).toBeInTheDocument())
      expect(optionButton('1')).toHaveFocus()
    })

    test('re-enables the buttons after a refusal, since nothing was sent', async () => {
      fetchImpl.mockResolvedValue(jsonResponse(409, DIALOG_CHANGED_BODY))
      renderCallout()

      fireEvent.click(optionButton('1'))

      await waitFor(() => expect(screen.getByTestId('card-approval-result')).toBeInTheDocument())
      for (const button of allOptions()) expect(button).toHaveAttribute('aria-disabled', 'false')
    })

    test.each([
      ['unconfirmed', 202, UNCONFIRMED_BODY],
      ['answered', 200, { outcome: 'answered' }],
    ])('after %s (a key went out) the buttons stay locked for this dialog and a further click sends nothing', async (outcome, status, body) => {
      fetchImpl.mockResolvedValue(jsonResponse(status, body))
      renderCallout()

      fireEvent.click(optionButton('1'))
      await waitFor(() => expect(screen.getByTestId('card-approval-result')).toHaveAttribute('data-outcome', outcome))
      for (const button of allOptions()) expect(button).toHaveAttribute('aria-disabled', 'true')
      fireEvent.click(optionButton('2'))

      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    // Each of these may have typed a key: a further click on the same dialog
    // would pass the server's fingerprint check and type a second one.
    describe.each([
      ['send-failed', () => fetchImpl.mockResolvedValue(jsonResponse(502, { reason: 'send-failed', error: 'Sending the key may have failed, so check the terminal before answering again: timed out' }))],
      ['internal', () => fetchImpl.mockResolvedValue(jsonResponse(500, { reason: 'internal', error: 'Answering failed unexpectedly, so it is unknown whether a key was sent. Check the terminal.' }))],
      ['no-server', () => fetchImpl.mockRejectedValue(new TypeError('Failed to fetch'))],
      ['an unreadable 200', () => fetchImpl.mockResolvedValue(new Response('<html>', { status: 200 }))],
      ['an unreadable 500', () => fetchImpl.mockResolvedValue(new Response('<html>', { status: 500 }))],
      ['an unknown reason', () => fetchImpl.mockResolvedValue(jsonResponse(409, { reason: 'made-up', error: 'Huh.' }))],
    ])('after %s (unknown whether a key went out)', (_case, mockFetch) => {
      beforeEach(() => {
        vi.useFakeTimers()
        mockFetch()
      })
      afterEach(() => {
        vi.useRealTimers()
      })

      test('a second click, after the error flash would have ended, sends nothing', async () => {
        renderCallout()
        fireEvent.click(optionButton('1'))
        await vi.waitFor(() => expect(screen.getByTestId('card-approval-result')).toBeInTheDocument())

        await act(async () => { await vi.advanceTimersByTimeAsync(ERROR_FLASH_MS * 2) })
        fireEvent.click(optionButton('1'))
        fireEvent.click(optionButton('2'))
        await act(async () => { await vi.advanceTimersByTimeAsync(0) })

        expect(fetchImpl).toHaveBeenCalledTimes(1)
        for (const button of allOptions()) expect(button).toHaveAttribute('aria-disabled', 'true')
      })

      test('keeps saying to check the terminal until the dialog changes', async () => {
        renderCallout()
        fireEvent.click(optionButton('1'))
        await vi.waitFor(() => expect(screen.getByTestId('card-approval-result')).toBeInTheDocument())

        await act(async () => { await vi.advanceTimersByTimeAsync(ERROR_FLASH_MS * 2) })

        expect(screen.getByTestId('card-approval-result')).toHaveTextContent(/check the terminal/i)
      })
    })

    test('a new dialog unlocks the buttons after an unconfirmed send', async () => {
      fetchImpl.mockResolvedValue(jsonResponse(202, UNCONFIRMED_BODY))
      const { rerender } = renderCallout()
      fireEvent.click(optionButton('1'))
      await waitFor(() => expect(screen.getByTestId('card-approval-result')).toBeInTheDocument())

      rerender(callout(NEXT_DIALOG))

      for (const button of allOptions()) expect(button).toHaveAttribute('aria-disabled', 'false')
    })
  })

  describe('the outcome line', () => {
    test('belongs to the dialog it answered: a new dialog shows no earlier result', async () => {
      fetchImpl.mockResolvedValue(jsonResponse(409, DIALOG_CHANGED_BODY))
      const { rerender } = renderCallout()
      fireEvent.click(optionButton('1'))
      await waitFor(() => expect(screen.getByTestId('card-approval-result')).toBeInTheDocument())

      rerender(callout(NEXT_DIALOG))

      expect(screen.queryByTestId('card-approval-result')).toBeNull()
    })

    test('a response that lands after the dialog changed is not shown under the new dialog', async () => {
      const resolveFetch = heldFetch()
      const { rerender } = renderCallout()
      fireEvent.click(optionButton('1'))
      await waitFor(() => expect(optionButton('1')).toHaveAttribute('aria-disabled', 'true'))

      rerender(callout(NEXT_DIALOG))
      await act(async () => { resolveFetch(jsonResponse(200, { outcome: 'answered' })) })

      expect(screen.queryByTestId('card-approval-result')).toBeNull()
      for (const button of allOptions()) expect(button).toHaveAttribute('aria-disabled', 'false')
    })

    // A live region that arrives already holding its text is often not
    // announced, so the region is there, empty, before any click.
    test('lands inside a status region that was already rendered, empty, before the click', async () => {
      fetchImpl.mockResolvedValue(jsonResponse(200, { outcome: 'answered' }))
      renderCallout()
      const region = screen.getByTestId('card-approval-status')
      expect(region).toHaveAttribute('role', 'status')
      expect(region).toBeEmptyDOMElement()

      fireEvent.click(optionButton('1'))

      await waitFor(() => expect(within(region).getByTestId('card-approval-result')).toHaveAttribute('data-outcome', 'answered'))
      expect(screen.getByTestId('card-approval-status')).toBe(region)
    })

    test('answered says so', async () => {
      fetchImpl.mockResolvedValue(jsonResponse(200, { outcome: 'answered' }))
      renderCallout()
      fireEvent.click(optionButton('1'))
      await waitFor(() => expect(screen.getByTestId('card-approval-result')).toHaveAttribute('data-outcome', 'answered'))
      expect(screen.getByTestId('card-approval-result')).toHaveTextContent(/answered/i)
    })

    test('unconfirmed says the key went out but the dialog is still showing, and never says answered', async () => {
      fetchImpl.mockResolvedValue(jsonResponse(202, { outcome: 'unconfirmed', error: 'The key was sent, but the dialog is still showing. Check the terminal.' }))
      renderCallout()
      fireEvent.click(optionButton('1'))
      await waitFor(() => expect(screen.getByTestId('card-approval-result')).toHaveAttribute('data-outcome', 'unconfirmed'))
      expect(screen.getByTestId('card-approval-result')).toHaveTextContent('Check the terminal')
      expect(screen.getByTestId('card-approval-result')).not.toHaveTextContent(/^answered/i)
    })

    test('a stale dialog is reported with the server\'s sentence, as a refusal', async () => {
      fetchImpl.mockResolvedValue(jsonResponse(409, { reason: 'dialog-changed', error: 'The dialog changed since you last saw it, so nothing was sent.' }))
      renderCallout()
      fireEvent.click(optionButton('1'))
      await waitFor(() => expect(screen.getByTestId('card-approval-result')).toHaveAttribute('data-outcome', 'dialog-changed'))
      expect(screen.getByTestId('card-approval-result')).toHaveTextContent('nothing was sent')
    })

    test('another refusal shows the server\'s own sentence', async () => {
      fetchImpl.mockResolvedValue(jsonResponse(403, { reason: 'not-canonical', error: 'Only the main dashboard can answer.' }))
      renderCallout()
      fireEvent.click(optionButton('1'))
      await waitFor(() => expect(screen.getByTestId('card-approval-result')).toHaveAttribute('data-outcome', 'not-canonical'))
      expect(screen.getByTestId('card-approval-result')).toHaveTextContent('Only the main dashboard can answer.')
    })

    test('a network error says there was no answer and to check the terminal, without claiming a send', async () => {
      fetchImpl.mockRejectedValue(new Error('down'))
      renderCallout()
      fireEvent.click(optionButton('1'))
      await waitFor(() => expect(screen.getByTestId('card-approval-result')).toHaveAttribute('data-outcome', 'no-server'))
      expect(screen.getByTestId('card-approval-result')).toHaveTextContent(/check the terminal/i)
      expect(log).toHaveBeenCalled()
    })

    test('clears itself after a while', async () => {
      vi.useFakeTimers()
      try {
        fetchImpl.mockResolvedValue(jsonResponse(409, { reason: 'no-dialog', error: 'gone' }))
        renderCallout()
        fireEvent.click(optionButton('1'))
        await vi.waitFor(() => expect(screen.getByTestId('card-approval-result')).toBeInTheDocument())

        await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })

        expect(screen.queryByTestId('card-approval-result')).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })
  })
})

// jsdom does no layout, so the "readable without hovering" rule is pinned where
// it is defined. The ui spec (e2e/answer-dialog-card.spec.ts) measures it.
describe('the approval callout styles', () => {
  const css = readFileSync(path.join(process.cwd(), 'web/src/styles/app.css'), 'utf-8')
  const ruleFor = (selector: string) => css.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? ''

  test.each(['.approval-callout-summary', '.approval-answer-label'])('%s wraps instead of cutting the text off', (selector) => {
    const rule = ruleFor(selector)
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/)
    expect(rule).not.toMatch(/white-space:\s*nowrap|text-overflow:\s*ellipsis|overflow:\s*hidden/)
  })
})
