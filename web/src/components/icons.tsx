// The dashboard's inline SVG icons, one component each — same viewBox/paths
// as the design's own icon set. Not exhaustive: only the icons the shared
// primitives actually use.

export function TerminalIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 8l4 4-4 4" />
      <path d="M12 16h7" />
    </svg>
  )
}

export function DotsIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
      <circle cx="12" cy="5.5" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="12" cy="18.5" r="1.7" />
    </svg>
  )
}

export function CopyIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M15 5.5A2.5 2.5 0 0 0 12.5 3h-7A2.5 2.5 0 0 0 3 5.5v7A2.5 2.5 0 0 0 5.5 15" />
    </svg>
  )
}

export function ParentLinkIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 19V9a3 3 0 0 1 3-3h8" />
      <path d="M15.5 2.5 19 6l-3.5 3.5" />
    </svg>
  )
}

export function DesignBranchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="7" cy="5" r="2.2" />
      <circle cx="7" cy="19" r="2.2" />
      <circle cx="17" cy="9" r="2.2" />
      <path d="M7 7.2v9.6" />
      <path d="M17 11.2c0 3.4-3 4.3-6.6 5.2" />
    </svg>
  )
}

// The header's orchestrator "home" glyph (the design's inline SVG). The class/testid are the header pill's own hooks, so they
// ride along as props rather than being baked in for a second caller.
export function HomeIcon({ className, testId }: { className?: string; testId?: string }) {
  return (
    <svg className={className} data-testid={testId} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 11l8-6.5 8 6.5" />
      <path d="M6 9.5V19a1 1 0 0 0 1 1h3.5v-5h3v5H17a1 1 0 0 0 1-1V9.5" />
    </svg>
  )
}

// The arrow glyph a stage panel's live primary CTA carries.
// The header's Back pill and the milestone drill-down's parent link draw the
// identical arrow; CtaArrowIcon below points the other way.
export function BackArrowIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 12H6M11.5 18l-6-6 6-6" />
    </svg>
  )
}

export function CtaArrowIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h13M12.5 6l6 6-6 6" />
    </svg>
  )
}

export function BranchIcon() {
  return (
    <svg className="branch-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  )
}

// The sidebar tab bar's three glyphs.
export function ActiveTabIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z" />
      <path d="M10 8.5l5.5 3.5L10 15.5z" />
    </svg>
  )
}

export function BacklogTabIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l9 5-9 5-9-5 9-5z" />
      <path d="M3 12l9 5 9-5" />
      <path d="M3 16.5l9 5 9-5" />
    </svg>
  )
}

export function DoneTabIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z" />
      <path d="M8.2 12.3l2.6 2.6 5-5.4" />
    </svg>
  )
}

export function AccountAvatarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
  )
}

export function AccountChevronIcon() {
  return (
    <svg className="sidebar-account-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 10l5 5 5-5" />
    </svg>
  )
}

// The backlog row/batch-bar glyphs and the done row's chevron.
export function PlayIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
      <path d="M7 5l12 7-12 7V5z" />
    </svg>
  )
}

export function EditIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20h4l10-10-4-4L4 16z" />
      <path d="M14.5 5.5l4 4" />
    </svg>
  )
}

export function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M4 7h16" strokeLinecap="round" />
      <path d="M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 7l1 13a2 2 0 002 2h6a2 2 0 002-2l1-13" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 11v6" strokeLinecap="round" />
      <path d="M14 11v6" strokeLinecap="round" />
    </svg>
  )
}

export function ChevronRightIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

export function SidebarCollapseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <path d="M10 4.5v15" />
    </svg>
  )
}

export function MenuIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  )
}

export function FilterIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
      <path d="M4 6h16M7 12h10M10 18h4" />
    </svg>
  )
}

const SIDEBAR_FOOT_ICON_PROPS = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export function SettingsIcon() {
  return (
    <svg {...SIDEBAR_FOOT_ICON_PROPS}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7" />
    </svg>
  )
}

export function DocsIcon() {
  return (
    <svg {...SIDEBAR_FOOT_ICON_PROPS}>
      <path d="M6.5 3.5h8l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 6.5 3.5z" />
      <path d="M14 3.5V8h4.5" />
      <path d="M8.5 12h7M8.5 15.5h7M8.5 8.5h2.5" />
    </svg>
  )
}

export function HelpIcon() {
  return (
    <svg {...SIDEBAR_FOOT_ICON_PROPS}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.6" />
      <path d="M12 16.6h.01" />
    </svg>
  )
}
