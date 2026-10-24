import { describe, it, expect, vi } from 'vitest'
import { createTtlCache, readThrough } from './ttlCache.js'

describe('readThrough', () => {
  it('fetches on a miss and serves the cached value until it expires', async () => {
    const cache = createTtlCache<string>()
    const fetch = vi.fn().mockResolvedValue({ value: 'first', ttlMs: 1000 })
    let now = 0

    expect(await readThrough(cache, 'key', () => now, fetch)).toBe('first')
    now = 999
    expect(await readThrough(cache, 'key', () => now, fetch)).toBe('first')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('fetches again once the entry has expired', async () => {
    const cache = createTtlCache<string>()
    const fetch = vi.fn().mockResolvedValueOnce({ value: 'first', ttlMs: 1000 }).mockResolvedValueOnce({ value: 'second', ttlMs: 1000 })
    let now = 0

    await readThrough(cache, 'key', () => now, fetch)
    now = 1000
    expect(await readThrough(cache, 'key', () => now, fetch)).toBe('second')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight fetch between concurrent readers of the same key', async () => {
    const cache = createTtlCache<string>()
    let resolveFetch: (result: { value: string; ttlMs: number }) => void = () => {}
    const fetch = vi.fn(() => new Promise<{ value: string; ttlMs: number }>((resolve) => { resolveFetch = resolve }))

    const both = Promise.all([readThrough(cache, 'key', () => 0, fetch), readThrough(cache, 'key', () => 0, fetch)])
    resolveFetch({ value: 'shared', ttlMs: 1000 })

    expect(await both).toEqual(['shared', 'shared'])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps separate keys separate', async () => {
    const cache = createTtlCache<string>()
    const fetch = vi.fn().mockResolvedValueOnce({ value: 'a', ttlMs: 1000 }).mockResolvedValueOnce({ value: 'b', ttlMs: 1000 })

    expect(await readThrough(cache, 'a', () => 0, fetch)).toBe('a')
    expect(await readThrough(cache, 'b', () => 0, fetch)).toBe('b')
  })

  it('caches nothing when the fetch rejects, so the next read tries again', async () => {
    const cache = createTtlCache<string>()
    const fetch = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ value: 'recovered', ttlMs: 1000 })

    await expect(readThrough(cache, 'key', () => 0, fetch)).rejects.toThrow('boom')
    expect(await readThrough(cache, 'key', () => 0, fetch)).toBe('recovered')
    expect(cache.inFlight.size).toBe(0)
  })
})
