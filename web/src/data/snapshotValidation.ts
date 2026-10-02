import type { Snapshot } from './snapshot'

// The wire format is `JSON.parse`d server output with no runtime schema of
// its own (src/types.ts's Snapshot is compile-time only — see its own
// comment). A malformed payload used to reach setQueryData unchecked; this
// is the one place both the cold fetch and every SSE push go through
// before a value is trusted into the cache.
export function isValidSnapshot(value: unknown): value is Snapshot {
  if (typeof value !== 'object' || value === null) return false
  const snapshot = value as Record<string, unknown>
  return (
    Array.isArray(snapshot.tasks) &&
    Array.isArray(snapshot.backlog) &&
    Array.isArray(snapshot.doneGroups) &&
    typeof snapshot.weeklyFocus === 'string' &&
    typeof snapshot.settings === 'object' && snapshot.settings !== null &&
    (typeof snapshot.orchestratorContextPct === 'number' || snapshot.orchestratorContextPct === null) &&
    typeof snapshot.isCanonical === 'boolean'
  )
}
