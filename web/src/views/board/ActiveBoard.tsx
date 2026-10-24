import { useEffect } from 'react'
import type { Task } from '../../../../src/types'
import { decisionContext } from '../../../../src/nextAction'
import { FrameSlot } from '../../components/FrameSlot'
import { clientState, useClientState } from '../../data/clientState'
import { useActiveView } from '../../data/activeView'
import { useCreaturePlacement } from '../../data/creaturePlacement'
import { runWaveBatch } from '../../api/waveBatch'
import { navigateToTask } from '../../shell/appNavigation'
import { useNow } from '../../useNow'
import { ActiveCards } from './ActiveCards'
import { ActiveTableSlot, preloadActiveTable } from './ActiveTableSlot'
import { ParentTasksSection } from './parents/ParentTasksSection'
import { ActiveViewSwitch } from './ActiveViewSwitch'
import { offFocusCount, pulseCounts } from './boardModel'
import { PushForwardPill } from './PushForwardPill'
import { isBabysitWired } from './babysitWiring'
import { DEFAULT_BOARD_TAB, type BoardTab } from './boardTabRoutes'
import { NewTaskPill } from './NewTaskPill'
import { projectFilterStore, type ProjectFilterStore } from './boardFilter'
import { useBoardFilterView } from './useBoardFilterView'
import { FilterChips } from './FilterChips'
import { GlobalProgress } from './GlobalProgress'
import { SummaryStrip } from './SummaryStrip'
import { WeeklyFocus } from './WeeklyFocus'
import { useWeeklyFocusEnabled } from '../../data/weeklyFocusEnabled'

// The active board. Every piece renders by portal into a container the app
// frame owns (shell/AppFrame.tsx) — the Backlog/Done/Usage panels and the
// sidebar tab bar are BoardTabs. Driven entirely by the snapshot cache. It
// owns the filter chips and the store's pruning; every board view reads the
// filter through useBoardFilterView.

// The 30-second tick that keeps a card's
// relative time ("5m ago") current.
const CLOCK_TICK_MS = 30_000

// Void-returning so the section's prop stays a plain callback; runWaveBatch
// logs its own failures (api/waveBatch.ts), so nothing is left to await.
const runParentWave = (parent: Task, wave: number): void => { void runWaveBatch(parent, wave) }

export interface ActiveBoardProps {
  filterStore?: ProjectFilterStore
  // The tab whose panel is showing. The pulse chips stay on every tab; the
  // toolbar's Push forward and New task belong to the Active tab alone.
  activeTab?: BoardTab
}

export function ActiveBoard({ filterStore = projectFilterStore, activeTab = DEFAULT_BOARD_TAB }: ActiveBoardProps) {
  const { snapshot, options, selected, visibleTasks, visibleParents, toggle, prune } = useBoardFilterView(filterStore)
  const nowMs = useNow(CLOCK_TICK_MS)
  const creaturePlacement = useCreaturePlacement()
  const isWeeklyFocusEnabled = useWeeklyFocusEnabled()
  const activeView = useActiveView()
  // Off-focus is shared client state; a toggle from any surface notifies here
  // rather than arriving in a snapshot.
  const { offFocusSlugs } = useClientState()

  const optionsKey = options.join('\n')

  // A selection pointing at a project that no longer exists is treated as
  // already dropped for this render (useBoardFilterView), then actually
  // dropped here — never an empty board with no way to see why.
  useEffect(() => {
    if (snapshot) prune(optionsKey === '' ? [] : optionsKey.split('\n'))
  }, [snapshot, optionsKey, prune])

  useEffect(() => {
    if (activeView === 'table') void preloadActiveTable()
  }, [activeView])

  if (!snapshot) return null

  // Parents alone are a board: the shared empty state is for a board with
  // nothing at all, not one whose only tasks sit in the Parent tasks section.
  const shouldShowGroups = visibleTasks.length > 0 || visibleParents.length === 0
  const boardProps = { tasks: visibleTasks, now: nowMs, isTaskOffFocus: clientState.isOffFocus, onToggleOffFocus: clientState.toggleOffFocus, onOpenDetail: navigateToTask, creaturePlacement }

  return (
    <>
      <FrameSlot containerId="active-cards">
        <ParentTasksSection parents={visibleParents} onRunWave={runParentWave} onOpenPlan={navigateToTask} creaturePlacement={creaturePlacement} isCanonical={snapshot.isCanonical} />
        {shouldShowGroups && (activeView === 'table' ? <ActiveTableSlot {...boardProps} /> : <ActiveCards {...boardProps} />)}
      </FrameSlot>
      <FrameSlot containerId="active-view-slot">
        {activeTab === 'inprogress' && <ActiveViewSwitch />}
      </FrameSlot>
      <FrameSlot containerId="summary-strip">
        <SummaryStrip counts={pulseCounts(visibleTasks)} offFocusCount={offFocusCount(visibleTasks, offFocusSlugs)}>
          {activeTab === 'inprogress' && (
            <>
              {isBabysitWired() && <PushForwardPill tasks={visibleTasks} decisionContext={decisionContext(snapshot.settings)} />}
              <NewTaskPill projectOptions={options} />
            </>
          )}
        </SummaryStrip>
      </FrameSlot>
      <FrameSlot containerId="filter-project-chips">
        <FilterChips options={options} selected={selected} onToggle={toggle} />
      </FrameSlot>
      {isWeeklyFocusEnabled && <WeeklyFocus text={snapshot.weeklyFocus} now={new Date(nowMs)} />}
      <GlobalProgress activeProject={snapshot.activeProject} />
    </>
  )
}
