import type { ReactNode } from 'react'
import { AccountAvatarIcon, AccountChevronIcon, ActiveTabIcon, BacklogTabIcon, DoneTabIcon } from '../../components/icons'
import type { BoardTab } from './boardTabRoutes'

// The sidebar's tab bar: the three counted tabs, plus the account row that is
// the You tab's trigger (it has no count, so it was never a .tab-btn). Each
// count lives in its own pill and nowhere else, so it is never rendered
// twice. Class names, data-tab and testids are exactly the design's —
// the stylesheet, the panels' toggling and ~a dozen specs key off them.

const UNLOADED_COUNT = '–'

export type CountedTab = Exclude<BoardTab, 'you'>

interface CountedTabDefinition {
  tab: CountedTab
  label: string
  icon: ReactNode
}

const COUNTED_TABS: CountedTabDefinition[] = [
  { tab: 'inprogress', label: 'Active', icon: <ActiveTabIcon /> },
  { tab: 'backlog', label: 'Backlog', icon: <BacklogTabIcon /> },
  { tab: 'done', label: 'Done', icon: <DoneTabIcon /> },
]

export interface TabBarProps {
  activeTab: BoardTab
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

export interface SidebarAccountProps {
  activeTab: BoardTab
  onSelectTab: (tab: BoardTab) => void
}

export function SidebarAccount({ activeTab, onSelectTab }: SidebarAccountProps) {
  return (
    <button
      type="button"
      className={`sidebar-account${activeTab === 'you' ? ' is-active' : ''}`}
      data-tab="you"
      data-testid="sidebar-account"
      aria-label="You"
      aria-current={activeTab === 'you' ? 'page' : undefined}
      onClick={() => onSelectTab('you')}
    >
      <div className="sidebar-avatar" aria-hidden="true"><AccountAvatarIcon /></div>
      <span className="sidebar-account-name">You</span>
      <AccountChevronIcon />
    </button>
  )
}
