import { useConnectionStatus } from '../../data/connectionStatus'
import { FrameSlot } from '../../components/FrameSlot'
import { navigateToTask } from '../../shell/appNavigation'
import { useNow } from '../../useNow'
import { BacklogView } from './BacklogView'
import { countDoneTasks, standupText, visibleBacklogRows, visibleDoneGroups } from './boardModel'
import { projectFilterStore, type ProjectFilterStore } from './boardFilter'
import type { BoardTab } from './boardTabRoutes'
import { DoneView } from './DoneView'
import { SnapshotPlaceholder } from './SnapshotPlaceholder'
import { StandupButton } from './StandupButton'
import { SidebarAccount, TabBar, type CountedTab } from './TabBar'
import { useSelectBoardTab } from './useBoardTabNavigation'
import { useBoardFilterView } from './useBoardFilterView'
import { YouView } from './YouView'

// The sidebar tab bar and its counts, and the Backlog,
// Done and You panels. Like the active board it renders by portal into
// containers the app frame owns (shell/AppFrame.tsx), driven by
// the snapshot cache, the router's location and the ONE project filter (the
// shared store, read through useBoardFilterView — never a second copy). It mounts
// once for every route: the panels stay in the frame, shown by class.

// Keeps the Done/You relative dates current across midnight and idle tabs —
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
  const { snapshot, options, selected, visibleTasks } = useBoardFilterView(filterStore)
  const selectTab = useSelectBoardTab()
  const connection = useConnectionStatus()
  const nowMs = useNow(CLOCK_TICK_MS)

  const visibleBacklog = snapshot ? visibleBacklogRows(snapshot.backlog, selected) : []
  const visibleDone = snapshot ? visibleDoneGroups(snapshot.doneGroups, selected) : []
  const counts: Record<CountedTab, number | null> = snapshot
    ? { inprogress: visibleTasks.length, backlog: visibleBacklog.length, done: countDoneTasks(visibleDone) }
    : { inprogress: null, backlog: null, done: null }

  return (
    <>
      {/* Present before the first snapshot too: the sidebar must not blank
          out while data loads. Its counts read as unloaded and the panels
          show a loading/error placeholder until then. */}
      <FrameSlot containerId="tab-bar">
        <TabBar activeTab={activeTab} counts={counts} onSelectTab={selectTab} />
      </FrameSlot>
      <FrameSlot containerId="sidebar-account-slot">
        <SidebarAccount activeTab={activeTab} onSelectTab={selectTab} />
      </FrameSlot>
      {snapshot ? (
        <>
          <FrameSlot containerId="backlog-section">
            <BacklogView
              rows={visibleBacklog}
              backlog={snapshot.backlog}
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
            <YouView doneGroups={snapshot.doneGroups} now={new Date(nowMs)} />
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
