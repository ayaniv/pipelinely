import { test, expect } from '@playwright/test'
import { gotoBoardTab, selectBoardTab } from './fixtures/boardTabs'
import { TOKEN, PAGE_COLUMN, DESKTOP, WIDE, DESKTOP_GUTTER, cssOf } from './fixtures/designTokens'

// M0 of the Claude Design v2 alignment: the page frame and the app shell.
//
// The design lays every one of its three pages out as ONE centred column —
// `max-width:1180px; margin:0 auto; padding:14px clamp(16px,2.6vw,32px) 64px`
// (Pipelinely Dashboard v2.dc.html line 133 and the identical wrapper in
// Pipelinely Pipeline.dc.html / Pipelinely Milestone.dc.html). This repo
// instead grew a per-section `padding:0 28px 24px; max-width:1280px`, plus
// `max-width:720px` readability caps on the backlog list, the done groups,
// the batch bar and the heatmap. Those caps are what this milestone removes:
// in the design those cards span the whole column.
//
// The other half of M0 is the shell — the sidebar's app mark (a real PNG the
// design ships and this repo never had, which also doubles as the collapse
// toggle), the sidebar tab's own token colours, and the design's single empty
// state replacing three different bespoke ones.
//
// Fixture data lives in e2e/fixtures/tasks (see playwright.config.ts).
//
// Landed as part of M0 — every case below was committed red with a
// `@pending` tag (so VERIFY's `--grep-invert @pending` could keep the gate
// reachable while the milestone was in flight) and the tag is now removed,
// per M0's own definition of done.

test.use({ colorScheme: 'light', viewport: DESKTOP })

// The one project with no done task, so filtering to it is how a spec reaches
// the Done tab's empty state without deleting fixtures.
const PROJECT_WITHOUT_DONE = 'acme-web'

test.describe('page column', () => {
  test('the board renders inside the design\'s 1180px column with its own gutters', async ({ page }) => {
    await page.goto('/')

    const column = page.getByTestId('board-column')
    expect(await cssOf(column, 'max-width')).toBe(PAGE_COLUMN.maxWidth)
    expect(await cssOf(column, 'padding-top')).toBe(PAGE_COLUMN.paddingTop)
    expect(await cssOf(column, 'padding-bottom')).toBe(PAGE_COLUMN.paddingBottom)
    // clamp(16px,2.6vw,32px) at a 1280px viewport: 2.6vw is 33.28px, so the
    // clamp pins to its maximum. Pinning the viewport (test.use above) is
    // what turns the clamp into one expected value.
    expect(await cssOf(column, 'padding-left')).toBe(DESKTOP_GUTTER)
    expect(await cssOf(column, 'padding-right')).toBe(DESKTOP_GUTTER)
  })

  test('the task detail view uses the same 1180px column', async ({ page }) => {
    await page.goto('/task/dev-ready')
    await expect(page.getByTestId('task-detail')).toBeVisible()

    const overlay = page.getByTestId('task-detail')
    expect(await cssOf(overlay, 'max-width')).toBe(PAGE_COLUMN.maxWidth)
    expect(await cssOf(overlay, 'padding-top')).toBe(PAGE_COLUMN.paddingTop)
    expect(await cssOf(overlay, 'padding-bottom')).toBe(PAGE_COLUMN.paddingBottom)
    expect(await cssOf(overlay, 'padding-left')).toBe(DESKTOP_GUTTER)
  })
})

// Centring is only observable while the main area is genuinely wider than the
// column — at DESKTOP the 240px sidebar leaves 1040px, so the column fills it
// and every centring check would pass without any centring at all. These two
// therefore run at WIDE (see designTokens.ts), where there is ~90px of slack
// per side to actually compare.
//
// Asserted geometrically rather than by reading `margin-left`: Chromium
// resolves an `auto` margin to its used pixel value, so a computed-style check
// could not tell "centred by auto margins" apart from "happens to start at x".
test.describe('page column is centred', () => {
  test.use({ viewport: WIDE })

  const slackDelta = async (page: import('@playwright/test').Page, testId: string) => {
    const main = await page.locator('.app-main').boundingBox()
    const column = await page.getByTestId(testId).boundingBox()
    expect(main).not.toBeNull()
    expect(column).not.toBeNull()
    // Guard against this describe silently going vacuous if the viewport or
    // the sidebar width ever changes.
    expect(main!.width).toBeGreaterThan(column!.width)
    const left = column!.x - main!.x
    const right = (main!.x + main!.width) - (column!.x + column!.width)
    return Math.abs(left - right)
  }

  test('the board column is centred, not left-aligned', async ({ page }) => {
    await page.goto('/')
    expect(await slackDelta(page, 'board-column')).toBeLessThanOrEqual(1)
  })

  test('the task detail column is centred, not left-aligned', async ({ page }) => {
    await page.goto('/task/dev-ready')
    await expect(page.getByTestId('task-detail')).toBeVisible()
    expect(await slackDelta(page, 'task-detail')).toBeLessThanOrEqual(1)
  })
})

