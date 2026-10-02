import './styles/app.css'
import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App, router } from './shell/App'
import { installAppNavigator } from './shell/appNavigation'
import { sidebarStore } from './shell/sidebarState'
import { startSnapshotCoordinator } from './data/snapshotCoordinator'
import { setConnectionStatus } from './data/connectionStatus'
import { autoSubmitStore } from './data/autoSubmit'

// One QueryClient, one coordinator, for the app's whole lifetime — see
// snapshotCoordinator.ts's own comment on why StrictMode's extra
// mount/cleanup/mount cycle is safe against the same shared client.
const queryClient = new QueryClient()

function AppRoot() {
  useEffect(() => {
    // The router is the only writer of the URL; every non-component caller
    // (card footers, parent-link chips, panel buttons) navigates through it.
    const uninstallNavigator = installAppNavigator((to, options) => router.navigate(to, options))

    const probeController = new AbortController()
    void autoSubmitStore.probeAccessContext(probeController.signal)

    const coordinator = startSnapshotCoordinator({
      queryClient,
      fetchImpl: window.fetch.bind(window),
      createEventSource: (url) => {
        const source = new EventSource(url)
        // TODO: a test-only hook living in the production bundle — the specs
        // push snapshots through this handler (see sseBridge.ts). Remove it
        // when the e2e build gets a dedicated seam (e.g. a test-mode flag).
        window.es = source
        return source
      },
      onStatus: setConnectionStatus,
      log: console.error,
    })

    return () => {
      probeController.abort()
      uninstallNavigator()
      coordinator.dispose()
    }
  }, [])

  return <App />
}

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('main.tsx: #root not found — web/index.html is missing its React mount point')

// A task detail opens with the sidebar collapsed, the board with it expanded —
// decided once against the route the page opened on, then left to the user.
sidebarStore.setCollapsed(window.location.pathname.startsWith('/task/'))

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AppRoot />
    </QueryClientProvider>
  </StrictMode>,
)
