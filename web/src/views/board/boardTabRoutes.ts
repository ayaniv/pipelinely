import { useLayoutEffect, useState } from 'react'
import { useLocation } from 'react-router'
import { SHELL_ROUTES, matchShellRoute, type ShellRouteId } from '../../shell/routes'

// The board's four tabs. Each is a real page (own URL, back/forward,
// shareable), so this is derived from the shell's route table — the one
// record the server's routes are checked against — instead of keeping a
// second list that could drift from it. The default tab is the one that
// lives at bare '/', matching '/' already being the app's home route.
export const BOARD_TABS = ['inprogress', 'backlog', 'done', 'you'] as const satisfies readonly ShellRouteId[]
export type BoardTab = (typeof BOARD_TABS)[number]
export const DEFAULT_BOARD_TAB: BoardTab = 'inprogress'

export function boardTabUrl(tab: BoardTab): string {
  const route = SHELL_ROUTES.find((candidate) => candidate.id === tab)
  if (!route) throw new Error(`boardTabs: no shell route for tab '${tab}'`)
  return route.path
}

const isBoardTab = (id: ShellRouteId | null): id is BoardTab => id !== null && (BOARD_TABS as readonly string[]).includes(id)

// null for any path that isn't a board tab (/task/<slug>, /settings, …), so
// callers can tell "not a tab route" from "the default tab's route".
export function matchBoardTab(pathname: string): BoardTab | null {
  const normalized = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname
  const id = matchShellRoute(normalized)
  return isBoardTab(id) ? id : null
}

// The tab last shown, readable outside React: every path that closes an
// overlay (a task detail, Settings/Help, Docs) sends the developer back to
// this tab's URL instead of a hard-coded '/', which would read as "Active"
// and overwrite the tab they came from. Closing a task detail asks through
// closeTaskDetail (shell/appNavigation.ts).
let rememberedTab: BoardTab = DEFAULT_BOARD_TAB
export const rememberBoardTab = (tab: BoardTab): void => { rememberedTab = tab }
export const rememberedBoardTabUrl = (): string => boardTabUrl(rememberedTab)

// The tab whose panel is showing. It follows the URL while the URL is a tab
// route, and otherwise keeps the last one: a task detail or settings page
// overlays the board without replacing which tab is behind it, so closing it
// lands back where the developer was.
export function useActiveBoardTab(): BoardTab {
  const routeTab = matchBoardTab(useLocation().pathname)
  const [activeTab, setActiveTab] = useState<BoardTab>(routeTab ?? DEFAULT_BOARD_TAB)
  // Adjusted during render rather than in an effect, so the panel never paints
  // a frame on the old tab (React's documented "state from props" pattern).
  if (routeTab && routeTab !== activeTab) setActiveTab(routeTab)
  const shownTab = routeTab ?? activeTab
  useLayoutEffect(() => { rememberBoardTab(shownTab) }, [shownTab])
  return shownTab
}