// Direct coverage for the head script's own sidebar-collapsed-init handoff
// (this test's own centering check above only covers it indirectly, by not
// flaking). A MutationObserver installed via addInitScript — so it's wired
// up before any of the page's own scripts run — records whether #app-sidebar
// exists in the DOM at the moment the class is each added/removed, which is
// what actually proves the ordering: added while <head> is still running
// (the sidebar element doesn't exist yet), removed only after the main
// script's own applySidebarCollapsed call (the sidebar element now does).
test.describe('sidebar pre-hydration collapse', () => {
  test.use({ viewport: DESKTOP })

  test('the class is added before the sidebar exists, and removed once it does', async ({ page }) => {
    await page.addInitScript(() => {
      ;(window as any).__sidebarInitLog = []
      const recordMutation = () => {
        ;(window as any).__sidebarInitLog.push({
          hasClass: document.documentElement.classList.contains('sidebar-collapsed-init'),
          sidebarExists: !!document.getElementById('app-sidebar'),
        })
      }
      // addInitScript runs before the document itself has a <html> element
      // (the parser hasn't reached it yet), so documentElement must be
      // waited for rather than assumed to exist — same reasoning as the
      // head script's own note on why the real #app-sidebar can't be
      // touched this early either.
      const attachClassObserver = () =>
        new MutationObserver(recordMutation).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
      if (document.documentElement) {
        attachClassObserver()
      } else {
        const docObserver = new MutationObserver(() => {
          if (!document.documentElement) return
          docObserver.disconnect()
          attachClassObserver()
        })
        docObserver.observe(document, { childList: true })
      }
    })

    await page.goto('/task/dev-ready')
    await expect(page.getByTestId('task-detail')).toBeVisible()

    const log = await page.evaluate(() => (window as any).__sidebarInitLog)
    expect(log.length).toBeGreaterThanOrEqual(2)
    expect(log[0]).toEqual({ hasClass: true, sidebarExists: false })
    expect(log[log.length - 1]).toEqual({ hasClass: false, sidebarExists: true })

    const stillPresent = await page.evaluate(() => document.documentElement.classList.contains('sidebar-collapsed-init'))
    expect(stillPresent).toBe(false)
  })

  test('a non-task route never adds the class at all', async ({ page }) => {
    await page.goto('/')
    const hasClass = await page.evaluate(() => document.documentElement.classList.contains('sidebar-collapsed-init'))
    expect(hasClass).toBe(false)
  })
})

test.describe('720px caps are gone', () => {
  // Each of these carried `max-width:720px` before M0. The design gives them
  // no cap at all — they fill the 1180px column. `none` is what
  // getComputedStyle reports for an uncapped element.
  test('the backlog list and its batch bar fill the column', async ({ page }) => {
    await gotoBoardTab(page, 'backlog')

    expect(await cssOf(page.locator('.backlog-list'), 'max-width')).toBe('none')
    expect(await cssOf(page.getByTestId('backlog-batch-bar'), 'max-width')).toBe('none')
  })

  test('done groups fill the column', async ({ page }) => {
    await gotoBoardTab(page, 'done')

    expect(await cssOf(page.getByTestId('done-date-group').first(), 'max-width')).toBe('none')
  })

  // Split out of the case above when the heatmap moved to the You tab (see
  // e2e/you-tab.spec.ts) — same uncapped-width rule, different panel.
  test('the work-density card fills the column on the You tab', async ({ page }) => {
    await gotoBoardTab(page, 'you')

    expect(await cssOf(page.locator('.work-density'), 'max-width')).toBe('none')
  })

  // The point of removing the caps is that the cards actually get wider — a
  // rule that resolved to `none` while some ancestor still pinned 720px would
  // pass the two cases above and change nothing on screen.
  test('a done group is as wide as the column\'s content box', async ({ page }) => {
    await gotoBoardTab(page, 'done')

    const column = await page.getByTestId('board-column').boundingBox()
    const group = await page.getByTestId('done-date-group').first().boundingBox()
    const gutter = parseFloat(DESKTOP_GUTTER)
    expect(group!.width).toBeCloseTo(column!.width - gutter * 2, 0)
  })
})

