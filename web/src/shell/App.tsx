import type { ReactNode } from 'react'
import { createBrowserRouter, RouterProvider, type RouteObject } from 'react-router'
import { ShellFrame } from './ShellFrame'
import { ViewBoundary } from './ViewBoundary'
import { SHELL_ROUTES, type ShellRouteId } from './routes'
import { TaskDetail } from '../views/task-detail/TaskDetail'
import { SettingsPage } from '../views/pages/SettingsPage'
import { HelpPage } from '../views/pages/HelpPage'
import { DocsPage } from '../views/pages/DocsPage'

// One child route per SHELL_ROUTES entry (`/task/:slug`'s `:slug` param
// matches react-router's own syntax, same as server.ts's Express route), plus
// a catch-all so an unmatched path still renders the shell instead of
// react-router's own not-found boundary. The four board tabs have no element
// of their own — their panels live in the frame — so they render null; every
// other route's view is mounted inside its own ViewBoundary.
const ELEMENT_BY_ROUTE_ID: Partial<Record<ShellRouteId, ReactNode>> = {
  task: (
    <ViewBoundary view="task">
      <TaskDetail />
    </ViewBoundary>
  ),
  // The three full pages the sidebar opens.
  settings: (
    <ViewBoundary view="settings">
      <SettingsPage />
    </ViewBoundary>
  ),
  help: (
    <ViewBoundary view="help">
      <HelpPage />
    </ViewBoundary>
  ),
  docs: (
    <ViewBoundary view="docs">
      <DocsPage />
    </ViewBoundary>
  ),
}

const routes: RouteObject[] = [
  {
    element: <ShellFrame />,
    children: [
      ...SHELL_ROUTES.map((route) => ({ path: route.path, element: ELEMENT_BY_ROUTE_ID[route.id] ?? null })),
      { path: '*', element: null },
    ],
  },
]

// Exported so main.tsx can install router.navigate as the app's navigator —
// it's the same router instance RouterProvider renders below.
export const router = createBrowserRouter(routes)

export function App() {
  return <RouterProvider router={router} />
}
