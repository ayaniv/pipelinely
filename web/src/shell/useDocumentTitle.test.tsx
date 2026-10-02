import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SNAPSHOT_QUERY_KEY, type Snapshot } from '../data/snapshot'
import { makeTask } from '../testing/makeTask'
import { useDocumentTitle, waitingTitle } from './useDocumentTitle'

const snapshotOf = (statuses: string[]): Snapshot => ({
  tasks: statuses.map((status, index) => makeTask({ slug: `t${index}`, status: status as never })),
  activeProject: null, weeklyFocus: '', backlog: [], doneGroups: [], settings: { autoMode: false }, orchestratorContextPct: null, isCanonical: true,
}) as Snapshot

describe('waitingTitle', () => {
  it('is the bare app name with nothing waiting, and count-prefixed otherwise', () => {
    expect(waitingTitle(0)).toBe('pipelinely.cc')
    expect(waitingTitle(3)).toBe('(3) pipelinely.cc')
  })
})

describe('useDocumentTitle', () => {
  it('follows the number of waiting tasks as the snapshot changes', async () => {
    const client = new QueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    renderHook(() => useDocumentTitle(), { wrapper })
    expect(document.title).toBe('pipelinely.cc')

    act(() => { client.setQueryData(SNAPSHOT_QUERY_KEY, snapshotOf(['waiting', 'working', 'waiting'])) })
    await waitFor(() => expect(document.title).toBe('(2) pipelinely.cc'))

    act(() => { client.setQueryData(SNAPSHOT_QUERY_KEY, snapshotOf(['working'])) })
    await waitFor(() => expect(document.title).toBe('pipelinely.cc'))
  })
})