test.describe('sidebar app mark', () => {
  test('the sidebar shows the design\'s 26px app-mark image', async ({ page }) => {
    await page.goto('/')

    const mark = page.getByTestId('sidebar-mark')
    await expect(mark).toBeVisible()
    expect(await cssOf(mark, 'background-image')).toContain('app-mark-v2.png')
    expect(await cssOf(mark, 'width')).toBe('26px')
    expect(await cssOf(mark, 'height')).toBe('26px')
  })

  // The design wires the mark itself to the collapse toggle
  // (`onClick="{{ toggleNav }}"` on the mark element, Dashboard v2 line 44),
  // which is a second affordance for the same state the existing
  // sidebar-collapse-toggle button already owns. Only one direction is
  // reachable through the collapse-toggle button, though: once collapsed
  // the button itself hides (see the "collapse-toggle hides" test below),
  // so re-expanding has to go through the app mark instead.
  test('clicking the collapse-toggle button collapses the sidebar, and the app mark expands it back', async ({ page }) => {
    await page.goto('/')

    const sidebar = page.getByTestId('app-sidebar')
    await expect(sidebar).not.toHaveClass(/is-collapsed/)

    await page.getByTestId('sidebar-collapse-toggle').click()
    await expect(sidebar).toHaveClass(/is-collapsed/)

    await page.getByTestId('sidebar-mark').click()
    await expect(sidebar).not.toHaveClass(/is-collapsed/)
  })

  // The design's own collapsed/expanded logo padding (navLogoPadL): 18px
  // expanded, 14px collapsed.
  test('the logo row\'s left padding follows the collapsed state', async ({ page }) => {
    await page.goto('/')

    const logoRow = page.locator('.sidebar-top')
    expect(await cssOf(logoRow, 'padding-left')).toBe('18px')

    await page.getByTestId('sidebar-collapse-toggle').click()
    await expect(page.getByTestId('app-sidebar')).toHaveClass(/is-collapsed/)
    expect(await cssOf(logoRow, 'padding-left')).toBe('14px')
  })

  // Collapsed, only the app mark should remain as the visible affordance —
  // the collapse-toggle button (which also doubles as a click target, see
  // the test above) must not double up with it side by side.
  test('the collapse-toggle button hides once the sidebar is collapsed, and the app mark stays visible', async ({ page }) => {
    await page.goto('/')

    const mark = page.getByTestId('sidebar-mark')
    const collapseBtn = page.getByTestId('sidebar-collapse-toggle')
    await expect(mark).toBeVisible()
    await expect(collapseBtn).toBeVisible()

    await page.getByTestId('sidebar-collapse-toggle').click()
    await expect(page.getByTestId('app-sidebar')).toHaveClass(/is-collapsed/)
    await expect(mark).toBeVisible()
    await expect(collapseBtn).toBeHidden()
  })

  // Once collapsed, the mark is the only reachable toggle — it must keep an
  // accurate aria-label (the same Expand/Collapse-sidebar swap the button
  // already got) rather than the static "Toggle sidebar" it starts with.
  test('the app mark\'s aria-label tracks the collapsed state', async ({ page }) => {
    await page.goto('/')

    const mark = page.getByTestId('sidebar-mark')
    await expect(mark).toHaveAttribute('aria-label', 'Collapse sidebar')

    await page.getByTestId('sidebar-collapse-toggle').click()
    await expect(page.getByTestId('app-sidebar')).toHaveClass(/is-collapsed/)
    await expect(mark).toHaveAttribute('aria-label', 'Expand sidebar')
  })
})

