import { beforeEach, describe, expect, test, vi, type Mock } from 'vitest'
import { ACTIVE_VIEW_STORAGE_KEY, createActiveViewStore } from './activeView'

describe('createActiveViewStore', () => {
  let storage: { getItem: Mock<(key: string) => string | null>; setItem: Mock<(key: string, value: string) => void> }
  let log: Mock<(message: string, ...args: unknown[]) => void>

  beforeEach(() => {
    storage = { getItem: vi.fn().mockReturnValue(null), setItem: vi.fn() }
    log = vi.fn()
  })

  test('defaults to cards when nothing is stored', () => {
    expect(createActiveViewStore({ storage, log }).get()).toBe('cards')
  })

  test('reads a stored table choice', () => {
    storage.getItem.mockReturnValue('table')
    expect(createActiveViewStore({ storage, log }).get()).toBe('table')
    expect(storage.getItem).toHaveBeenCalledWith(ACTIVE_VIEW_STORAGE_KEY)
  })

  test('an unrecognised stored value falls back to cards', () => {
    storage.getItem.mockReturnValue('grid')
    expect(createActiveViewStore({ storage, log }).get()).toBe('cards')
  })

  test('falls back to cards and logs when storage throws on read', () => {
    storage.getItem.mockImplementation(() => { throw new DOMException('blocked', 'SecurityError') })
    expect(createActiveViewStore({ storage, log }).get()).toBe('cards')
    expect(log).toHaveBeenCalledWith('[active-view] could not read the stored choice', expect.anything())
  })

  test('set persists the choice and notifies subscribers', () => {
    const store = createActiveViewStore({ storage, log })
    const listener = vi.fn()
    store.subscribe(listener)
    store.set('table')
    expect(store.get()).toBe('table')
    expect(storage.setItem).toHaveBeenCalledWith(ACTIVE_VIEW_STORAGE_KEY, 'table')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  test('still applies the choice to this page and logs when storage throws on write', () => {
    storage.setItem.mockImplementation(() => { throw new DOMException('blocked', 'SecurityError') })
    const store = createActiveViewStore({ storage, log })
    store.set('table')
    expect(store.get()).toBe('table')
    expect(log).toHaveBeenCalledWith('[active-view] could not persist the choice', expect.anything())
  })
})
