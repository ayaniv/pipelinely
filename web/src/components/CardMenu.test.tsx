import { describe, expect, test, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CardMenu, placeMenu } from './CardMenu'
import type { Task } from '../../../src/types'

// Menu open/closed is local React state: only one card's menu is ever being
// interacted with, so nothing needs a shared "which menu is open".

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    slug: 'demo-task', title: 'Demo task', mode: 'implement', repo: 'r', branch: 'claude/demo-task',
    worktree: null, devUrl: null, verifier: null, itermSessionId: null, tmuxSession: null, plan: null,
    stageHistory: [], stage: 'dev', findings: [], findingsParseMismatch: [], qaFailures: [], qaCases: [],
    qaCasesParseMismatch: [], showsOnBoard: true, attentionStatus: 'working', autoModeOverride: 'inherit',
    autoMode: true, status: 'working', updatedAt: new Date(), completedAt: null, completedAtSource: null,
    totalInputTokens: 0, totalOutputTokens: 0, sessions: [], ...overrides,
  } as Task
}

afterEach(() => vi.restoreAllMocks())

describe('CardMenu: Open terminal', () => {
  const openMenuAndClickFocus = (status: Task['status'], fetchImpl: typeof fetch) => {
    render(<CardMenu task={makeTask({ status })} isOffFocus={false} onToggleOffFocus={vi.fn()} fetchImpl={fetchImpl} log={vi.fn()} />)
    fireEvent.click(screen.getByTestId('card-menu-btn'))
    fireEvent.click(screen.getByTestId('card-menu-focus'))
  }

  // postFocus holds the /focus outcome labels; a bare postAction would flash "✓" or "failed" for a resume.
  test('resuming a dead paused session says it is resuming via the orchestrator', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 202 }))
    openMenuAndClickFocus('paused', fetchImpl)
    await waitFor(() => expect(screen.getByTestId('card-menu-focus')).toHaveTextContent('resuming via orchestrator'))
    expect(fetchImpl).toHaveBeenCalledWith('/focus/demo-task', { method: 'POST' })
  })

  test('a 409 tells the developer to click again', async () => {
    openMenuAndClickFocus('paused', vi.fn().mockResolvedValue(new Response(null, { status: 409 })))
    await waitFor(() => expect(screen.getByTestId('card-menu-focus')).toHaveTextContent('not ready — click again'))
  })

  test('a failed request is flashed and logged', async () => {
    const log = vi.fn()
    render(<CardMenu task={makeTask({ status: 'paused' })} isOffFocus={false} onToggleOffFocus={vi.fn()} fetchImpl={vi.fn().mockResolvedValue(new Response(null, { status: 503 }))} log={log} />)
    fireEvent.click(screen.getByTestId('card-menu-btn'))
    fireEvent.click(screen.getByTestId('card-menu-focus'))
    await waitFor(() => expect(screen.getByTestId('card-menu-focus')).toHaveTextContent('no orchestrator'))
    expect(log).toHaveBeenCalled()
  })
})

