import { useEffect } from 'react'
import { FrameSlot } from '../../components/FrameSlot'
import { clientState, useClientState } from '../../data/clientState'
import { navigateToTask } from '../../shell/appNavigation'
import { useNow } from '../../useNow'
import { ActiveCards } from './ActiveCards'
import { pulseCounts } from './boardModel'
import { projectFilterStore, type ProjectFilterStore } from './boardFilter'
import { useBoardFilterView } from './useBoardFilterView'
import { FilterChips } from './FilterChips'
import { GlobalProgress } from './GlobalProgress'
import { SummaryStrip } from './SummaryStrip'
import { WeeklyFocus } from './WeeklyFocus'

// The active board. Every piece renders by portal into a container the app
// frame owns (shell/AppFrame.tsx) — the Backlog/Done/You panels and the
// sidebar tab bar are BoardTabs. Driven entirely by the snapshot cache. It
// owns the filter chips and the store's pruning; every board view reads the
// filter through useBoardFilterView.

// The 30-second tick that keeps a card's
// relative time ("5m ago") current.
const CLOCK_TICK_MS = 30_000

export interface ActiveBoardProps {
  filterStore?: ProjectFilterStore
}

export function ActiveBoard({ filterStore = projectFilterStore }: ActiveBoardProps) {
  const { snapshot, options, selected, visibleTasks, toggle, prune } = useBoardFilterView(filterStore)
  const nowMs = useNow(CLOCK_TICK_MS)
  // Off-focus is shared client state; a toggle from any surface notifies here
  // rather than arriving in a snapshot.
  useClientState()

  const optionsKey = options.join('\n')

  // A selection pointing at a project that no longer exists is treated as
  // already dropped for this render (useBoardFilterView), then actually
  // dropped here — never an empty board with no way to see why.
  useEffect(() => {
    if (snapshot) prune(optionsKey === '' ? [] : optionsKey.split('\n'))
  }, [snapshot, optionsKey, prune])

  if (!snapshot) return null

  return (
    <>
      <FrameSlot containerId="active-cards">
        <ActiveCards tasks={visibleTasks} now={nowMs} isTaskOffFocus={clientState.isOffFocus} onToggleOffFocus={clientState.toggleOffFocus} onOpenDetail={navigateToTask} />
      </FrameSlot>
      <FrameSlot containerId="summary-strip">
        <SummaryStrip counts={pulseCounts(visibleTasks)} />
      </FrameSlot>
      <FrameSlot containerId="filter-project-chips">
        <FilterChips options={options} selected={selected} onToggle={toggle} />
      </FrameSlot>
      <WeeklyFocus text={snapshot.weeklyFocus} now={new Date(nowMs)} />
      <GlobalProgress activeProject={snapshot.activeProject} />
    </>
  )
}
