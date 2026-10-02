import { describe, expect, test, vi } from 'vitest'
import { createProjectFilterStore, selectionWithin } from './boardFilter'

describe('createProjectFilterStore', () => {
  test('starts empty, which means every project', () => {
    expect(createProjectFilterStore().getSelected().size).toBe(0)
  })

  test('toggle adds a project, and toggling it again removes it (multi-select, no "All" chip)', () => {
    const store = createProjectFilterStore()
    store.toggle('a')
    store.toggle('b')
    expect([...store.getSelected()]).toEqual(['a', 'b'])

    store.toggle('a')
    expect([...store.getSelected()]).toEqual(['b'])
    store.toggle('b')
    expect(store.getSelected().size).toBe(0)
  })

  test('prune drops selections whose project no longer exists and reports whether it changed anything', () => {
    const store = createProjectFilterStore()
    store.toggle('a')
    store.toggle('gone')

    expect(store.prune(['a', 'b'])).toBe(true)
    expect(store.getSelected().has('gone')).toBe(false)
    expect(store.getSelected().has('a')).toBe(true)

    expect(store.prune(['a', 'b'])).toBe(false)
  })

  test('getSelected returns a stable reference until something changes (useSyncExternalStore contract)', () => {
    const store = createProjectFilterStore()
    store.toggle('a')
    const first = store.getSelected()
    expect(store.getSelected()).toBe(first)
    store.toggle('b')
    expect(store.getSelected()).not.toBe(first)
  })

  test('notifies subscribers on toggle and on an effective prune, but not on a no-op prune, and unsubscribe stops it', () => {
    const store = createProjectFilterStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.toggle('a')
    expect(listener).toHaveBeenCalledTimes(1)
    store.prune(['a'])
    expect(listener).toHaveBeenCalledTimes(1)
    store.prune([])
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    store.toggle('b')
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('selectionWithin', () => {
  test('keeps only selections whose project is still on the board', () => {
    expect([...selectionWithin(new Set(['a', 'gone']), ['a', 'b'])]).toEqual(['a'])
  })

  test('a selection of only vanished projects becomes empty — every project — rather than an empty board', () => {
    expect(selectionWithin(new Set(['gone']), ['a']).size).toBe(0)
  })

  test('returns the same set when nothing was dropped, so a memoised consumer is not invalidated', () => {
    const selected = new Set(['a'])
    expect(selectionWithin(selected, ['a', 'b'])).toBe(selected)
  })
})
