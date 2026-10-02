import type { Locator, Page } from '@playwright/test'

// Helpers shared by the React board specs (react-active-board, react-board-
// tabs): spotting React-owned DOM, collecting page/console errors, and
// driving the page's SSE feed by hand. One copy, so a change to how the
// feed is frozen lands in every spec at once.

export function collectPageErrors(page: Page): Error[] {
  const errors: Error[] = []
  page.on('pageerror', (err) => errors.push(err))
  return errors
}

export function collectConsoleErrors(page: Page): string[] {
  const lines: string[] = []
  page.on('console', (msg) => { if (msg.type() === 'error') lines.push(msg.text()) })
  return lines
}

// Only a real React root leaves `__reactFiber$…` on the nodes it rendered —
// an innerHTML write never does. This is what "React-owned" means here,
// checkable without reading any implementation detail of the component tree.
export const isReactOwned = (locator: Locator) =>
  locator.evaluate((el) => Object.keys(el).some((key) => key.startsWith('__reactFiber$')))

export interface SnapshotPatch {
  // slug → fields to overwrite on that task
  taskPatches?: Record<string, Record<string, unknown>>
  // when set, only these slugs stay in the pushed snapshot's task list
  onlySlugs?: string[]
  // when set, tasks with this repo are dropped
  dropRepo?: string
  weeklyFocus?: string
  activeProject?: { projectBase: string; current: number; total: number } | null
  // Replaces the whole list — the backlog/done panels are driven by these.
  backlog?: unknown[]
  doneGroups?: unknown[]
  isCanonical?: boolean
}

// Detaches the page's live SSE handler and keeps it aside. The `ui` project
// shares one dev server and one fixture TASKS_DIR across parallel workers,
// so any other spec's STATUS write triggers a REAL broadcast that would
// overwrite a hand-built snapshot mid-assertion — the same root cause
// focus-button-rerender-race.spec.ts documents for silencing es.onmessage.
export async function freezeLiveFeed(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { es: EventSource; __liveOnMessage?: EventSource['onmessage'] }
    w.__liveOnMessage = w.es.onmessage
    w.es.onmessage = null
  })
}

// Builds a snapshot off the server's real current one, applies `patch`, and
// feeds it through the ORIGINAL handler — the exact path a real SSE
// broadcast takes into React Query and on to every subscriber.
export async function pushSnapshot(page: Page, patch: SnapshotPatch = {}): Promise<void> {
  await page.evaluate(async (p) => {
    const w = window as unknown as { __liveOnMessage: (e: MessageEvent) => void }
    const snapshot = await fetch('/api/tasks').then((r) => r.json())
    if (p.onlySlugs) snapshot.tasks = snapshot.tasks.filter((t: { slug: string }) => p.onlySlugs!.includes(t.slug))
    if (p.dropRepo) snapshot.tasks = snapshot.tasks.filter((t: { repo: string }) => t.repo !== p.dropRepo)
    for (const [slug, fields] of Object.entries(p.taskPatches ?? {})) {
      const task = snapshot.tasks.find((t: { slug: string }) => t.slug === slug)
      if (task) Object.assign(task, fields)
    }
    if (p.weeklyFocus !== undefined) snapshot.weeklyFocus = p.weeklyFocus
    if (p.activeProject !== undefined) snapshot.activeProject = p.activeProject
    if (p.backlog !== undefined) snapshot.backlog = p.backlog
    if (p.doneGroups !== undefined) snapshot.doneGroups = p.doneGroups
    if (p.isCanonical !== undefined) snapshot.isCanonical = p.isCanonical
    w.__liveOnMessage(new MessageEvent('message', { data: JSON.stringify(snapshot) }))
  }, patch)
}
