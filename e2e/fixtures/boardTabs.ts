import type { Page } from '@playwright/test'

// The board's panels are Backlog / In Progress / Done / Usage, and only the
// selected one is in the DOM's flow — so any spec that touches a backlog
// row, a done row or the work-density heatmap has to select that tab first.
// This is the single implementation of "get me to that panel":
// board-redesign.spec.ts and backlog-batch-dispatch.spec.ts both route
// through it rather than each keeping their own click.
export type BoardTab = 'backlog' | 'inprogress' | 'done' | 'usage'

const PANEL_TESTID: Record<BoardTab, string> = {
  backlog: 'backlog-section',
  inprogress: 'active-sessions',
  done: 'done-section',
  usage: 'usage-section',
}

// Usage is the one tab whose trigger is NOT a .tab-btn in #tab-bar: it is an
// item in the sidebar account group (see SidebarAccount in
// web/src/views/board/SidebarAccount.tsx), so it has no tab-count-* of its
// own. Every other tab keeps the tab-btn-<name> convention.
const TRIGGER_TESTID: Record<BoardTab, string> = {
  backlog: 'tab-btn-backlog',
  inprogress: 'tab-btn-inprogress',
  done: 'tab-btn-done',
  usage: 'sidebar-usage-btn',
}

// Settings, Usage, Docs and Help live in the account group, which starts
// closed and hides its items. This is the one place that opens it, so every
// spec that clicks one of those items goes through here instead of clicking
// the item directly.
export async function openSidebarItem(page: Page, testId: string): Promise<void> {
  const account = page.getByTestId('sidebar-account')
  if ((await account.getAttribute('aria-expanded')) !== 'true') await account.click()
  await page.getByTestId(testId).click()
}

// Selects `tab` on an already-loaded board and waits for its panel to be
// visible, so callers can act on the panel's contents immediately.
export async function selectBoardTab(page: Page, tab: BoardTab): Promise<void> {
  if (tab === 'usage') await openSidebarItem(page, TRIGGER_TESTID.usage)
  else await page.getByTestId(TRIGGER_TESTID[tab]).click()
  await page.getByTestId(PANEL_TESTID[tab]).waitFor({ state: 'visible' })
}

// Loads the board and lands on `tab` — the common case, since a spec that
// wants a non-default panel almost always wants it straight off a fresh load.
// `origin` is '' for the shared (non-canonical) webServer's own baseURL, or a
// canonical test server's own absolute origin — see
// orchestrator-session-self-heal.spec.ts's own openTask for the same
// convention, needed by any spec whose backlog CTAs must render enabled
// (canonical-dispatch-gate proactively disables them on a non-canonical
// instance — see BacklogView.tsx).
export async function gotoBoardTab(page: Page, tab: BoardTab, origin = ''): Promise<void> {
  await page.goto(`${origin}/`)
  await selectBoardTab(page, tab)
}