describe('CardMenu', () => {
  test('renders the closed dots button; the menu is absent until opened', () => {
    render(<CardMenu task={makeTask()} isOffFocus={false} onToggleOffFocus={vi.fn()} fetchImpl={vi.fn()} log={vi.fn()} />)
    expect(screen.getByTestId('card-menu-btn')).toBeInTheDocument()
    expect(screen.queryByTestId('card-menu')).not.toBeInTheDocument()
  })

  test('clicking the dots button opens the menu with the full item set for an open, non-shelved, non-done task with devUrl/worktree/a PR', () => {
    const task = makeTask({ devUrl: 'http://localhost:3000', worktree: '/tmp/wt', reviewRef: '42' })
    render(<CardMenu task={task} isOffFocus={false} onToggleOffFocus={vi.fn()} fetchImpl={vi.fn()} log={vi.fn()} />)

    fireEvent.click(screen.getByTestId('card-menu-btn'))

    expect(screen.getByTestId('card-menu')).toBeInTheDocument()
    expect(screen.getByTestId('card-menu-toggle-off-focus')).toHaveTextContent('Mark off focus')
    expect(screen.getByTestId('card-menu-focus')).toHaveTextContent('Open terminal')
    expect(screen.getByTestId('card-menu-browse')).toBeInTheDocument()
    expect(screen.getByTestId('card-menu-vscode')).toBeInTheDocument()
    expect(screen.getByTestId('open-pr-btn')).toBeInTheDocument()
    expect(screen.getByTestId('mark-done-btn')).toBeInTheDocument()
    expect(screen.getByTestId('shelve-btn')).toBeInTheDocument()
    expect(screen.getByTestId('card-menu-stop-session')).toBeInTheDocument()
  })

  test('an off-focus task shows "Mark in focus" instead', () => {
    render(<CardMenu task={makeTask()} isOffFocus onToggleOffFocus={vi.fn()} fetchImpl={vi.fn()} log={vi.fn()} />)
    fireEvent.click(screen.getByTestId('card-menu-btn'))
    expect(screen.getByTestId('card-menu-toggle-off-focus')).toHaveTextContent('Mark in focus')
  })

  test('a shelved task hides Open terminal, Shelve and Stop session', () => {
    render(<CardMenu task={makeTask({ status: 'shelved' })} isOffFocus={false} onToggleOffFocus={vi.fn()} fetchImpl={vi.fn()} log={vi.fn()} />)
    fireEvent.click(screen.getByTestId('card-menu-btn'))
    expect(screen.queryByTestId('card-menu-focus')).not.toBeInTheDocument()
    expect(screen.queryByTestId('shelve-btn')).not.toBeInTheDocument()
    expect(screen.queryByTestId('card-menu-stop-session')).not.toBeInTheDocument()
  })

  test('a done task hides Mark as done', () => {
    render(<CardMenu task={makeTask({ status: 'done' })} isOffFocus={false} onToggleOffFocus={vi.fn()} fetchImpl={vi.fn()} log={vi.fn()} />)
    fireEvent.click(screen.getByTestId('card-menu-btn'))
    expect(screen.queryByTestId('mark-done-btn')).not.toBeInTheDocument()
  })

  test('clicking "Mark off focus" calls onToggleOffFocus and does not close the menu', () => {
    const onToggleOffFocus = vi.fn()
    render(<CardMenu task={makeTask()} isOffFocus={false} onToggleOffFocus={onToggleOffFocus} fetchImpl={vi.fn()} log={vi.fn()} />)
    fireEvent.click(screen.getByTestId('card-menu-btn'))

    fireEvent.click(screen.getByTestId('card-menu-toggle-off-focus'))

    expect(onToggleOffFocus).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('card-menu')).toBeInTheDocument()
  })

  test('mark-done skips the confirm dialog when the task has no worktree, and flashes ok', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm')
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }))
    render(<CardMenu task={makeTask({ worktree: null })} isOffFocus={false} onToggleOffFocus={vi.fn()} fetchImpl={fetchImpl} log={vi.fn()} />)
    fireEvent.click(screen.getByTestId('card-menu-btn'))

    fireEvent.click(screen.getByTestId('mark-done-btn'))

    expect(confirmSpy).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByTestId('mark-done-btn')).toHaveClass('btn-ok'))
    expect(fetchImpl).toHaveBeenCalledWith('/mark-done/demo-task', { method: 'POST' })
  })

  test('mark-done-btn is disabled while its request is in flight, and a click while disabled sends only one request', async () => {
    let resolveFetch: (res: Response) => void = () => {}
    const fetchImpl = vi.fn().mockReturnValue(new Promise<Response>((resolve) => { resolveFetch = resolve }))
    render(<CardMenu task={makeTask({ worktree: null })} isOffFocus={false} onToggleOffFocus={vi.fn()} fetchImpl={fetchImpl} log={vi.fn()} />)
    fireEvent.click(screen.getByTestId('card-menu-btn'))
    const btn = screen.getByTestId('mark-done-btn')

    fireEvent.click(btn)
    await waitFor(() => expect(btn).toBeDisabled())
    fireEvent.click(btn)

    resolveFetch(new Response(JSON.stringify({}), { status: 200 }))
    await waitFor(() => expect(btn).not.toBeDisabled())
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('mark-done confirms first when the task has a worktree, and does nothing on cancel', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const fetchImpl = vi.fn()
    render(<CardMenu task={makeTask({ worktree: '/tmp/wt' })} isOffFocus={false} onToggleOffFocus={vi.fn()} fetchImpl={fetchImpl} log={vi.fn()} />)
    fireEvent.click(screen.getByTestId('card-menu-btn'))

    fireEvent.click(screen.getByTestId('mark-done-btn'))

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('a mark-done network failure flashes "no server" and logs [action]', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('down'))
    const log = vi.fn()
    render(<CardMenu task={makeTask({ worktree: null })} isOffFocus={false} onToggleOffFocus={vi.fn()} fetchImpl={fetchImpl} log={log} />)
    fireEvent.click(screen.getByTestId('card-menu-btn'))

    fireEvent.click(screen.getByTestId('mark-done-btn'))

    await waitFor(() => expect(screen.getByTestId('mark-done-btn')).toHaveTextContent('no server'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[action]'), expect.any(Error))
  })

  test('clicking outside the menu closes it', () => {
    render(
      <div>
        <div data-testid="outside">outside</div>
        <CardMenu task={makeTask()} isOffFocus={false} onToggleOffFocus={vi.fn()} fetchImpl={vi.fn()} log={vi.fn()} />
      </div>,
    )
    fireEvent.click(screen.getByTestId('card-menu-btn'))
    expect(screen.getByTestId('card-menu')).toBeInTheDocument()

    fireEvent.mouseDown(screen.getByTestId('outside'))

    expect(screen.queryByTestId('card-menu')).not.toBeInTheDocument()
  })

  test('pressing Escape closes the menu', () => {
    render(<CardMenu task={makeTask()} isOffFocus={false} onToggleOffFocus={vi.fn()} fetchImpl={vi.fn()} log={vi.fn()} />)
    fireEvent.click(screen.getByTestId('card-menu-btn'))
    expect(screen.getByTestId('card-menu')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByTestId('card-menu')).not.toBeInTheDocument()
  })
})

describe('CardMenu: portal and scroll rule', () => {
  const renderOpen = () => {
    render(
      <div data-testid="scroller">
        <CardMenu task={makeTask()} isOffFocus={false} onToggleOffFocus={vi.fn()} fetchImpl={vi.fn()} log={vi.fn()} />
      </div>,
    )
    fireEvent.click(screen.getByTestId('card-menu-btn'))
  }

  test('the open menu is portalled into document.body, outside the wrapper', () => {
    renderOpen()
    expect(screen.getByTestId('card-menu').parentElement).toBe(document.body)
    expect(screen.getByTestId('scroller')).not.toContainElement(screen.getByTestId('card-menu'))
  })

  test('a mousedown on a menu item does not close the menu', () => {
    renderOpen()
    fireEvent.mouseDown(screen.getByTestId('card-menu-toggle-off-focus'))
    expect(screen.getByTestId('card-menu')).toBeInTheDocument()
  })

  test('a mousedown elsewhere closes it', () => {
    renderOpen()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByTestId('card-menu')).not.toBeInTheDocument()
  })

  const moveTrigger = (topPx: number) =>
    vi.spyOn(screen.getByTestId('card-menu-btn'), 'getBoundingClientRect').mockReturnValue({ top: topPx, left: 0, bottom: topPx + 20, right: 20, width: 20, height: 20, x: 0, y: topPx, toJSON: () => ({}) })

  test('a scroll of an ancestor that moves the trigger closes the menu', () => {
    renderOpen()
    moveTrigger(80)
    fireEvent.scroll(screen.getByTestId('scroller'))
    expect(screen.queryByTestId('card-menu')).not.toBeInTheDocument()
  })

  test('a scroll that leaves the trigger where it was keeps it open', () => {
    renderOpen()
    fireEvent.scroll(screen.getByTestId('scroller'))
    expect(screen.getByTestId('card-menu')).toBeInTheDocument()
  })

  test('a scroll of an unrelated element leaves it open even if the trigger moved', () => {
    const other = document.createElement('div')
    document.body.appendChild(other)
    renderOpen()
    moveTrigger(80)
    fireEvent.scroll(other)
    expect(screen.getByTestId('card-menu')).toBeInTheDocument()
    other.remove()
  })

  test('opening moves focus to the first menu item, and Escape returns it to the trigger', () => {
    renderOpen()
    expect(screen.getByTestId('card-menu').querySelector('button')).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('card-menu')).not.toBeInTheDocument()
    expect(screen.getByTestId('card-menu-btn')).toHaveFocus()
  })

  test('closes on resize', () => {
    renderOpen()
    fireEvent(window, new Event('resize'))
    expect(screen.queryByTestId('card-menu')).not.toBeInTheDocument()
  })
})

describe('placeMenu', () => {
  const viewport = { width: 1000, height: 800 }
  const size = { width: 200, height: 300 }

  test('opens below the trigger, right-aligned to it', () => {
    expect(placeMenu({ top: 100, bottom: 130, left: 700, right: 740 }, size, viewport)).toEqual({ top: 136, left: 540 })
  })

  test('flips above when there is no room below', () => {
    expect(placeMenu({ top: 700, bottom: 730, left: 700, right: 740 }, size, viewport).top).toBe(700 - 6 - 300)
  })

  test('clamps inside the viewport horizontally', () => {
    expect(placeMenu({ top: 100, bottom: 130, left: 0, right: 40 }, size, viewport).left).toBe(8)
  })
})
