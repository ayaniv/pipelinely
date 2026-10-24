// A read-through cache whose entries each carry their own expiry, and which
// lets concurrent readers of one key share a single in-flight fetch. Built for
// the refreshTasks() lookups that shell out to gh: two tasks (or two
// overlapping refreshes) asking about the same thing share one call, and an
// answer is reused until it expires.
export interface TtlCache<T> {
  entries: Map<string, { value: T; expiresAt: number }>
  inFlight: Map<string, Promise<T>>
}

export function createTtlCache<T>(): TtlCache<T> {
  return { entries: new Map(), inFlight: new Map() }
}

// `fetch` decides each answer's own lifetime, so a caller can keep a settled
// answer longer than a miss. A rejected fetch caches nothing — callers that
// want a failure remembered resolve it as a value instead.
export async function readThrough<T>(
  cache: TtlCache<T>,
  key: string,
  now: () => number,
  fetch: () => Promise<{ value: T; ttlMs: number }>,
): Promise<T> {
  const cached = cache.entries.get(key)
  if (cached && cached.expiresAt > now()) return cached.value

  const pending =
    cache.inFlight.get(key) ??
    fetch()
      .then(({ value, ttlMs }) => {
        cache.entries.set(key, { value, expiresAt: now() + ttlMs })
        return value
      })
      .finally(() => cache.inFlight.delete(key))
  cache.inFlight.set(key, pending)
  return pending
}