// The header used to be `position: sticky; top: 0`, pinning the spend/live/
// home/theme pills (and, on a task-detail view, the Back pill) across the
// top independent of scroll — a floating strip rather than part of the
// page's own layout. It should now scroll away with the rest of the page,
// and line up with the same 1180px column the board's own content uses.
test.describe('header is not pinned', () => {
  test('the header is not sticky-positioned', async ({ page }) => {
    await page.goto('/')

    const header = page.getByTestId('app-header')
    expect(await cssOf(header, 'position')).toBe('static')
  })

  // Behavioural, not just a computed-style check: with 72 fixture tasks the
  // board is tall enough to scroll, so a still-sticky header would keep its
  // bounding box pinned at the viewport top regardless of what `position`
  // resolves to.
  test('the header scrolls away with the page instead of staying pinned', async ({ page }) => {
    await page.goto('/')

    const header = page.getByTestId('app-header')
    const startBox = await header.boundingBox()
    expect(startBox).not.toBeNull()

    await page.mouse.wheel(0, 2000)
    await expect(async () => {
      const box = await header.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.y).toBeLessThan(startBox!.y)
    }).toPass()
  })

  // Matching padding alone isn't enough to align two elements once one of
  // them (the board column) is capped at 1180px and centred — at WIDE the
  // column stops growing and centres itself, so the header needs the same
  // max-width + margin:auto, not just the same horizontal padding, to land
  // on the same left/right edges.
  test('the header lines up with the board column\'s left/right edges', async ({ page }) => {
    await page.setViewportSize(WIDE)
    await page.goto('/')

    const header = await page.getByTestId('app-header').boundingBox()
    const column = await page.getByTestId('board-column').boundingBox()
    expect(header).not.toBeNull()
    expect(column).not.toBeNull()
    expect(Math.abs(header!.x - column!.x)).toBeLessThanOrEqual(1)
    expect(Math.abs((header!.x + header!.width) - (column!.x + column!.width))).toBeLessThanOrEqual(1)
  })

  // Same alignment check on the task-detail view, where the header's
  // left-most slot holds the Back pill instead of being empty.
  test('the header lines up with the task-detail column on the detail view', async ({ page }) => {
    await page.setViewportSize(WIDE)
    await page.goto('/task/dev-ready')
    await expect(page.getByTestId('task-detail')).toBeVisible()

    const header = await page.getByTestId('app-header').boundingBox()
    const detail = await page.getByTestId('task-detail').boundingBox()
    expect(header).not.toBeNull()
    expect(detail).not.toBeNull()
    expect(Math.abs(header!.x - detail!.x)).toBeLessThanOrEqual(1)
    expect(Math.abs((header!.x + header!.width) - (detail!.x + detail!.width))).toBeLessThanOrEqual(1)
  })
})

test.describe('static art assets', () => {
  // This repo's server had no static middleware at all before M0 — it served
  // public/index.html from two explicit routes and nothing else. Shipping the
  // design's PNGs therefore needs a real route, and a 404 here would leave the
  // sidebar and the section headers silently blank rather than erroring.
  test('the design PNGs are served from /art', async ({ request }) => {
    for (const file of ['app-mark-v2.png', 'head-beige-v3.png', 'head-blue-v3.png']) {
      const res = await request.get(`/art/${file}`)
      expect(res.status(), `GET /art/${file}`).toBe(200)
      expect(res.headers()['content-type']).toContain('image/png')
    }
  })

  // Failure path. `/art/../../src/server.ts` cannot prove this: Playwright
  // resolves a relative request path against baseURL with WHATWG URL
  // semantics, which collapses the `..` segments before the request is ever
  // sent — the server receives `GET /src/server.ts`, which never reaches the
  // /art mount at all and 404s from Express's own default handler regardless
  // of how (or whether) the mount is scoped. That assertion would pass
  // identically against a mount rooted at the whole checkout, i.e. against
  // the exact mistake it exists to catch — see tech-design.md's "Failure
  // path" note for this milestone.
  //
  // Two cases that can actually fail instead:
  test('the art route rejects an encoded traversal attempt', async ({ request }) => {
    // Encoded so the `..` segment survives URL normalisation and genuinely
    // reaches the mount. serve-static decodes and rejects a `..` segment
    // (403), which is what pins the mount to not following one.
    const res = await request.get('/art/%2e%2e%2f%2e%2e%2fsrc%2fserver.ts')
    expect(res.status()).not.toBe(200)
  })

  test('the art route does not also serve the rest of public/', async ({ request }) => {
    // The positive control on scope: public/index.html exists and is served
    // by name from two other routes, so a mount rooted one directory too
    // high (public/ instead of public/art) would return it 200 here too.
    const res = await request.get('/art/index.html')
    expect(res.status()).not.toBe(200)
  })
})

