import { test, expect, type Page } from '@playwright/test'
import { openTask } from './fixtures/taskDetail.js'
import { TOKEN, DESKTOP, cssOf } from './fixtures/designTokens.js'

// The task-detail page — head, status line, slug row, parent-link chip, ctx
// row, meta row, actions row, the fanout-parent-only 3-column stepper, and the
// per-session breakdown — is a React component (web/src/views/task-detail),
// built from shared primitives (web/src/components) and a typed action API
// (web/src/api/actions.ts). `.detail-fanout` holds two slots: a graph slot
// (React Flow) and a panel slot (web/src/views/task-detail/panel).
//
// This spec covers what the other task-detail specs have no reason to check:
// that the frame really is React, that the graph/panel split exists and both
// slots render, that the typed action API observes and surfaces a failure
// (logs it, not just flashes the button), and that React's reconciliation is
// what protects a click against a same-content SSE push landing
// mid-gesture. The other task-detail-view specs (design-v2-task-detail,
// detail-stages-redesign, stepper-node-grouping, stage-scope-summary,
// plan-summary, plannotator-button, task-detail-url,
// task-detail-sidenav-and-parent-link, handover-dispatch, pipelinely-merge-gate,
// batch-dispatch-staging) are not re-proved here.

const FLAT_SLUG = 'dev-ready'
const FANOUT_SLUG = 'fanout-parent'
const shell = (page: Page) => page.getByTestId('react-shell')

function collectPageErrors(page: Page): Error[] {
  const errors: Error[] = []
  page.on('pageerror', (err) => errors.push(err))
  return errors
}

test.describe('react task detail: frame ownership', () => {
  test('opening a task renders the detail frame inside the React shell at data-route="task", with no page errors', async ({ page }) => {
    const pageErrors = collectPageErrors(page)
    await openTask(page, FLAT_SLUG)

    await expect(shell(page)).toHaveAttribute('data-route', 'task')
    await expect(shell(page).getByTestId('task-detail')).toBeVisible()
    // Exactly one — a duplicate would make every testid lookup below
    // strict-mode-fail.
    await expect(page.getByTestId('task-detail')).toHaveCount(1)
    expect(pageErrors, pageErrors.map(String).join('\n')).toEqual([])
  })

  test('navigating back to the board unmounts the frame entirely, not just hides it', async ({ page }) => {
    await openTask(page, FLAT_SLUG)
    await page.getByTestId('detail-close').click()

    await expect(shell(page)).toHaveAttribute('data-route', 'inprogress')
    // toBeHidden() also passes for "not in the DOM at all" — the stronger
    // claim (no static overlay left behind for React to have hidden) is the
    // count.
    await expect(page.getByTestId('task-detail')).toHaveCount(0)
  })

  test('switching from one task straight to another resets the frame rather than reusing stale state', async ({ page }) => {
    await openTask(page, FLAT_SLUG)
    await expect(page.locator('#detail-title')).toHaveText('Dev ready fixture')

    await page.goto(`/task/${FANOUT_SLUG}`)
    await expect(page.getByTestId('task-detail')).toHaveCount(1)
    await expect(page.locator('#detail-title')).not.toHaveText('Dev ready fixture')
  })
})

