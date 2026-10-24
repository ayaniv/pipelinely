import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { installAppNavigator } from '../../shell/appNavigation'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { SidebarAccount } from './SidebarAccount'

let navigate: Mock<(to: string, options?: { replace?: boolean }) => void>
let uninstallNavigator: () => void

beforeEach(() => {
  navigate = vi.fn()
  uninstallNavigator = installAppNavigator(navigate)
})
afterEach(() => uninstallNavigator())

const group = () => screen.getByTestId('sidebar-account-menu')
const account = () => screen.getByTestId('sidebar-account')
const ITEM_IDS = ['sidebar-settings-btn', 'sidebar-usage-btn', 'sidebar-docs-btn', 'sidebar-help-btn']

function renderAt(path: string, onSelectTab = vi.fn()) {
  const router = createMemoryRouter([{ path: '*', element: <SidebarAccount onSelectTab={onSelectTab} /> }], { initialEntries: [path] })
  return render(<RouterProvider router={router} />)
}

const currentItemIds = () => ITEM_IDS.filter((id) => screen.getByTestId(id).getAttribute('aria-current') === 'page')

describe('SidebarAccount', () => {
  test('starts closed: the toggle says so, and the group is inert so its items cannot be tabbed to', () => {
    renderAt('/')

    expect(account()).toHaveAttribute('aria-expanded', 'false')
    expect(group()).toHaveAttribute('data-open', 'false')
    expect(group()).toHaveAttribute('inert')
  })

  test('clicking the account row opens the group and a second click closes it, without selecting a tab', () => {
    const onSelectTab = vi.fn()
    renderAt('/', onSelectTab)

    fireEvent.click(account())
    expect(account()).toHaveAttribute('aria-expanded', 'true')
    expect(group()).toHaveAttribute('data-open', 'true')
    expect(group()).not.toHaveAttribute('inert')

    fireEvent.click(account())
    expect(group()).toHaveAttribute('data-open', 'false')
    expect(onSelectTab).not.toHaveBeenCalled()
  })

  test('holds Settings, Usage, Docs and Help, in that order, keeping the ids the specs and CSS key off', () => {
    renderAt('/')

    const items = Array.from(group().querySelectorAll<HTMLElement>('.sidebar-foot-item'))
    expect(items.map((item) => item.dataset.testid)).toEqual(['sidebar-settings-btn', 'sidebar-usage-btn', 'sidebar-docs-btn', 'sidebar-help-btn'])
    expect(items.map((item) => item.id)).toEqual(['sidebar-settings-btn', 'sidebar-usage-btn', 'sidebar-docs-btn', 'sidebar-help-btn'])
  })

  test.each([
    ['sidebar-settings-btn', '/settings'],
    ['sidebar-docs-btn', '/docs'],
    ['sidebar-help-btn', '/help'],
  ])('%s navigates to %s', (testId, url) => {
    renderAt('/')
    fireEvent.click(account())

    fireEvent.click(screen.getByTestId(testId))

    expect(navigate).toHaveBeenCalledWith(url, undefined)
  })

  test('Usage selects the Usage tab and leaves the group open', () => {
    const onSelectTab = vi.fn()
    renderAt('/', onSelectTab)
    fireEvent.click(account())

    fireEvent.click(screen.getByTestId('sidebar-usage-btn'))

    expect(onSelectTab).toHaveBeenCalledWith('usage')
    expect(group()).toHaveAttribute('data-open', 'true')
    expect(account()).toHaveAttribute('aria-expanded', 'true')
  })

  test.each([
    ['/usage', 'sidebar-usage-btn'],
    ['/settings', 'sidebar-settings-btn'],
    ['/docs', 'sidebar-docs-btn'],
    ['/help', 'sidebar-help-btn'],
  ])('on %s only %s is the current page', (path, itemId) => {
    renderAt(path)

    expect(currentItemIds()).toEqual([itemId])
    expect(screen.getByTestId(itemId)).toHaveClass('is-active')
  })

  test.each(['/', '/done', '/backlog', '/task/some-slug'])('on %s no item is current and the You row is unmarked', (path) => {
    renderAt(path)

    expect(currentItemIds()).toEqual([])
    expect(account()).not.toHaveClass('is-active')
  })

  test('the You row is marked while the menu is closed on /usage, and unmarked once the menu opens', () => {
    renderAt('/usage')
    expect(account()).toHaveClass('is-active')

    fireEvent.click(account())
    expect(account()).not.toHaveClass('is-active')

    fireEvent.click(account())
    expect(account()).toHaveClass('is-active')
  })

  test.each(['/settings', '/docs', '/help'])('the You row stays unmarked on %s even with the menu closed', (path) => {
    renderAt(path)

    expect(group()).toHaveAttribute('data-open', 'false')
    expect(account()).not.toHaveClass('is-active')
  })

  test('clicking Usage while already on /usage keeps the menu open and Usage current', () => {
    const onSelectTab = vi.fn()
    renderAt('/usage', onSelectTab)
    fireEvent.click(account())

    fireEvent.click(screen.getByTestId('sidebar-usage-btn'))

    expect(group()).toHaveAttribute('data-open', 'true')
    expect(currentItemIds()).toEqual(['sidebar-usage-btn'])
  })

  test('a navigation that has nowhere to go is logged by the shared navigator, not swallowed', () => {
    uninstallNavigator()
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    renderAt('/')
    fireEvent.click(account())

    fireEvent.click(screen.getByTestId('sidebar-settings-btn'))

    expect(log).toHaveBeenCalledWith('[navigation] no navigator installed — navigation dropped', '/settings')
    log.mockRestore()
  })
})
