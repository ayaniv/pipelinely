import { describe, expect, test, vi } from 'vitest'
import { createParentOpenStore } from './parentOpen'

describe('parentOpenStore', () => {
  test('rows start collapsed, toggle open and toggle closed', () => {
    const store = createParentOpenStore()
    expect(store.isOpen('a')).toBe(false)
    store.toggle('a')
    expect(store.isOpen('a')).toBe(true)
    store.toggle('a')
    expect(store.isOpen('a')).toBe(false)
  })

  test('rows are independent', () => {
    const store = createParentOpenStore()
    store.toggle('a')
    expect(store.isOpen('b')).toBe(false)
  })

  test('notifies subscribers on every change and stops after unsubscribe', () => {
    const store = createParentOpenStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    store.toggle('a')
    store.toggle('a')
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    store.toggle('a')
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
