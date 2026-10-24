import { describe, expect, test } from 'vitest'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { SNAPSHOT_QUERY_KEY } from './snapshot'
import { useCreaturePlacement } from './creaturePlacement'

function placementFor(snapshot: unknown) {
  const queryClient = new QueryClient()
  if (snapshot !== undefined) queryClient.setQueryData(SNAPSHOT_QUERY_KEY, snapshot)
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  return renderHook(() => useCreaturePlacement(), { wrapper }).result.current
}

describe('useCreaturePlacement', () => {
  test('reads the placement from the snapshot settings', () => {
    expect(placementFor({ settings: { autoMode: false, creaturePlacement: 'off' } })).toBe('off')
    expect(placementFor({ settings: { autoMode: false, creaturePlacement: 'header' } })).toBe('header')
  })

  test('defaults to the header before a snapshot arrives or when the server predates the setting', () => {
    expect(placementFor(undefined)).toBe('header')
    expect(placementFor({ settings: { autoMode: false } })).toBe('header')
  })
})
