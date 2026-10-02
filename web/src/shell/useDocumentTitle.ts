import { useEffect } from 'react'
import { useSnapshot } from '../data/snapshot'

export const APP_TITLE = 'pipelinely.cc'

// The browser tab's title: the app name, prefixed with how many tasks are
// waiting on the developer — so a background tab says when it needs them.
export function waitingTitle(waitingCount: number): string {
  return waitingCount > 0 ? `(${waitingCount}) ${APP_TITLE}` : APP_TITLE
}

export function useDocumentTitle(): void {
  const { data } = useSnapshot()
  const waitingCount = data?.tasks.filter((task) => task.status === 'waiting').length ?? 0
  useEffect(() => {
    document.title = waitingTitle(waitingCount)
  }, [waitingCount])
}