test.describe('sidebar tab tokens', () => {
  // The design's active nav row is `background:var(--surface2)` with a
  // `var(--border)` border and `var(--ink)` text — NOT the border2 outline and
  // accent-tinted count this repo drifted to. Its count badge flips the other
  // way from the row: `surface` when the row is active (so the badge lifts off
  // the filled row), `surface2` when it is not.
  test('the active tab row uses the design\'s own fill, border and ink', async ({ page }) => {
    await page.goto('/')

    const active = page.getByTestId('tab-btn-inprogress')
    await expect(active).toHaveClass(/is-active/)
    expect(await cssOf(active, 'background-color')).toBe(TOKEN.surface2)
    expect(await cssOf(active, 'border-top-color')).toBe(TOKEN.border)
    expect(await cssOf(active, 'color')).toBe(TOKEN.ink)

    const inactive = page.getByTestId('tab-btn-backlog')
    expect(await cssOf(inactive, 'color')).toBe(TOKEN.text2)
  })

  test('the count badge inverts its fill between the active and inactive rows', async ({ page }) => {
    await page.goto('/')

    const activeCount = page.getByTestId('tab-count-inprogress')
    expect(await cssOf(activeCount, 'background-color')).toBe(TOKEN.surface)
    expect(await cssOf(activeCount, 'border-top-color')).toBe(TOKEN.border)
    expect(await cssOf(activeCount, 'color')).toBe(TOKEN.text2)

    const inactiveCount = page.getByTestId('tab-count-backlog')
    expect(await cssOf(inactiveCount, 'background-color')).toBe(TOKEN.surface2)
    expect(await cssOf(inactiveCount, 'color')).toBe(TOKEN.text2)
  })

  test('the tab icon is ink when active and text3 when not', async ({ page }) => {
    await page.goto('/')

    const activeIcon = page.getByTestId('tab-btn-inprogress').locator('.tab-icon')
    expect(await cssOf(activeIcon, 'color')).toBe(TOKEN.ink)

    const inactiveIcon = page.getByTestId('tab-btn-backlog').locator('.tab-icon')
    expect(await cssOf(inactiveIcon, 'color')).toBe(TOKEN.text3)
  })
})

test.describe('empty state', () => {
  // The design has exactly one empty state, shared by all three tabs:
  // `padding:34px 18px; border-radius:16px; background:var(--surface);
  // border:1px solid var(--border); text-align:center; font-size:13.5px;
  // color:var(--text3)` reading "Nothing here in the selected projects."
  // This repo had three different bespoke ones (a 44px glyph, an <h2> and a
  // <p>, 100px of padding).
  test('an empty tab renders the design\'s single empty card', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('filter-toggle-btn').click()
    await page.getByTestId(`filter-chip-project-${PROJECT_WITHOUT_DONE}`).click()
    await selectBoardTab(page, 'done')

    // Scoped to the Done section: the Backlog panel is now filterable too
    // (backlog-filter-project-field), and this project has no backlog items
    // either, so an unscoped lookup would match both panels' empty states.
    const empty = page.getByTestId('done-section').getByTestId('board-empty-state')
    await expect(empty).toBeVisible()
    await expect(empty).toHaveText('Nothing here in the selected projects.')
    expect(await cssOf(empty, 'padding-top')).toBe('34px')
    expect(await cssOf(empty, 'padding-left')).toBe('18px')
    expect(await cssOf(empty, 'border-radius')).toBe('16px')
    expect(await cssOf(empty, 'background-color')).toBe(TOKEN.surface)
    expect(await cssOf(empty, 'color')).toBe(TOKEN.text3)
    expect(await cssOf(empty, 'font-size')).toBe('13.5px')
    expect(await cssOf(empty, 'text-align')).toBe('center')
  })

  // The bespoke states are gone, not merely restyled — a leftover
  // .empty-icon/<h2> would still render the old shape on whichever tab kept it.
  test('the old glyph-and-heading empty state is gone', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('filter-toggle-btn').click()
    await page.getByTestId(`filter-chip-project-${PROJECT_WITHOUT_DONE}`).click()
    await selectBoardTab(page, 'done')

    await expect(page.locator('.empty-icon')).toHaveCount(0)
    await expect(page.getByTestId('board-empty-state').locator('h2')).toHaveCount(0)
  })
})

test.describe('caption removal', () => {
  // The design's Active tab has no caption above the grid, and its own
  // attention/date sort control is disabled in the prototype and explicitly
  // "omit unless asked" in the handoff README. Both are dropped.
  test('the "sorted by attention" caption is gone', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByTestId('active-sessions-caption')).toHaveCount(0)
  })
})
