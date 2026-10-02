import { useEffect, useRef } from 'react'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { PlanTestGroup, ResultDoc, ResultDocMeta, Stage } from '../../../src/types'
import type { StageScope } from '../../../src/stageScope'
import type { Logger } from '../log'
import { useSnapshot } from './snapshot'

// The task-detail panel's lazily-fetched resources — the plan
// (tech-design.md, rendered server-side), a research task's result document,
// the planned QA case titles and the per-stage "what this stage covers" blocks. Each is a keyed
// cache (React Query), so a response only ever lands in its own
// slug's entry (never a slow response for one task landing on the next one's), and an unmounted view aborts what it no longer needs.

export interface TechDesign {
  html: string
  summaryHtml: string | null
  testGroups: PlanTestGroup[]
}

export type StageScopes = Partial<Record<Stage, StageScope | null>>

export interface ResourceFetchOptions {
  fetchImpl: typeof fetch
  log: Logger
  signal?: AbortSignal
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

// Every resource fails the same way: an abort is a cancellation (never
// logged); anything else is logged under the resource's own prefix and
// rethrown so the query lands in its error state.
async function fetchJson<T>(url: string, notFoundValue: T | undefined, failureMessage: string, { fetchImpl, log, signal }: ResourceFetchOptions): Promise<T> {
  try {
    const res = await fetchImpl(url, { signal })
    if (res.status === 404 && notFoundValue !== undefined) return notFoundValue
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as T
  } catch (err) {
    if (!isAbort(err)) log(failureMessage, err)
    throw err
  }
}

// A 404 is the expected "this task has no tech-design.md yet" — null, not a
// failure.
export function fetchTechDesign(slug: string, options: ResourceFetchOptions): Promise<TechDesign | null> {
  return fetchJson<TechDesign | null>(`/tech-design/${encodeURIComponent(slug)}`, null, `[tech-design] load for ${slug} failed`, options)
}

// A 404 is the expected "this task has no result document" — null, not a
// failure. The snapshot only carries the document's metadata (Task.resultDoc),
// so the markdown comes from here, when the Result tab opens.
export function fetchResultDoc(slug: string, options: ResourceFetchOptions): Promise<ResultDoc | null> {
  return fetchJson<ResultDoc | null>(`/result-doc/${encodeURIComponent(slug)}`, null, `[result-doc] load for ${slug} failed`, options)
}

export async function fetchQaSpec(slug: string, options: ResourceFetchOptions): Promise<string[] | null> {
  const body = await fetchJson<{ titles: string[] } | null>(`/qa-spec/${encodeURIComponent(slug)}`, null, `[qa-spec] load for ${slug} failed`, options)
  return body ? body.titles : null
}

// The user guide (docs/user-guide.md, rendered server-side). Unlike the task
// resources it has no "not found" value: a missing guide is a failure the Docs
// page shows, the same as any other.
export async function fetchDocsGuide(options: ResourceFetchOptions): Promise<string> {
  const body = await fetchJson<{ html: string }>('/api/docs', undefined, '[docs] load of the guide failed', options)
  return body.html
}

export async function fetchStageScopes(options: ResourceFetchOptions): Promise<StageScopes> {
  const body = await fetchJson<{ stages: StageScopes }>('/api/stage-scope', undefined, '[stage-scope] load failed', options)
  return body.stages
}

interface HookDeps {
  fetchImpl: typeof fetch
  log: Logger
}

export type ResourceState<T> =
  | { status: 'loading'; data: null }
  | { status: 'ready'; data: T | null }
  | { status: 'failed'; data: null }

export type TechDesignState = ResourceState<TechDesign>
export type ResultDocState = ResourceState<ResultDoc>

// A failed load is not retried (by the query's own retry or by a later
// mount): re-issuing a request for a
// resource that is failing on every open just multiplies the log noise.
const LOAD_ONCE = { staleTime: Infinity, retry: false, retryOnMount: false } as const

// Refreshes an open document on every snapshot that arrives after mount, so
// an edit to its file shows up without a reload (the file is not in the
// snapshot itself — the snapshot arriving IS the signal). cancelRefetch:
// false makes a burst of snapshots while a refresh is in flight cost one
// request, and the cached document stays on screen while it runs.
function useRefetchOnSnapshot(query: UseQueryResult<unknown>): void {
  const { dataUpdatedAt: snapshotUpdatedAt } = useSnapshot()
  const { refetch, isError } = query
  const lastSeenSnapshotRef = useRef(snapshotUpdatedAt)
  useEffect(() => {
    if (lastSeenSnapshotRef.current === snapshotUpdatedAt) return
    lastSeenSnapshotRef.current = snapshotUpdatedAt
    // A failed load stays failed (see LOAD_ONCE): re-requesting it on every
    // snapshot would re-log the same failure each time a file changes.
    if (isError) return
    void refetch({ cancelRefetch: false })
  }, [snapshotUpdatedAt, refetch, isError])
}

function toResourceState<T>(query: UseQueryResult<T | null>): ResourceState<T> {
  if (query.data !== undefined) return { status: 'ready', data: query.data }
  return query.isError ? { status: 'failed', data: null } : { status: 'loading', data: null }
}

export function useTechDesign(slug: string, { fetchImpl, log }: Partial<HookDeps> = {}): TechDesignState {
  const impl = fetchImpl ?? fetch
  const logger = log ?? console.error
  const query = useQuery({
    queryKey: ['tech-design', slug],
    queryFn: ({ signal }) => fetchTechDesign(slug, { fetchImpl: impl, log: logger, signal }),
    ...LOAD_ONCE,
  })
  useRefetchOnSnapshot(query)
  return toResourceState(query)
}

// The identity of a snapshot's resultDoc metadata: same key means "nothing
// about the document changed", null means "no document". `mtimeMs` is what
// actually carries a same-length edit (a word swapped for one the same size,
// a fixed typo, a changed table cell) — file/isTruncated/totalBytes alone
// would leave those looking identical and the tab would go stale until
// remount, so mtimeMs (already on hand from the server's own lstat) is the
// part of the key that is guaranteed to move on any real rewrite.
function resultDocMetaKey(meta: ResultDocMeta | null): string {
  return meta ? `${meta.file}:${meta.isTruncated}:${meta.totalBytes}:${meta.mtimeMs}` : 'none'
}

// Refetches only when THIS task's resultDoc metadata actually changes, not on
// every snapshot tick. Snapshots fire on every task's METRICS/STATUS write,
// so refetching on every tick would re-download up to 512 KB for an open
// Result tab on every unrelated task's update — undoing the point of fetching
// it lazily in the first place.
function useRefetchOnMetaChange(query: UseQueryResult<unknown>, meta: ResultDocMeta | null): void {
  const { refetch } = query
  const key = resultDocMetaKey(meta)
  const lastSeenKeyRef = useRef(key)
  useEffect(() => {
    if (lastSeenKeyRef.current === key) return
    lastSeenKeyRef.current = key
    // cancelRefetch: true (not false) — a metadata change means the document
    // really did change, so a fetch already in flight for the OLD content
    // must not be left to win; it is aborted and a fresh one takes over. And
    // no isError guard: a metadata change is worth retrying even from a
    // failed state — the earlier failure may have been transient (a 5xx, a
    // restart), and the document has changed regardless.
    void refetch({ cancelRefetch: true })
  }, [key, refetch])
}

// The Result tab's document. Only the open tab calls this, so a task's
// markdown is never requested just because its card is on the board. `meta`
// is the task's own resultDoc field off the snapshot already in hand — see
// useRefetchOnMetaChange.
export function useResultDoc(slug: string, meta: ResultDocMeta | null, { fetchImpl, log }: Partial<HookDeps> = {}): ResultDocState {
  const impl = fetchImpl ?? fetch
  const logger = log ?? console.error
  const query = useQuery({
    queryKey: ['result-doc', slug],
    queryFn: ({ signal }) => fetchResultDoc(slug, { fetchImpl: impl, log: logger, signal }),
    ...LOAD_ONCE,
  })
  useRefetchOnMetaChange(query, meta)
  return toResourceState(query)
}

// The planned case titles, or null when there are none to show (not enabled,
// still loading, absent, or failed) — the panel treats all of those alike.
// Fetched once per slug: the preview only matters until QA_REPORT.md exists.
export function useQaSpec(slug: string, enabled: boolean, { fetchImpl, log }: Partial<HookDeps> = {}): string[] | null {
  const impl = fetchImpl ?? fetch
  const logger = log ?? console.error
  const query = useQuery({
    queryKey: ['qa-spec', slug],
    queryFn: ({ signal }) => fetchQaSpec(slug, { fetchImpl: impl, log: logger, signal }),
    enabled,
    ...LOAD_ONCE,
  })
  return query.data ?? null
}

// Scope is a property of the stage, not of any task, so one cache entry
// serves every panel for the whole session.
export function useStageScopes({ fetchImpl, log }: Partial<HookDeps> = {}): StageScopes | null {
  const impl = fetchImpl ?? fetch
  const logger = log ?? console.error
  const query = useQuery({
    queryKey: ['stage-scope'],
    queryFn: ({ signal }) => fetchStageScopes({ fetchImpl: impl, log: logger, signal }),
    ...LOAD_ONCE,
  })
  return query.data ?? null
}

// The Docs page's guide: fetched only when the page first opens (never for a
// dashboard that never visits it), then cached for the rest of the session.
// Unlike the task resources a failure IS retried, the next time the page opens
// — a missing or unreadable guide is fixed by the developer and then looked at
// again, so sticking for the whole session would be the wrong default.
export function useDocsGuide({ fetchImpl, log }: Partial<HookDeps> = {}): ResourceState<string> {
  const impl = fetchImpl ?? fetch
  const logger = log ?? console.error
  const query = useQuery({
    queryKey: ['docs-guide'],
    queryFn: ({ signal }) => fetchDocsGuide({ fetchImpl: impl, log: logger, signal }),
    staleTime: Infinity,
    retry: false,
  })
  return toResourceState(query)
}
