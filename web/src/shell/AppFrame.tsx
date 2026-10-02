import { useLayoutEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import { BOARD_TABS, type BoardTab } from '../views/board/boardTabRoutes'
import { DocsIcon, FilterIcon, HelpIcon, MenuIcon, SettingsIcon, SidebarCollapseIcon } from '../components/icons'
import { navigateToUrl } from './appNavigation'
import { sidebarStore, useSidebarState } from './sidebarState'

// The page's frame: the sidebar, the header, and the board's scaffolding (the
// weekly-focus hero, the toolbar, the filter row and the four tab panels).
// It owns the layout and the state that belongs to it (sidebar collapse and
// drawer, the filter row's visibility, which panel shows); what fills each
// region is a view's own business, mounted by portal into the region's id
// (components/FrameSlot.tsx) — so a view never has to know its surroundings,
// and the frame never has to know its contents.
//
// Because those views look their container up by id, they must not render
// until the frame's own DOM exists: `slots` and `children` are held back until
// a layout effect has run, which is before the first paint.

const PANELS: { tab: BoardTab; element: 'main' | 'section'; id: string; testId: string; className: string }[] = [
  { tab: 'inprogress', element: 'main', id: 'dashboard', testId: 'active-sessions', className: 'tab-panel' },
  { tab: 'backlog', element: 'section', id: 'backlog-section', testId: 'backlog-section', className: 'tab-panel backlog-section' },
  { tab: 'done', element: 'section', id: 'done-section', testId: 'done-section', className: 'tab-panel done-section' },
  { tab: 'you', element: 'section', id: 'you-section', testId: 'you-section', className: 'tab-panel you-section' },
]

function TabPanel({ panel, activeTab, children }: { panel: (typeof PANELS)[number]; activeTab: BoardTab; children?: ReactNode }) {
  const Element = panel.element
  return (
    <Element className={`${panel.className}${panel.tab === activeTab ? ' is-active' : ''}`} id={panel.id} data-tab-panel={panel.tab} data-testid={panel.testId}>
      {children}
    </Element>
  )
}

function Sidebar() {
  const { isCollapsed, isMobileOpen } = useSidebarState()
  const collapseLabel = isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'

  // The app mark is a second affordance for the same toggle the collapse
  // button owns — one shared handler rather than a second copy of the logic.
  const handleMarkKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    sidebarStore.toggleCollapsed()
  }

  return (
    <>
      <div className={`sidebar-scrim${isMobileOpen ? ' is-visible' : ''}`} id="sidebar-scrim" data-testid="sidebar-scrim" onClick={sidebarStore.closeMobile} />
      <aside className={`app-sidebar${isCollapsed ? ' is-collapsed' : ''}${isMobileOpen ? ' is-mobile-open' : ''}`} id="app-sidebar" data-testid="app-sidebar">
        <div className="sidebar-top">
          {/* The only reachable toggle once collapsed (the button hides — see its own CSS), so it carries the same accurate label the button gets. */}
          <div className="sidebar-mark" id="sidebar-mark" data-testid="sidebar-mark" role="button" tabIndex={0} aria-label={collapseLabel} title={collapseLabel} onClick={sidebarStore.toggleCollapsed} onKeyDown={handleMarkKeyDown} />
          <div className="sidebar-wordmark" data-testid="header-wordmark">pipeline<span>ly</span>.cc</div>
          <button className="sidebar-collapse-btn" id="sidebar-collapse-toggle" type="button" data-testid="sidebar-collapse-toggle" aria-label={collapseLabel} title={collapseLabel} onClick={sidebarStore.toggleCollapsed}>
            <SidebarCollapseIcon />
          </button>
        </div>

        {/* The three counted tabs: React (views/board/TabBar.tsx), portalled in. Persistent in the sidebar, not hidden while a task detail is open — switching sections never requires backing out of a detail view first. */}
        <nav className="tab-bar" id="tab-bar" data-testid="tab-bar" />

        <div className="sidebar-spacer" />

        <div className="sidebar-foot">
          <button type="button" className="sidebar-foot-item" id="sidebar-settings-btn" data-testid="sidebar-settings-btn" aria-label="Open settings" onClick={() => navigateToUrl('/settings')}>
            <span className="sidebar-foot-icon" aria-hidden="true"><SettingsIcon /></span>
            <span className="sidebar-foot-label">Settings</span>
          </button>
          <button type="button" className="sidebar-foot-item" id="sidebar-docs-btn" data-testid="sidebar-docs-btn" aria-label="Open docs" onClick={() => navigateToUrl('/docs')}>
            <span className="sidebar-foot-icon" aria-hidden="true"><DocsIcon /></span>
            <span className="sidebar-foot-label">Docs</span>
          </button>
          <button type="button" className="sidebar-foot-item" id="sidebar-help-btn" data-testid="sidebar-help-btn" aria-label="Open help" onClick={() => navigateToUrl('/help')}>
            <span className="sidebar-foot-icon" aria-hidden="true"><HelpIcon /></span>
            <span className="sidebar-foot-label">Help</span>
          </button>
        </div>

        {/* The You tab trigger: React (views/board/TabBar.tsx), portalled in. */}
        <div className="sidebar-account-slot" id="sidebar-account-slot" />
      </aside>
    </>
  )
}

