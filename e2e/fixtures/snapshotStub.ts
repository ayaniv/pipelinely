import type { Page } from '@playwright/test'

// Deterministic snapshots for specs that need the dashboard to show a
// specific orchestrator ctx / canonical flag / settings value. The ui project
// shares one server and one chokidar-watched fixture dir across every spec,
// so a real SSE broadcast from another worker can land at any time, and
// mutating the shared fixtures to flip these values would race every other
// worker. Instead the cold /api/tasks load serves a mutated copy of the real
// snapshot with /events aborted, and later snapshots are pushed through the
// page's own `es.onmessage` — the same entry point a real SSE message takes.

export interface SnapshotShape {
  tasks: Array<Record<string, unknown>>
  orchestratorContextPct: number | null
  isCanonical: boolean
  settings: { autoMode: boolean }
  [key: string]: unknown
}

export async function fetchRealSnapshot(page: Page): Promise<SnapshotShape> {
  const res = await page.request.get('/api/tasks')
  return (await res.json()) as SnapshotShape
}

export async function openWithSnapshot(page: Page, path: string, mutate: (snapshot: SnapshotShape) => void): Promise<SnapshotShape> {
  const snapshot = await fetchRealSnapshot(page)
  mutate(snapshot)
  await page.route('**/api/tasks', (route) => route.fulfill({ json: snapshot }))
  await page.route('**/events', (route) => route.abort())
  await page.goto(path)
  return snapshot
}

export async function pushSnapshot(page: Page, snapshot: SnapshotShape): Promise<void> {
  await page.evaluate((payload) => {
    const source = (window as unknown as { es: EventSource }).es
    source.onmessage!(new MessageEvent('message', { data: JSON.stringify(payload) }))
  }, snapshot)
}
