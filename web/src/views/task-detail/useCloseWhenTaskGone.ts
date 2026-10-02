import { useEffect } from 'react'
import type { Logger } from '../../log'
import { closeTaskDetail } from '../../shell/appNavigation'

export interface CloseWhenGoneOptions {
  fetchImpl?: typeof fetch
  log?: Logger
  close?: () => void
}

// A single snapshot missing the open task isn't proof it's gone — task
// directories are never deleted by this app's own routes, so in practice a
// real removal only happens when someone deletes one by hand; every other
// time it fires is a broadcast that raced a refresh mid-flight (the /events
// payload and the /api/tasks snapshot can momentarily disagree). Trusting
// that one stale snapshot enough to close the panel and reset the URL is what
// let a cold `/task/<slug>` load land back on the board the instant an
// unrelated task's file write triggered a refresh. Re-checking against
// /api/tasks (the authoritative snapshot) first costs one extra round trip
// only in that rare case. Re-runs on every snapshot while the task stays
// missing, and cancels its check if the view closes or moves on meanwhile.
export function useCloseWhenTaskGone(
  slug: string | undefined,
  isMissingFromSnapshot: boolean,
  snapshotUpdatedAt: number,
  { fetchImpl = fetch, log = console.error, close = closeTaskDetail }: CloseWhenGoneOptions = {},
): void {
  useEffect(() => {
    if (!slug || !isMissingFromSnapshot) return
    const controller = new AbortController()
    fetchImpl('/api/tasks', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`GET /api/tasks responded ${response.status}`)
        return response.json() as Promise<{ tasks: { slug: string }[] }>
      })
      .then(({ tasks }) => {
        if (controller.signal.aborted) return
        if (tasks.some((task) => task.slug === slug)) return
        close()
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        log(`[task-detail] could not confirm ${slug} was actually removed before closing its detail view`, err)
      })
    return () => controller.abort()
  }, [slug, isMissingFromSnapshot, snapshotUpdatedAt, fetchImpl, log, close])
}
