import { describe, expect, test, vi } from 'vitest'
import { preloadActiveTable } from './ActiveTableSlot'

describe('preloadActiveTable', () => {
  test('resolves quietly when the chunk loads', async () => {
    const log = vi.fn()
    await preloadActiveTable(log, () => Promise.resolve({}))
    expect(log).not.toHaveBeenCalled()
  })

  test('logs when the chunk fails to load', async () => {
    const log = vi.fn()
    const error = new Error('chunk failed')
    await preloadActiveTable(log, () => Promise.reject(error))
    expect(log).toHaveBeenCalledWith('[active-table] could not preload the table chunk', error)
  })
})