test.describe('react task detail: fanout graph/panel split', () => {
  // dev-ready is a flat task — FLAT_CHAIN_STAGES's chain (renderStageChain)
  // is the graph slot's content, the React stage panel's l2-panel is the
  // panel slot's.
  test('the fanout container carries two distinct slots, graph and panel, both populated', async ({ page }) => {
    await openTask(page, FLAT_SLUG)

    const fanout = page.getByTestId('detail-fanout')
    await expect(fanout).toBeVisible()

    const graphSlot = fanout.getByTestId('detail-graph-slot')
    const panelSlot = fanout.getByTestId('detail-panel-slot')
    await expect(graphSlot).toBeVisible()
    await expect(panelSlot).toBeVisible()

    // Content proof, not just presence.
    await expect(graphSlot.getByTestId('stage-chain')).toBeVisible()
    await expect(panelSlot.getByTestId('l2-panel')).toBeVisible()
  })

  // The fan-out PARENT case draws a wave graph with no separate l2-panel —
  // the split still has to hold a fan-out parent's whole graph without
  // erroring on the (deliberately empty) panel slot.
  test('a fan-out parent (wave grid, not a stage chain) still renders inside the graph slot with an empty panel slot', async ({ page }) => {
    await openTask(page, FANOUT_SLUG)

    const fanout = page.getByTestId('detail-fanout')
    const graphSlot = fanout.getByTestId('detail-graph-slot')
    // M3: the wave grid is a React Flow canvas now.
    await expect(graphSlot.getByTestId('milestone-flow')).toBeVisible()
    await expect(fanout.getByTestId('detail-panel-slot')).toBeEmpty()
  })
})

test.describe('react task detail: typed action API observability', () => {
  // A failed action is logged as well as flashed on the button — error
  // observability is an explicit engineering constraint.
  test('a failed focus action logs a [action]-prefixed console.error and still flashes the button as failed', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    await page.route('**/focus/**', (route) => route.fulfill({ status: 500, body: 'boom' }))

    await openTask(page, FLAT_SLUG)
    // Scoped to .detail-actions (the head's own action row) — dev-ready's
    // own dev-tab CTA panel renders a second, identically-testid'd Terminal
    // button of its own (renderFlatChainPanel's dev-tab content), same
    // precedent as the pre-M1 focus-button-rerender-race spec.
    const btn = page.getByTestId('task-detail').locator('.detail-actions [data-testid="focus-btn"]')
    await btn.click()

    await expect(btn).toHaveClass(/btn-err/)
    await expect.poll(() => consoleErrors.some((line) => line.startsWith('[action]'))).toBe(true)
  })

  // Failure path, network-level rather than HTTP-level — doAction's own
  // catch(_) branch, ported.
  test('a network failure on mark-done logs [action] and flashes "no server", without marking the task done', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    await page.route('**/mark-done/**', (route) => route.abort('failed'))

    await openTask(page, FLAT_SLUG)
    await page.getByTestId('task-detail').getByTestId('card-menu-btn').click()
    const btn = page.getByTestId('task-detail').getByTestId('mark-done-btn')
    await btn.click()

    await expect(btn).toHaveText('no server')
    await expect.poll(() => consoleErrors.some((line) => line.startsWith('[action]'))).toBe(true)
    await expect(page.getByTestId('task-detail')).toBeVisible()
  })
})

test.describe('react task detail: click survives a same-content SSE push mid-click', () => {
  // React's reconciliation keeps the same DOM node for a same-content
  // snapshot, so a real SSE push landing between mousedown and mouseup must
  // not swallow the click — driven through the page's own `es.onmessage`
  // (exposed by sseBridge.ts for exactly this kind of test).
  async function pushSameSnapshotMidClick(page: Page, locator: ReturnType<Page['locator']>) {
    const snapshot = await page.evaluate(() => fetch('/api/tasks').then((r) => r.json()))
    await locator.scrollIntoViewIfNeeded()
    const box = await locator.boundingBox()
    if (!box) throw new Error('locator has no bounding box')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.evaluate((payload) => {
      es.onmessage!(new MessageEvent('message', { data: JSON.stringify(payload) }))
    }, snapshot)
    await page.mouse.up()
  }

  test('clicking Terminal in the detail head survives a same-content SSE push landing mid-click', async ({ page }) => {
    await openTask(page, FLAT_SLUG)
    const btn = page.getByTestId('task-detail').locator('.detail-actions [data-testid="focus-btn"]')
    await expect(btn).toBeVisible()

    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().includes(`/focus/${FLAT_SLUG}`) && r.method() === 'POST'),
      pushSameSnapshotMidClick(page, btn),
    ])
    expect(req).toBeTruthy()
  })

  // dev-ready's own stage CTA lives in the panel slot — proving the same
  // guarantee extends to that slot, not just the frame around it.
  test('clicking the stage CTA in the panel slot survives a same-content SSE push landing mid-click', async ({ page }) => {
    await openTask(page, FLAT_SLUG)
    const cta = page.getByTestId('l2-cta')
    await expect(cta).toBeVisible()

    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().includes(`/stage-skill/${FLAT_SLUG}`) && r.method() === 'POST'),
      pushSameSnapshotMidClick(page, cta),
    ])
    expect(req).toBeTruthy()
  })
})

