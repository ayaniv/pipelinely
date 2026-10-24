import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { requestBookmarkDelete, type PostActionOptions } from '../../api/actions'
import { useTransientValue } from '../../components/useTransientValue'
import { BOOKMARKS_QUERY_KEY, type BookmarksResponse } from '../../data/taskResources'
import type { BookmarkRecord } from './bookmarksModel'

// Delete-with-undo: a deleted bookmark leaves the list at once, but its file
// goes only when the undo window closes. A misclick on a one-way delete is the
// worse failure, so nothing is sent until then. Each delete has its own
// window. A delete the server refuses puts the bookmark back and names it.

export const UNDO_WINDOW_MS = 5000
// Long enough to read, like the other failure flashes.
const FAILURE_NOTICE_MS = 8000

export interface PendingBookmarkDelete {
  id: string
  title: string
}

export function useBookmarkDeletes({ fetchImpl = fetch, log = console.error }: Partial<PostActionOptions> = {}) {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<PendingBookmarkDelete[]>([])
  const [failedTitle, showFailedTitle] = useTransientValue<string>(FAILURE_NOTICE_MS)
  // The windows still open, by bookmark id: the timer to cancel on undo, and
  // what to run if the page is left first.
  const openWindowsRef = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; commit: () => Promise<void> }>())

  const closeWindow = useCallback((id: string) => {
    setPending((current) => current.filter((entry) => entry.id !== id))
  }, [])

  const commitDelete = useCallback(async (bookmark: BookmarkRecord, isStillMounted: () => boolean) => {
    const outcome = await requestBookmarkDelete(bookmark.id, { fetchImpl, log })
    if (outcome.ok) {
      queryClient.setQueryData<BookmarksResponse>(BOOKMARKS_QUERY_KEY, (current) =>
        current && { ...current, bookmarks: current.bookmarks.filter((entry) => entry.id !== bookmark.id) })
    }
    if (!isStillMounted()) return
    closeWindow(bookmark.id)
    if (!outcome.ok) showFailedTitle(bookmark.title)
  }, [fetchImpl, log, queryClient, closeWindow, showFailedTitle])

  const isMountedRef = useRef(true)
  useEffect(() => {
    isMountedRef.current = true
    const openWindows = openWindowsRef.current
    const closeAllWindows = () => {
      for (const { timer, commit } of openWindows.values()) {
        clearTimeout(timer)
        void commit()
      }
      openWindows.clear()
    }
    // Leaving the page closes every window: what was deleted is deleted, not
    // left for a timer that no longer exists. Closing or reloading the tab
    // skips the unmount cleanup, so it is caught by pagehide.
    window.addEventListener('pagehide', closeAllWindows)
    return () => {
      isMountedRef.current = false
      window.removeEventListener('pagehide', closeAllWindows)
      closeAllWindows()
    }
  }, [])

  const scheduleDelete = useCallback((bookmark: BookmarkRecord) => {
    setPending((current) => [...current, { id: bookmark.id, title: bookmark.title }])
    const commit = async () => {
      openWindowsRef.current.delete(bookmark.id)
      await commitDelete(bookmark, () => isMountedRef.current)
    }
    openWindowsRef.current.set(bookmark.id, { timer: setTimeout(() => void commit(), UNDO_WINDOW_MS), commit })
  }, [commitDelete])

  const undoDelete = useCallback((id: string) => {
    const openWindow = openWindowsRef.current.get(id)
    if (openWindow) clearTimeout(openWindow.timer)
    openWindowsRef.current.delete(id)
    closeWindow(id)
  }, [closeWindow])

  return { pending, failedTitle, scheduleDelete, undoDelete }
}
