import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { createPortal } from 'react-dom'
import { AppFrame } from './AppFrame'
import { installAppNavigator } from './appNavigation'
import { sidebarStore } from './sidebarState'
import type { BoardTab } from '../views/board/boardTabRoutes'

function renderFrame(activeTab: BoardTab = 'inprogress', slots: React.ReactNode = null, children: React.ReactNode = null) {
  return render(<AppFrame activeTab={activeTab} slots={slots}>{children}</AppFrame>)
}

let navigate: Mock<(to: string, options?: { replace?: boolean }) => void>
let uninstallNavigator: () => void

beforeEach(() => {
  navigate = vi.fn()
  uninstallNavigator = installAppNavigator(navigate)
  sidebarStore.setCollapsed(false)
  sidebarStore.closeMobile()
})

afterEach(() => {
  uninstallNavigator()
  sidebarStore.setCollapsed(false)
  sidebarStore.closeMobile()
})

describe('AppFrame sidebar collapse', () => {
  test('the collapse button toggles it and flips both labels', () => {
    renderFrame()
    const button = screen.getByTestId('sidebar-collapse-toggle')
    expect(screen.getByTestId('app-sidebar')).not.toHaveClass('is-collapsed')
    expect(button).toHaveAttribute('aria-label', 'Collapse sidebar')

    fireEvent.click(button)

    expect(screen.getByTestId('app-sidebar')).toHaveClass('is-collapsed')
    expect(button).toHaveAttribute('aria-label', 'Expand sidebar')
    expect(screen.getByTestId('sidebar-mark')).toHaveAttribute('aria-label', 'Expand sidebar')
  })

  test('the app mark is a second toggle, by click and by Enter or Space', () => {
    renderFrame()
    const mark = screen.getByTestId('sidebar-mark')

    fireEvent.click(mark)
    expect(screen.getByTestId('app-sidebar')).toHaveClass('is-collapsed')
    fireEvent.keyDown(mark, { key: 'Enter' })
    expect(screen.getByTestId('app-sidebar')).not.toHaveClass('is-collapsed')
    fireEvent.keyDown(mark, { key: ' ' })
    expect(screen.getByTestId('app-sidebar')).toHaveClass('is-collapsed')
  })

  test('another key on the mark does nothing', () => {
    renderFrame()
    fireEvent.keyDown(screen.getByTestId('sidebar-mark'), { key: 'a' })
    expect(screen.getByTestId('app-sidebar')).not.toHaveClass('is-collapsed')
  })

  test('starts collapsed when the store says so (a page opened on a task)', () => {
    sidebarStore.setCollapsed(true)
    renderFrame()
    expect(screen.getByTestId('app-sidebar')).toHaveClass('is-collapsed')
  })
})

describe('AppFrame mobile drawer', () => {
  test('the hamburger opens it, the scrim closes it', () => {
    renderFrame()
    fireEvent.click(screen.getByTestId('sidebar-open-toggle'))
    expect(screen.getByTestId('app-sidebar')).toHaveClass('is-mobile-open')
    expect(screen.getByTestId('sidebar-scrim')).toHaveClass('is-visible')

    fireEvent.click(screen.getByTestId('sidebar-scrim'))
    expect(screen.getByTestId('app-sidebar')).not.toHaveClass('is-mobile-open')
    expect(screen.getByTestId('sidebar-scrim')).not.toHaveClass('is-visible')
  })

  test('closing it through the store (a tab pick) closes the drawer', () => {
    renderFrame()
    fireEvent.click(screen.getByTestId('sidebar-open-toggle'))
    act(() => sidebarStore.closeMobile())
    expect(screen.getByTestId('app-sidebar')).not.toHaveClass('is-mobile-open')
  })
})

describe('AppFrame filter row', () => {
  test('is hidden until the toggle reveals it, and the toggle reports its state', () => {
    renderFrame()
    const toggle = screen.getByTestId('filter-toggle-btn')
    expect(screen.getByTestId('board-filters')).toHaveAttribute('hidden')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(toggle)
    expect(screen.getByTestId('board-filters')).not.toHaveAttribute('hidden')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveClass('is-active')

    fireEvent.click(toggle)
    expect(screen.getByTestId('board-filters')).toHaveAttribute('hidden')
    expect(toggle).not.toHaveClass('is-active')
  })
})

describe('AppFrame tab panels', () => {
  test.each([
    ['inprogress', 'active-sessions'],
    ['backlog', 'backlog-section'],
    ['done', 'done-section'],
    ['you', 'you-section'],
  ] as const)('the %s tab activates exactly its own panel and is recorded on the board', (tab, panelTestId) => {
    renderFrame(tab)
    const panels = ['active-sessions', 'backlog-section', 'done-section', 'you-section']

    for (const id of panels) {
      if (id === panelTestId) expect(screen.getByTestId(id)).toHaveClass('is-active')
      else expect(screen.getByTestId(id)).not.toHaveClass('is-active')
    }
    expect(screen.getByTestId('board-column')).toHaveAttribute('data-active-tab', tab)
  })

  test('switching the active tab moves the class', () => {
    const { rerender } = renderFrame('backlog')
    rerender(<AppFrame activeTab="done" slots={null}>{null}</AppFrame>)
    expect(screen.getByTestId('done-section')).toHaveClass('is-active')
    expect(screen.getByTestId('backlog-section')).not.toHaveClass('is-active')
  })
})

describe('AppFrame mounting order', () => {
  // Views look their container up by id while rendering, so they must not
  // render until the frame's own DOM exists.
  function ContainerProbe({ onRender }: { onRender: (containers: (HTMLElement | null)[]) => void }) {
    onRender([document.getElementById('tab-bar'), document.getElementById('header-back-slot'), document.getElementById('active-cards')])
    return null
  }

  test('slots and children render only once the frame containers exist', () => {
    const seen: (HTMLElement | null)[][] = []
    renderFrame('inprogress', <ContainerProbe onRender={(c) => seen.push(c)} />, <ContainerProbe onRender={(c) => seen.push(c)} />)

    expect(seen.length).toBeGreaterThan(0)
    for (const containers of seen) for (const container of containers) expect(container).not.toBeNull()
  })

  test('children land inside the main column, after the board, and slots can portal into the frame', () => {
    renderFrame('inprogress', <SlotPortal />, <div data-testid="route-content" />)
    expect(screen.getByTestId('board-column').parentElement).toContainElement(screen.getByTestId('route-content'))
    expect(screen.getByTestId('tab-bar')).toContainElement(screen.getByTestId('portalled'))
  })
})

function SlotPortal() {
  return createPortal(<span data-testid="portalled" />, document.getElementById('tab-bar')!)
}

describe('AppFrame footer navigation', () => {
  test.each([
    ['sidebar-settings-btn', '/settings'],
    ['sidebar-docs-btn', '/docs'],
    ['sidebar-help-btn', '/help'],
  ])('%s navigates to %s', (testId, url) => {
    renderFrame()
    fireEvent.click(screen.getByTestId(testId))
    expect(navigate).toHaveBeenCalledWith(url, undefined)
  })
})