export interface AppFrameProps {
  activeTab: BoardTab
  // Views that portal into the frame's regions — held back until they exist.
  slots: ReactNode
  // The route's own content (a task detail), rendered after the board inside
  // the main column so it shares the column's width.
  children: ReactNode
}

export function AppFrame({ activeTab, slots, children }: AppFrameProps) {
  const [isFrameMounted, setIsFrameMounted] = useState(false)
  useLayoutEffect(() => setIsFrameMounted(true), [])
  // The filter row is board-wide (it narrows Active, Backlog and Done), so it
  // sits above the tabbed panels. Hidden on You along with the rest of the
  // toolbar chrome (CSS, off `data-active-tab`).
  const [isFilterOpen, setIsFilterOpen] = useState(false)

  return (
    <div className="app-shell">
      <Sidebar />

      <div className="app-main">
        <header data-testid="app-header">
          <button className="hamburger-btn" id="sidebar-open-toggle" type="button" data-testid="sidebar-open-toggle" aria-label="Open menu" onClick={sidebarStore.openMobile}>
            <MenuIcon />
          </button>
          <div className="header-back-slot" id="header-back-slot" data-testid="header-back-slot" />
          {/* Empty on purpose: the ctx pill, spend, live status, auto-submit and theme toggles are React (views/header), portalled in. A static element so the header's own flex layout (.header-chrome in app.css) doesn't move. */}
          <div className="header-chrome" id="header-chrome" />
        </header>
        <div className="read-only-banner-slot" id="read-only-banner-slot" />
        <div className="global-progress" id="global-progress" />

        <div id="board" className="board page-column" data-testid="board-column" data-active-tab={activeTab}>
          {/* A WEEKLY focus (persisted server-side via POST /weekly-focus): click-to-edit, multi-line. Visible on Active/Backlog/Done, hidden on You along with the toolbar and filters — You shows just the chart. */}
          <div className="focus-hero" id="weekly-focus">
            <div className="focus-hero-overlay" aria-hidden="true" />
            <div className="focus-hero-body">
              <div className="focus-hero-eyebrow">
                <span>focus for this week</span>
                <span className="focus-hero-dates">· <span id="weekly-focus-dates" /></span>
              </div>
              <div className="focus-hero-row" id="weekly-focus-row" />
            </div>
          </div>

          <div className="board-toolbar">
            <div className="summary-strip" id="summary-strip" data-testid="summary-strip" />
            <div className="board-toolbar-right">
              <button className={`filter-toggle-btn${isFilterOpen ? ' is-active' : ''}`} id="filter-toggle-btn" type="button" data-testid="filter-toggle-btn" aria-expanded={isFilterOpen} onClick={() => setIsFilterOpen((isOpen) => !isOpen)}>
                <FilterIcon />
                <span>filter</span>
              </button>
              {/* copy-standup: React (views/board/StandupButton.tsx), Done tab only, portalled in. */}
              <div className="standup-slot" id="standup-slot" />
            </div>
          </div>

          <div className="board-filters" id="board-filters" data-testid="board-filters" hidden={!isFilterOpen}>
            <div className="filter-chips" id="filter-project-chips" data-testid="filter-project-chips" />
          </div>

          {BOARD_TABS.map((tab) => {
            const panel = PANELS.find((candidate) => candidate.tab === tab)!
            return (
              <TabPanel key={tab} panel={panel} activeTab={activeTab}>
                {tab === 'inprogress' && <div className="active-cards" id="active-cards" />}
                {tab === 'done' && <div id="done-groups" />}
                {tab === 'you' && <div id="work-density" data-testid="work-density" />}
              </TabPanel>
            )
          })}
        </div>

        {isFrameMounted && children}
      </div>
      {isFrameMounted && slots}
    </div>
  )
}
