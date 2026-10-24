import { useCallback } from 'react'
import { useNavigate } from 'react-router'
import { isCurrentUrl } from '../../shell/appNavigation'
import { sidebarStore } from '../../shell/sidebarState'
import { boardTabUrl, type BoardTab } from './boardTabRoutes'

const BOOKMARKS_URL = '/bookmarks'

// The one path every board tab trigger takes — the sidebar's three counted
// tabs, its account row (You), and a resumed backlog item landing on Active.
// The URL has exactly one writer for a tab change: this router navigation.
// Whatever overlay was open (a task detail, a full page) is a route too, so
// navigating to the tab's URL is what closes it.
export function useSelectBoardTab(): (tab: BoardTab) => void {
  const openFromSidebar = useOpenFromSidebar()
  return useCallback((tab: BoardTab) => openFromSidebar(boardTabUrl(tab)), [openFromSidebar])
}

// The sidebar's Bookmarks row: a page, not a tab, but it navigates the same way.
export function useOpenBookmarksPage(): () => void {
  const openFromSidebar = useOpenFromSidebar()
  return useCallback(() => openFromSidebar(BOOKMARKS_URL), [openFromSidebar])
}

function useOpenFromSidebar(): (url: string) => void {
  const navigate = useNavigate()
  return useCallback((url: string) => {
    // Picking the page already showing must not add a duplicate history entry
    // (navigate pushes even to the current URL).
    navigate(url, { replace: isCurrentUrl(url) })
    sidebarStore.closeMobile()
  }, [navigate])
}
