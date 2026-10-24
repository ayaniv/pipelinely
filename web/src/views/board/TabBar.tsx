import type { ReactNode } from 'react'
import { ActiveTabIcon, BacklogTabIcon, DoneTabIcon } from '../../components/icons'
import type { BoardTab } from './boardTabRoutes'

// The sidebar's tab bar: the three counted tabs. Each count lives in its own
// pill and nowhere else, so it is never rendered twice. Class names, data-tab
// and testids are exactly the design's — the stylesheet, the panels' toggling
// and ~a dozen specs key off them. The Usage tab has no count, so it is not
// here: its trigger lives in the account group (SidebarAccount.tsx).

const UNLOADED_COUNT = '–'

export type CountedTab = Exclude<BoardTab, 'usage'>

interface CountedTabDefinition {
  tab: CountedTab
  label: string
  icon: ReactNode
}

const COUNTED_TABS: CountedTabDefinition[] = [
  { tab: 'inprogress', label: 'Active', icon: <ActiveTabIcon /> },
  { tab: 'done', label: 'Done', icon: <DoneTabIcon /> },
  { tab: 'backlog', label: 'Backlog', icon: <BacklogTabIcon /> },
]

export interface TabBarProps {
  // null: the page showing is none of the tabs (the Bookmarks page), so none is current.
  activeTab: BoardTab | null
  // null until the first snapshot: an unloaded count is not zero.
  counts: Record<CountedTab, number | null>
  onSelectTab: (tab: BoardTab) => void
}

export function TabBar({ activeTab, counts, onSelectTab }: TabBarProps) {
  return (
    <>
      {COUNTED_TABS.map(({ tab, label, icon }) => (
        <button
          key={tab}
          type="button"
          className={`tab-btn${activeTab === tab ? ' is-active' : ''}`}
          data-tab={tab}
          data-testid={`tab-btn-${tab}`}
          aria-current={activeTab === tab ? 'page' : undefined}
          aria-label={`${label}, ${counts[tab] ?? 'loading'}`}
          onClick={() => onSelectTab(tab)}
        >
          <span className="tab-icon" aria-hidden="true">{icon}</span>
          <span className="tab-label" data-testid={`tab-label-${tab}`}>{label}</span>
          <span className="tab-count" aria-hidden="true" data-testid={`tab-count-${tab}`}>{counts[tab] ?? UNLOADED_COUNT}</span>
        </button>
      ))}
    </>
  )
}
