import { beforeEach, describe, expect, test, vi, type Mock } from 'vitest'
import { AUTO_SUBMIT_STORAGE_KEY, createAutoSubmitStore } from './autoSubmit'

function accessResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('createAutoSubmitStore', () => {
  let storage: { getItem: Mock<(key: string) => string | null>; setItem: Mock<(key: string, value: string) => void> }
  let log: Mock<(message: string, ...args: unknown[]) => void>

  beforeEach(() => {
    storage = { getItem: vi.fn().mockReturnValue(null), setItem: vi.fn() }
    log = vi.fn()
  })

  test('starts disabled: not remote until the probe says so', () => {
    const store = createAutoSubmitStore({ fetchImpl: vi.fn(), storage, log })
    expect(store.get()).toEqual({ isRemoteAccess: false, hasRemoteSession: false, isChoiceOn: false })
    expect(store.isEnabled()).toBe(false)
  })

  test('a stored "on" choice alone never enables it — it also needs a remote probe', async () => {
    storage.getItem.mockReturnValue('on')
    const store = createAutoSubmitStore({ fetchImpl: vi.fn().mockResolvedValue(accessResponse({ isRemoteAccess: true })), storage, log })
    expect(store.isEnabled()).toBe(false)

    await store.probeAccessContext()

    expect(store.isEnabled()).toBe(true)
  })

  test('a remote probe with the choice off is still disabled', async () => {
    const store = createAutoSubmitStore({ fetchImpl: vi.fn().mockResolvedValue(accessResponse({ isRemoteAccess: true })), storage, log })
    await store.probeAccessContext()
    expect(store.get().isRemoteAccess).toBe(true)
    expect(store.isEnabled()).toBe(false)
  })

  test('anything but a literal true stays non-remote', async () => {
    const store = createAutoSubmitStore({ fetchImpl: vi.fn().mockResolvedValue(accessResponse({ isRemoteAccess: 'yes' })), storage, log })
    await store.probeAccessContext()
    expect(store.get().isRemoteAccess).toBe(false)
  })

  test('a failed probe fails closed and is logged', async () => {
    storage.getItem.mockReturnValue('on')
    const store = createAutoSubmitStore({ fetchImpl: vi.fn().mockResolvedValue(accessResponse({}, 500)), storage, log })
    await store.probeAccessContext()
    expect(store.isEnabled()).toBe(false)
    expect(log).toHaveBeenCalledWith('[auto-submit] could not determine dashboard access context', expect.any(Error))
  })

  test('a network error fails closed and is logged', async () => {
    const store = createAutoSubmitStore({ fetchImpl: vi.fn().mockRejectedValue(new Error('down')), storage, log })
    await store.probeAccessContext()
    expect(store.get().isRemoteAccess).toBe(false)
    expect(log).toHaveBeenCalledWith('[auto-submit] could not determine dashboard access context', expect.any(Error))
  })

  test('an aborted probe (cleanup) is expected and not logged', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn().mockImplementation(() => { controller.abort(); return Promise.reject(new DOMException('aborted', 'AbortError')) })
    const store = createAutoSubmitStore({ fetchImpl, storage, log })
    await store.probeAccessContext(controller.signal)
    expect(log).not.toHaveBeenCalled()
  })

  test('toggling flips the choice and persists it', () => {
    const store = createAutoSubmitStore({ fetchImpl: vi.fn(), storage, log })
    store.toggleChoice()
    expect(store.get().isChoiceOn).toBe(true)
    expect(storage.setItem).toHaveBeenCalledWith(AUTO_SUBMIT_STORAGE_KEY, 'on')
    store.toggleChoice()
    expect(store.get().isChoiceOn).toBe(false)
    expect(storage.setItem).toHaveBeenLastCalledWith(AUTO_SUBMIT_STORAGE_KEY, 'off')
  })

  test('a storage write failure still applies the choice for this page view, and logs', () => {
    storage.setItem.mockImplementation(() => { throw new Error('blocked') })
    const store = createAutoSubmitStore({ fetchImpl: vi.fn(), storage, log })
    store.toggleChoice()
    expect(store.get().isChoiceOn).toBe(true)
    expect(log).toHaveBeenCalledWith('[auto-submit] could not persist the choice', expect.any(Error))
  })

  test('a storage read failure starts off and logs', () => {
    storage.getItem.mockImplementation(() => { throw new Error('blocked') })
    const store = createAutoSubmitStore({ fetchImpl: vi.fn(), storage, log })
    expect(store.get().isChoiceOn).toBe(false)
    expect(log).toHaveBeenCalledWith('[auto-submit] could not read the stored choice', expect.any(Error))
  })

  test('notifies subscribers on change and stops after unsubscribe', () => {
    const store = createAutoSubmitStore({ fetchImpl: vi.fn(), storage, log })
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    store.toggleChoice()
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    store.toggleChoice()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  test('hasRemoteSession follows the probe, and a missing field (an older server) counts as false', async () => {
    const signedIn = createAutoSubmitStore({ fetchImpl: vi.fn().mockResolvedValue(accessResponse({ isRemoteAccess: true, hasRemoteSession: true })), storage, log })
    await signedIn.probeAccessContext()
    expect(signedIn.get().hasRemoteSession).toBe(true)

    const older = createAutoSubmitStore({ fetchImpl: vi.fn().mockResolvedValue(accessResponse({ isRemoteAccess: true })), storage, log })
    await older.probeAccessContext()
    expect(older.get().hasRemoteSession).toBe(false)
  })

  test('anything but a literal true is not a session', async () => {
    const store = createAutoSubmitStore({ fetchImpl: vi.fn().mockResolvedValue(accessResponse({ hasRemoteSession: 'yes' })), storage, log })
    await store.probeAccessContext()
    expect(store.get().hasRemoteSession).toBe(false)
  })
})
