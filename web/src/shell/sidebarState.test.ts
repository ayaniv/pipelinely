import { describe, expect, it, vi } from 'vitest'
import { createSidebarStore } from './sidebarState'

describe('sidebar store', () => {
  it('starts expanded with the drawer closed', () => {
    expect(createSidebarStore().get()).toEqual({ isCollapsed: false, isMobileOpen: false })
  })

  it('collapses and expands independently of the mobile drawer', () => {
    const store = createSidebarStore()
    store.toggleCollapsed()
    store.openMobile()
    expect(store.get()).toEqual({ isCollapsed: true, isMobileOpen: true })
    store.toggleCollapsed()
    expect(store.get()).toEqual({ isCollapsed: false, isMobileOpen: true })
    store.closeMobile()
    expect(store.get()).toEqual({ isCollapsed: false, isMobileOpen: false })
  })

  it('takes its starting collapse from the route the page opened on', () => {
    const store = createSidebarStore()
    store.setCollapsed(true)
    expect(store.get().isCollapsed).toBe(true)
  })

  it('notifies subscribers, but not about a change that changes nothing', () => {
    const store = createSidebarStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.toggleCollapsed()
    expect(listener).toHaveBeenCalledTimes(1)
    store.closeMobile()
    store.closeMobile()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
