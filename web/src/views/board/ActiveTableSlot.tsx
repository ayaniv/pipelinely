import { Suspense, lazy } from 'react'
import type { Logger } from '../../log'
import { ViewBoundary } from '../../shell/ViewBoundary'
import type { ActiveTableProps } from './ActiveTable'

// The table view's lazy chunk. The cards view is the default, so the
// virtualizer only loads for a browser that has chosen the table.

const loadActiveTable = () => import('./ActiveTable').then((module) => ({ default: module.ActiveTable }))
const LazyActiveTable = lazy(loadActiveTable)

// Starts the chunk loading when the remembered view is the table, before the
// snapshot is there to render it. A failed preload is logged; the real load on
// first use surfaces the same failure to the boundary below.
export async function preloadActiveTable(log: Logger = console.error, load: () => Promise<unknown> = loadActiveTable): Promise<void> {
  try {
    await load()
  } catch (err) {
    log('[active-table] could not preload the table chunk', err)
  }
}

export function ActiveTableSlot(props: ActiveTableProps) {
  return (
    <ViewBoundary view="active-table" fallback="The table view could not load. Switch back to cards.">
      <Suspense fallback={null}>
        <LazyActiveTable {...props} />
      </Suspense>
    </ViewBoundary>
  )
}