// CR finding: no spec, old or new, asserted CtxMeter's presence, fill width
// or hot/cold coloring as it actually renders inside the detail head's own
// ctx row (TaskDetail.tsx's own CtxMeter call, testIds detail-ctx-meter/
// detail-ctx-meter-fill/detail-ctx-value) — only the board-card and header
// copies had coverage. Light-scheme + DESKTOP pin matches every other
// design-token-asserting spec (see designTokens.ts's own comment on why).
test.describe('react task detail: CtxMeter primitive', () => {
  test.use({ colorScheme: 'light', viewport: DESKTOP })

  // board-metrics: contextPct 42 — below CTX_HOT_THRESHOLD (60), the cold/
  // accent palette.
  test('renders the fill width and accent (cold) palette for a task below the hot threshold', async ({ page }) => {
    await page.goto('/task/board-metrics')
    const detail = page.getByTestId('task-detail')
    await expect(detail).toBeVisible()

    const track = detail.getByTestId('detail-ctx-meter')
    const fill = detail.getByTestId('detail-ctx-meter-fill')
    const value = detail.getByTestId('detail-ctx-value')
    await expect(value).toHaveText('42%')
    expect(await fill.evaluate((el) => el.style.width)).toBe('42%')
    expect(await cssOf(track, 'background-color')).toBe(TOKEN.surface2)
    expect(await cssOf(fill, 'background-color')).toBe(TOKEN.accent)
    expect(await cssOf(value, 'color')).toBe(TOKEN.text2)
  })

  // handover-hot: contextPct 74 — above the threshold, the hot/amber
  // palette, and (same task) the detail-handover pill it gates on.
  test('switches to the amber (hot) palette above the threshold, and gates the handover pill on it', async ({ page }) => {
    await page.goto('/task/pipelinely-handover-hot')
    const detail = page.getByTestId('task-detail')
    await expect(detail).toBeVisible()

    const track = detail.getByTestId('detail-ctx-meter')
    const fill = detail.getByTestId('detail-ctx-meter-fill')
    const value = detail.getByTestId('detail-ctx-value')
    await expect(value).toHaveText('74%')
    expect(await fill.evaluate((el) => el.style.width)).toBe('74%')
    expect(await cssOf(track, 'background-color')).toBe(TOKEN.amberSoft)
    expect(await cssOf(fill, 'background-color')).toBe(TOKEN.amber)
    expect(await cssOf(value, 'color')).toBe(TOKEN.amberInk)
    await expect(detail.getByTestId('detail-handover')).toBeVisible()
  })

  // Failure/edge path: a task with no recorded context at all renders no
  // meter (an em dash and a fabricated 0% both being lies about data that
  // doesn't exist) — same as detail-ctx-row's own :empty CSS collapsing it.
  test('renders no ctx meter at all for a task with no recorded context', async ({ page }) => {
    await openTask(page, FLAT_SLUG)
    const detail = page.getByTestId('task-detail')

    await expect(detail.getByTestId('detail-ctx-meter')).toHaveCount(0)
    await expect(detail.getByTestId('detail-ctx-row')).toBeEmpty()
  })
})
