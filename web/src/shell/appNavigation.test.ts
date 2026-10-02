import { afterEach, describe, expect, it, vi } from 'vitest'
import { rememberBoardTab } from '../views/board/boardTabRoutes'
import { closeTaskDetail, installAppNavigator, navigateToTask, navigateToUrl } from './appNavigation'

let uninstall: (() => void) | null = null
afterEach(() => {
  uninstall?.()
  uninstall = null
  rememberBoardTab('inprogress')
})

describe('navigateToUrl', () => {
  it('hands the URL and options to the installed navigator', () => {
    const navigate = vi.fn()
    uninstall = installAppNavigator(navigate)

    navigateToUrl('/backlog', { replace: true })

    expect(navigate).toHaveBeenCalledWith('/backlog', { replace: true })
  })

  it('replaces rather than pushes when the URL is already the one showing, so Back never stalls on a duplicate', () => {
    const navigate = vi.fn()
    uninstall = installAppNavigator(navigate)
    window.history.replaceState(null, '', '/backlog?x=1')

    navigateToUrl('/backlog?x=1')
    navigateToUrl('/done')

    expect(navigate).toHaveBeenNthCalledWith(1, '/backlog?x=1', { replace: true })
    expect(navigate).toHaveBeenNthCalledWith(2, '/done', undefined)
    window.history.replaceState(null, '', '/')
  })

  it('logs instead of silently dropping the navigation when no navigator is installed', () => {
    const log = vi.fn()

    navigateToUrl('/backlog', undefined, log)

    expect(log).toHaveBeenCalledWith(expect.stringContaining('[navigation]'), '/backlog')
  })

  it('stops reaching the navigator once uninstalled', () => {
    const navigate = vi.fn()
    installAppNavigator(navigate)()
    const log = vi.fn()

    navigateToUrl('/done', undefined, log)

    expect(navigate).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalled()
  })

  it('logs and swallows a navigation that rejects, rather than leaving an unhandled rejection', async () => {
    uninstall = installAppNavigator(() => Promise.reject(new Error('blocked')))
    const log = vi.fn()

    navigateToUrl('/done', undefined, log)
    await Promise.resolve()
    await Promise.resolve()

    expect(log).toHaveBeenCalledWith(expect.stringContaining('[navigation]'), expect.any(Error))
  })
})

describe('navigateToTask', () => {
  it("navigates to the task's URL, carrying a stage when given", () => {
    const navigate = vi.fn()
    uninstall = installAppNavigator(navigate)

    navigateToTask('demo-task')
    navigateToTask('demo-task', { stage: 'result' })

    expect(navigate).toHaveBeenNthCalledWith(1, '/task/demo-task', undefined)
    expect(navigate).toHaveBeenNthCalledWith(2, '/task/demo-task?stage=result', undefined)
  })
})

describe('closeTaskDetail', () => {
  it('returns to the board tab that was last showing, not a hard-coded home', () => {
    const navigate = vi.fn()
    uninstall = installAppNavigator(navigate)
    rememberBoardTab('done')

    closeTaskDetail()

    expect(navigate).toHaveBeenCalledWith('/done', undefined)
  })
})
