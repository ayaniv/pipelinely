import { useLocation } from 'react-router'
import { useConnectionStatus } from '../../data/connectionStatus'
import { useBookmarks } from '../../data/taskResources'
import { FrameSlot } from '../../components/FrameSlot'
import { navigateToTask } from '../../shell/appNavigation'
import { matchShellRoute, stripTrailingSlash } from '../../shell/routes'
import { useNow } from '../../useNow'
import { BacklogView } from './BacklogView'
import { BookmarksNavItem } from './BookmarksNavItem'
import { countDoneTasks, standupText, visibleBacklogRows, visibleDoneGroups } from './boardModel'
import { projectFilterStore, type ProjectFilterStore } from './boardFilter'
import type { BoardTab } from './boardTabRoutes'
import { DoneView } from './DoneView'
import { SnapshotPlaceholder } from './SnapshotPlaceholder'
import { StandupButton } from './StandupButton'
import { SidebarAccount } from './SidebarAccount'
import { TabBar, type CountedTab } from './TabBar'
import { useOpenBookmarksPage, useSelectBoardTab } from './useBoardTabNavigation'
import { useBoardFilterView } from './useBoardFilterView'
import { UsageView } from './UsageView'

// The sidebar tab bar and its counts, and the Backlog,
// Done and Usage panels. Like the active board it renders by portal into
// containers the app frame owns (shell/AppFrame.tsx), driven by
// the snapshot cache, the router's location and the ONE project filter (the
// shared store, read through useBoardFilterView — never a second copy). It mounts
// once for every route: the panels stay in the frame, shown by class.

// Keeps the Done/Usage relative dates current across midnight and idle tabs —
// the 30-second tick that advances `now`.
const CLOCK_TICK_MS = 30_000

// The three panel containers that wait for the first snapshot.
const PLACEHOLDER_SLOT_IDS = ['backlog-section', 'done-groups', 'work-density']

export interface BoardTabsProps {
  // The tab whose panel is showing — the frame's, since it draws the panels.
  activeTab: BoardTab
  filterStore?: ProjectFilterStore
}

export function BoardTabs({ activeTab, filterStore = projectFilterStore }: BoardTabsProps) {
  const { snapshot, options, selected, visibleTasks, visibleUnstartedParents } = useBoardFilterView(filterStore)
  const selectTab = useSelectBoardTab()
  const openBookmarksPage = useOpenBookmarksPage()
  // The page showing, from the URL: useActiveBoardTab keeps the last board tab
  // "active" behind a full page, so on /bookmarks it would leave two items lit.
  const isBookmarksPage = matchShellRoute(stripTrailingSlash(useLocation().pathname)) === 'bookmarks'
  const bookmarks = useBookmarks()
  const bookmarksCount = bookmarks.status === 'ready' && bookmarks.data !== null ? bookmarks.data.bookmarks.length : null
  const connection = useConnectionStatus()
  const nowMs = useNow(CLOCK_TICK_MS)

  const visibleBacklog = snapshot ? visibleBacklogRows(snapshot.backlog, selected) : []
  const visibleDone = snapshot ? visibleDoneGroups(snapshot.doneGroups, selected) : []
  const counts: Record<CountedTab, number | null> = snapshot
    ? { inprogress: visibleTasks.length, backlog: visibleBacklog.length + visibleUnstartedParents.length, done: countDoneTasks(visibleDone) }
    : { inprogress: null, backlog: null, done: null }

  return (
    <>
      {/* Present before the first snapshot too: the sidebar must not blank
          out while data loads. Its counts read as unloaded and the panels
          show a loading/error placeholder until then. */}
      <FrameSlot containerId="tab-bar">
        <TabBar activeTab={isBookmarksPage ? null : activeTab} counts={counts} onSelectTab={selectTab} />
      </FrameSlot>
      <FrameSlot containerId="sidebar-bookmarks-slot">
        <BookmarksNavItem isCurrent={isBookmarksPage} count={bookmarksCount} onOpen={openBookmarksPage} />
      </FrameSlot>
      <FrameSlot containerId="sidebar-account-slot">
        <SidebarAccount onSelectTab={selectTab} />
      </FrameSlot>
      {snapshot ? (
        <>
          <FrameSlot containerId="backlog-section">
            <BacklogView
              rows={visibleBacklog}
              backlog={snapshot.backlog}
              plannedParents={visibleUnstartedParents}
              isCanonical={snapshot.isCanonical}
              projectOptions={options}
              onOpenTask={navigateToTask}
              onResumed={() => selectTab('inprogress')}
            />
          </FrameSlot>
          <FrameSlot containerId="done-groups">
            <DoneView groups={visibleDone} onOpenTask={navigateToTask} />
          </FrameSlot>
          {/* Whole-history view: gets the UNFILTERED done groups. */}
          <FrameSlot containerId="work-density">
            <UsageView doneGroups={snapshot.doneGroups} now={new Date(nowMs)} />
          </FrameSlot>
          {activeTab === 'done' ? (
            <FrameSlot containerId="standup-slot">
              <StandupButton text={standupText(snapshot.doneGroups)} />
            </FrameSlot>
          ) : null}
        </>
      ) : (
        PLACEHOLDER_SLOT_IDS.map((containerId) => (
          <FrameSlot key={containerId} containerId={containerId}>
            <SnapshotPlaceholder connection={connection} />
          </FrameSlot>
        ))
      )}
    </>
  )
}
