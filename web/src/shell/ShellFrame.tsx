import { Outlet, useLocation } from 'react-router'
import { matchShellRoute } from './routes'
import { AppFrame } from './AppFrame'
import { useDocumentTitle } from './useDocumentTitle'
import { ViewBoundary } from './ViewBoundary'
import { useActiveBoardTab } from '../views/board/boardTabRoutes'
import { ActiveBoard } from '../views/board/ActiveBoard'
import { BoardTabs } from '../views/board/BoardTabs'
import { HeaderChrome } from '../views/header/HeaderChrome'
import { ReadOnlyBanner } from '../views/header/ReadOnlyBanner'

// The layout every SHELL_ROUTES entry (plus the catch-all `*`) renders —
// data-route drives react-shell.spec.ts's per-route assertions, computed from
// the current location rather than from React Router's own matched route id,
// so an unmatched path still gets a defined ('unknown') value instead of
// undefined.
export function ShellFrame() {
  const location = useLocation()
  const routeId = matchShellRoute(location.pathname) ?? 'unknown'
  const activeTab = useActiveBoardTab()
  useDocumentTitle()

  return (
    <div data-testid="react-shell" data-route={routeId}>
      <AppFrame
        activeTab={activeTab}
        slots={(
          <>
            {/* Header chrome, the read-only banner and the sidebar tab bar (with the Backlog/Done/You panels) portal into the frame's regions. */}
            <HeaderChrome />
            <ReadOnlyBanner />
            <ViewBoundary view="board-tabs" fallback={<p data-testid="board-tabs-crashed-message">The tabs failed to load — reload the page, and check the console.</p>}>
              <BoardTabs activeTab={activeTab} />
            </ViewBoundary>
            {/* The active board isn't a route: every board panel stays in the frame (shown by class), so its React half mounts once, for every route, rather than per-route like the task detail. */}
            <ViewBoundary view="board" fallback={<p data-testid="board-crashed-message">The board failed to load — reload the page, and check the console.</p>}>
              <ActiveBoard />
            </ViewBoundary>
          </>
        )}
      >
        <Outlet />
      </AppFrame>
    </div>
  )
}
