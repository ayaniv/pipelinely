// One row per GET route server.ts serves the dashboard shell from
// (sendDashboardShell) — kept as a separate record because the client and
// server can't import each other. routes.test.ts guards the two from
// drifting apart, the same way boardTabRoutes.test.tsx guards the board
// tabs (derived from this table) against it.
export type ShellRouteId = 'inprogress' | 'backlog' | 'done' | 'you' | 'settings' | 'help' | 'docs' | 'task'

export interface ShellRoute {
  id: ShellRouteId
  // The literal Express route pattern this id maps to in server.ts — an
  // exact string match against `app.get('<path>', sendDashboardShell)`,
  // not a URL to navigate to.
  path: string
}

export const SHELL_ROUTES: ShellRoute[] = [
  { id: 'inprogress', path: '/' },
  { id: 'backlog', path: '/backlog' },
  { id: 'done', path: '/done' },
  { id: 'you', path: '/you' },
  { id: 'settings', path: '/settings' },
  { id: 'help', path: '/help' },
  { id: 'docs', path: '/docs' },
  { id: 'task', path: '/task/:slug' },
]

const STATIC_ROUTE_BY_PATH = new Map<string, ShellRouteId>(
  SHELL_ROUTES.filter((route) => route.id !== 'task').map((route) => [route.path, route.id]),
)

const TASK_PATH = /^\/task\/[^/]+\/?$/

export function matchShellRoute(pathname: string): ShellRouteId | null {
  const staticId = STATIC_ROUTE_BY_PATH.get(pathname)
  if (staticId) return staticId
  return TASK_PATH.test(pathname) ? 'task' : null
}

// A task's shareable URL, optionally carrying its selected chain node
// (?stage=<id>) so a refresh or a shared link lands back on the exact stage
// being looked at, not just the task.
export function taskUrl(slug: string, stage?: string | null): string {
  const base = `/task/${encodeURIComponent(slug)}`
  return stage ? `${base}?stage=${encodeURIComponent(stage)}` : base
}
