import { useCallback } from 'react'
import { useNavigate } from 'react-router'
import { isCurrentUrl } from '../../shell/appNavigation'
import { sidebarStore } from '../../shell/sidebarState'
import { boardTabUrl, type BoardTab } from './boardTabRoutes'

// The one path every board tab trigger takes — the sidebar's three counted
// tabs, its account row (You), and a resumed backlog item landing on Active.
// The URL has exactly one writer for a tab change: this router navigation.
// Whatever overlay was open (a task detail, a full page) is a route too, so
// navigating to the tab's URL is what closes it.
export function useSelectBoardTab(): (tab: BoardTab) => void {
  const navigate = useNavigate()
  return useCallback((tab: BoardTab) => {
    const url = boardTabUrl(tab)
    // Picking the tab already showing must not add a duplicate history entry
    // (navigate pushes even to the current URL).
    navigate(url, { replace: isCurrentUrl(url) })
    sidebarStore.closeMobile()
  }, [navigate])
}
