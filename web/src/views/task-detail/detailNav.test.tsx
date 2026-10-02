import type { ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { makeMilestone, makeTask } from '../../testing/makeTask'
import { useTaskDetailNav, useTaskDetailNavState, TaskDetailNavProvider } from './detailNav'

const wrapperAt = (url: string) => ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>

function renderNav(task = makeTask(), url = '/task/demo-task') {
  return renderHook(() => ({ api: useTaskDetailNavState(task), location: useLocation() }), { wrapper: wrapperAt(url) })
}

describe('useTaskDetailNavState', () => {
  it('opens a parent already in dev on the Dev tab, and any other on Plan', () => {
    expect(renderNav(makeTask({ stage: 'dev' })).result.current.api.nav.l1Tab).toBe('dev')
    expect(renderNav(makeTask({ stage: 'planning', status: 'working' })).result.current.api.nav.l1Tab).toBe('plan')
  })

  it('reads the selected stage from ?stage=, and ignores a value that is not a chain node', () => {
    expect(renderNav(makeTask(), '/task/demo-task?stage=qa').result.current.api.nav.l2Tab).toBe('qa')
    expect(renderNav(makeTask(), '/task/demo-task?stage=bogus').result.current.api.nav.l2Tab).toBeNull()
    expect(renderNav(makeTask(), '/task/demo-task?stage=result').result.current.api.nav.l2Tab).toBeNull()
    expect(renderNav(makeTask()).result.current.api.nav.l2Tab).toBeNull()
  })

  it('selecting a stage writes ?stage= by replacing the history entry, not pushing one', () => {
    const { result } = renderNav()
    act(() => result.current.api.selectStageTab('cr-fixes'))
    expect(result.current.location.search).toBe('?stage=cr-fixes')
    expect(result.current.api.nav.l2Tab).toBe('cr-fixes')
  })

  it('selecting an L1 tab switches it and leaves any milestone drill-down', () => {
    const task = makeTask({ stage: 'dev', milestones: [makeMilestone({ id: 'M0' })] })
    const { result } = renderNav(task)
    act(() => result.current.api.selectMilestone('M0'))
    expect(result.current.api.nav.milestoneId).toBe('M0')

    act(() => result.current.api.selectL1Tab('plan-review'))

    expect(result.current.api.nav).toMatchObject({ l1Tab: 'plan-review', milestoneId: null })
  })

  it("selecting a milestone drops the previous milestone's stage selection from the URL", () => {
    const task = makeTask({ milestones: [makeMilestone({ id: 'M0' }), makeMilestone({ id: 'M1' })] })
    const { result } = renderNav(task, '/task/demo-task?stage=qa')

    act(() => result.current.api.selectMilestone('M1'))

    expect(result.current.location.search).toBe('')
    expect(result.current.api.nav).toMatchObject({ milestoneId: 'M1', l2Tab: null })
  })

  it('leaving a milestone returns to the milestone list', () => {
    const task = makeTask({ milestones: [makeMilestone({ id: 'M0' })] })
    const { result } = renderNav(task)
    act(() => result.current.api.selectMilestone('M0'))
    act(() => result.current.api.leaveMilestone())
    expect(result.current.api.nav.milestoneId).toBeNull()
  })

  it('treats a milestone the plan no longer declares as no drill-down at all', () => {
    const { result, rerender } = renderHook(({ task }) => useTaskDetailNavState(task), {
      wrapper: wrapperAt('/task/demo-task'),
      initialProps: { task: makeTask({ milestones: [makeMilestone({ id: 'M0' })] }) },
    })
    act(() => result.current.selectMilestone('M0'))
    expect(result.current.nav.milestoneId).toBe('M0')

    rerender({ task: makeTask({ milestones: [] }) })

    expect(result.current.nav.milestoneId).toBeNull()
  })
})

describe('useTaskDetailNav', () => {
  it('returns what the provider supplies', () => {
    const api = { nav: { l1Tab: 'dev' as const, l2Tab: null, milestoneId: null }, selectL1Tab: () => {}, selectStageTab: () => {}, selectMilestone: () => {}, leaveMilestone: () => {} }
    const { result } = renderHook(() => useTaskDetailNav(), { wrapper: ({ children }) => <TaskDetailNavProvider value={api}>{children}</TaskDetailNavProvider> })
    expect(result.current).toBe(api)
  })

  it('fails loudly when used outside a task detail, instead of returning a silent default', () => {
    expect(() => renderHook(() => useTaskDetailNav())).toThrow(/TaskDetailNavProvider/)
  })
})
