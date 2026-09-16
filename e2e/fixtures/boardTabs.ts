import type { Page } from '@playwright/test'

// The board's three panels are Backlog / In Progress / Done again, and only
// the selected one is in the DOM's flow — so any spec that touches a backlog
// row or a done row has to select that tab first. This is the single
// implementation of "get me to that panel": board-redesign.spec.ts and
// backlog-batch-dispatch.spec.ts both route through it rather than each
// keeping their own click.
export type BoardTab = 'backlog' | 'inprogress' | 'done'

const PANEL_TESTID: Record<BoardTab, string> = {
  backlog: 'backlog-section',
  inprogress: 'active-sessions',
  done: 'done-section',
}

// Selects `tab` on an already-loaded board and waits for its panel to be
// visible, so callers can act on the panel's contents immediately.
export async function selectBoardTab(page: Page, tab: BoardTab): Promise<void> {
  await page.getByTestId(`tab-btn-${tab}`).click()
  await page.getByTestId(PANEL_TESTID[tab]).waitFor({ state: 'visible' })
}

// Loads the board and lands on `tab` — the common case, since a spec that
// wants a non-default panel almost always wants it straight off a fresh load.
export async function gotoBoardTab(page: Page, tab: BoardTab): Promise<void> {
  await page.goto('/')
  await selectBoardTab(page, tab)
}
