import { useState, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { AccountAvatarIcon, AccountChevronIcon, DocsIcon, HelpIcon, SettingsIcon, UsageIcon } from '../../components/icons'
import { navigateToUrl } from '../../shell/appNavigation'
import { accountItemForPath, type AccountItemId } from './accountItemRoutes'
import type { BoardTab } from './boardTabRoutes'

// The sidebar's account row and the group it toggles: Settings, Usage, Docs
// and Help. One component owns both, because the toggle's state and the items
// it reveals must live together. The items keep the `.sidebar-foot-item` class
// (the collapsed-sidebar CSS keys off it) and the ids/testids the specs use.
// Usage is the one item that selects a board tab; the rest are full pages.
// The current item comes from the URL, not the remembered board tab, so it is
// the page actually showing. While the group is closed the account row is
// marked while Usage is current, since the closed group hides that item;
// opened, the item carries the mark and the row does not.

const ACCOUNT_MENU_ID = 'sidebar-account-menu'

interface GroupItem {
  id: string
  item: AccountItemId
  label: string
  ariaLabel: string
  icon: ReactNode
  activate: () => void
}

export interface SidebarAccountProps {
  onSelectTab: (tab: BoardTab) => void
}

export function SidebarAccount({ onSelectTab }: SidebarAccountProps) {
  const [isOpen, setIsOpen] = useState(false)
  const currentItem = accountItemForPath(useLocation().pathname)

  const items: GroupItem[] = [
    { id: 'sidebar-settings-btn', item: 'settings', label: 'Settings', ariaLabel: 'Open settings', icon: <SettingsIcon />, activate: () => navigateToUrl('/settings') },
    { id: 'sidebar-usage-btn', item: 'usage', label: 'Usage', ariaLabel: 'Open usage', icon: <UsageIcon />, activate: () => onSelectTab('usage') },
    { id: 'sidebar-docs-btn', item: 'docs', label: 'Docs', ariaLabel: 'Open docs', icon: <DocsIcon />, activate: () => navigateToUrl('/docs') },
    { id: 'sidebar-help-btn', item: 'help', label: 'Help', ariaLabel: 'Open help', icon: <HelpIcon />, activate: () => navigateToUrl('/help') },
  ]

  // Only Usage marks the row: it is the one item that is a board tab, and the
  // row stands in for it while the group hides it. The other items are
  // overlay pages that already read as such.
  const isAccountRowMarked = !isOpen && currentItem === 'usage'

  return (
    <>
      {/* `inert` while closed: the items are clipped to zero height, but without it they would still be tabbable. */}
      <div className="sidebar-account-menu" id={ACCOUNT_MENU_ID} data-testid="sidebar-account-menu" data-open={String(isOpen)} inert={!isOpen}>
        <div className="sidebar-account-menu-clip">
          <div className="sidebar-account-menu-items">
            {items.map(({ id, item, label, ariaLabel, icon, activate }) => {
              const isCurrent = item === currentItem
              return (
                <button
                  key={id}
                  type="button"
                  className={`sidebar-foot-item${isCurrent ? ' is-active' : ''}`}
                  id={id}
                  data-testid={id}
                  aria-label={ariaLabel}
                  aria-current={isCurrent ? 'page' : undefined}
                  onClick={activate}
                >
                  <span className="sidebar-foot-icon" aria-hidden="true">{icon}</span>
                  <span className="sidebar-foot-label">{label}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
      <button
        type="button"
        className={`sidebar-account${isAccountRowMarked ? ' is-active' : ''}`}
        data-testid="sidebar-account"
        aria-label="You"
        aria-expanded={isOpen}
        aria-controls={ACCOUNT_MENU_ID}
        onClick={() => setIsOpen((wasOpen) => !wasOpen)}
      >
        <div className="sidebar-avatar" aria-hidden="true"><AccountAvatarIcon /></div>
        <span className="sidebar-account-name">You</span>
        <AccountChevronIcon />
      </button>
    </>
  )
}
