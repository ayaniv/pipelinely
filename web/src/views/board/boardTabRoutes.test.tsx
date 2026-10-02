import { afterEach, describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider, useNavigate } from 'react-router'
import { act } from 'react'
import { SHELL_ROUTES } from '../../shell/routes'
import { BOARD_TABS, DEFAULT_BOARD_TAB, boardTabUrl, matchBoardTab, rememberBoardTab, rememberedBoardTabUrl, useActiveBoardTab } from './boardTabRoutes'

describe('board tab routes', () => {
  test('every board tab is a server shell route, so a cold load or shared link resolves', () => {
    const shellIds = SHELL_ROUTES.map((route) => route.id as string)
    for (const tab of BOARD_TABS) expect(shellIds, `no shell route for tab '${tab}'`).toContain(tab)
  })

  test('the default tab lives at bare "/" and every other tab at its own path', () => {
    expect(DEFAULT_BOARD_TAB).toBe('inprogress')
    expect(boardTabUrl('inprogress')).toBe('/')
    expect(boardTabUrl('backlog')).toBe('/backlog')
    expect(boardTabUrl('done')).toBe('/done')
    expect(boardTabUrl('you')).toBe('/you')
  })

  test.each([
    ['/', 'inprogress'],
    ['/backlog', 'backlog'],
    ['/done', 'done'],
    ['/you', 'you'],
    ['/you/', 'you'],
  ])('%s is the %s tab', (pathname, tab) => {
    expect(matchBoardTab(pathname)).toBe(tab)
  })

  test.each(['/settings', '/help', '/docs', '/task/some-slug', '/nowhere', '/inprogress'])('%s is not a board tab route', (pathname) => {
    expect(matchBoardTab(pathname)).toBeNull()
  })
})

function ActiveTabProbe() {
  const activeTab = useActiveBoardTab()
  const navigate = useNavigate()
  return (
    <>
      <span data-testid="active-tab">{activeTab}</span>
      <button data-testid="go" onClick={() => navigate('/settings')} />
    </>
  )
}

function renderAt(path: string) {
  const router = createMemoryRouter([{ path: '*', element: <ActiveTabProbe /> }], { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

describe('useActiveBoardTab', () => {
  test('follows a board tab route', async () => {
    const router = renderAt('/done')
    expect(screen.getByTestId('active-tab')).toHaveTextContent('done')

    await act(() => router.navigate('/backlog'))
    expect(screen.getByTestId('active-tab')).toHaveTextContent('backlog')
  })

  test('keeps the last tab while a non-tab page (settings, a task) is open', async () => {
    const router = renderAt('/done')

    await act(() => router.navigate('/settings'))
    expect(screen.getByTestId('active-tab')).toHaveTextContent('done')

    await act(() => router.navigate('/task/x'))
    expect(screen.getByTestId('active-tab')).toHaveTextContent('done')
  })

  test('starts on the default tab when the first URL is not a tab route', () => {
    renderAt('/settings')
    expect(screen.getByTestId('active-tab')).toHaveTextContent('inprogress')
  })
})

describe('remembered board tab', () => {
  afterEach(() => rememberBoardTab(DEFAULT_BOARD_TAB))

  test('defaults to the Active tab\'s URL', () => {
    expect(rememberedBoardTabUrl()).toBe('/')
  })

  test('the hook records the tab it shows, and keeps it while a non-tab page is open', async () => {
    const router = renderAt('/done')
    expect(rememberedBoardTabUrl()).toBe('/done')

    await act(() => router.navigate('/settings'))
    expect(rememberedBoardTabUrl()).toBe('/done')

    await act(() => router.navigate('/backlog'))
    expect(rememberedBoardTabUrl()).toBe('/backlog')
  })
})
