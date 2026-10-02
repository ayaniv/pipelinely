import type { Logger } from '../log'
import { rememberedBoardTabUrl } from '../views/board/boardTabRoutes'
import { taskUrl } from './routes'

// Navigation for code that isn't a component: the shared primitives (card
// footers, parent-link chips, the task-detail panel's buttons) navigate from
// inside event handlers that have no router hook of their own. The router is
// the ONLY writer of the URL — nothing else calls history.pushState — so
// every navigation in the app goes through the one navigator installed here
// at boot (main.tsx), which is the router's own `navigate`.

export type NavigateOptions = { replace?: boolean }
type Navigator = (to: string, options?: NavigateOptions) => unknown

let installedNavigator: Navigator | null = null

export function installAppNavigator(navigator: Navigator): () => void {
  installedNavigator = navigator
  return () => {
    if (installedNavigator === navigator) installedNavigator = null
  }
}

// Whether `to` is the URL the page is already showing.
export function isCurrentUrl(to: string): boolean {
  return to === window.location.pathname + window.location.search
}

export function navigateToUrl(to: string, options?: NavigateOptions, log: Logger = console.error): void {
  if (!installedNavigator) {
    // A click that goes nowhere with no trace is the worst failure mode.
    log('[navigation] no navigator installed — navigation dropped', to)
    return
  }
  // Going to the URL already showing (clicking the open task's card again, the
  // active tab) replaces the entry instead of stacking a duplicate one, which
  // would make Back appear to do nothing.
  const effectiveOptions = isCurrentUrl(to) ? { ...options, replace: true } : options
  // The router's own navigate is async and resolves (or rejects) after the
  // URL has moved; a rejection must not escape as an unhandled one.
  void Promise.resolve(installedNavigator(to, effectiveOptions)).catch((err: unknown) => log('[navigation] navigating failed', err))
}

// Every way into a task — a card, a backlog row, a parent-link chip.
export function navigateToTask(slug: string, options?: { stage?: string | null }): void {
  navigateToUrl(taskUrl(slug, options?.stage), undefined)
}

// Where a closed task detail returns: the board tab last shown, so closing
// lands back on the tab it was opened from instead of overwriting it with '/'.
export function closeTaskDetail(): void {
  navigateToUrl(rememberedBoardTabUrl(), undefined)
}
