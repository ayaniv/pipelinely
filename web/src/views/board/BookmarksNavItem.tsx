import { BookmarkIcon } from '../../components/icons'

// The sidebar's Bookmarks row, under the three counted tabs. It wears the tabs'
// own classes so their row, active and collapsed-sidebar styling apply as they
// are, but it is not a board tab: no panel, no data-tab, and it lives in its
// own slot rather than #tab-bar. The count is how many bookmarks there are;
// null (still loading, or this device may not see bookmarks) shows none.

export interface BookmarksNavItemProps {
  // The /bookmarks page is the one showing.
  isCurrent: boolean
  count: number | null
  onOpen: () => void
}

export function BookmarksNavItem({ isCurrent, count, onOpen }: BookmarksNavItemProps) {
  return (
    <>
      <div className="sidebar-bookmarks-divider" aria-hidden="true" />
      <button
        type="button"
        className={`tab-btn${isCurrent ? ' is-active' : ''}`}
        data-testid="sidebar-bookmarks-btn"
        aria-label="Bookmarks"
        aria-current={isCurrent ? 'page' : undefined}
        onClick={onOpen}
      >
        <span className="tab-icon" aria-hidden="true"><BookmarkIcon /></span>
        <span className="tab-label" data-testid="sidebar-bookmarks-label">Bookmarks</span>
        {count !== null && <span className="tab-count" aria-hidden="true" data-testid="sidebar-bookmarks-count">{count}</span>}
      </button>
    </>
  )
}
