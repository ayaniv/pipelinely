import { describe, expect, test } from 'vitest'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { SNAPSHOT_QUERY_KEY } from './snapshot'
import { useWeeklyFocusEnabled } from './weeklyFocusEnabled'

function enabledFor(snapshot: unknown) {
  const queryClient = new QueryClient()
  if (snapshot !== undefined) queryClient.setQueryData(SNAPSHOT_QUERY_KEY, snapshot)
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  return renderHook(() => useWeeklyFocusEnabled(), { wrapper }).result.current
}

describe('useWeeklyFocusEnabled', () => {
  test('reads the flag from the snapshot settings', () => {
    expect(enabledFor({ settings: { autoMode: false, weeklyFocusEnabled: false } })).toBe(false)
    expect(enabledFor({ settings: { autoMode: false, weeklyFocusEnabled: true } })).toBe(true)
  })

  test('is on before a snapshot arrives or when the server predates the setting', () => {
    expect(enabledFor(undefined)).toBe(true)
    expect(enabledFor({ settings: { autoMode: false } })).toBe(true)
  })

  test('treats a non-boolean value as on', () => {
    expect(enabledFor({ settings: { autoMode: false, weeklyFocusEnabled: 'false' } })).toBe(true)
  })
})
