import { test, expect } from '@playwright/test'
import { TOKEN, DESKTOP, cssOf } from './fixtures/designTokens'

// M4 of the Claude Design v2 alignment: the inner task view — Screen 2 of the
// handoff (Pipelinely Pipeline.dc.html).
//
// Three regions change.
//
// 1. THE HEADER'S META ROW. The design's header ends in one plain mono row of
//    label/value pairs — tok · cost · sessions · model (Pipeline lines
//    193-200). This repo had grown a pills row (stage, no-verifier, mode,
//    repo, Open PR) and the five-cell stats grid on top of it. The
//    developer's call was the design's row, exactly; PR access moves to the
//    header's own 3-dots menu, which already carries it.
// 2. THE STAGE RAIL. Its own card at `margin:26px 0 0; padding:26px
//    clamp(18px,2.4vw,26px)`, 82px node columns, 28px circles with 2px rings,
//    and an 8px negative-margin bleed so the current node's breathing halo is
//    not clipped by the card's own overflow-x. This repo used 104px columns,
//    1.5px rings, 18px/20px padding and no bleed.
// 3. THE PANEL FOOTER. The design ends every stage panel with a full-bleed
//    `surface2` band (`border-radius:0 0 17px 17px`) carrying one ink primary
//    at `min-width:160px` plus secondaries at `min-width:140px` (Pipeline
//    lines 436-444). This repo used an inset rounded strip that also carried
//    an uppercase eyebrow and a hint sentence; the developer's call was the
//    design's band exactly, so the eyebrow and hint come out.
//
// WHAT DELIBERATELY DOES NOT CHANGE: the compact prev/tile/next stepper below
// 641px. It is this repo's own answer to a small screen, the design has none,
// and the developer chose to keep it — so this file also carries a regression
// guard for it. See docs/design-drift.md, DRIFT-2.
//
// Landed as part of M4 — every case below was committed red with a
// `@pending` tag (so VERIFY's `--grep-invert @pending` could keep the gate
// reachable while the milestone was in flight) and the tag is now removed,
// per M4's own definition of done.

test.use({ colorScheme: 'light', viewport: DESKTOP })

// The only fixture with a METRICS file, so the only one whose meta row shows
// real tok/cost/sessions/model rather than four em dashes.
const PRICED_SLUG = 'board-metrics'
// A flat task: five visible chain nodes, defaulting to the Dev tab.
const FLAT_SLUG = 'dev-ready'
// A task whose stage panel renders BOTH a primary and a secondary (Fix and
// Skip), which is what the footer's two button treatments need to be
// distinguishable.
const TWO_BUTTON_SLUG = 'qa-fixes-ready'
// clamp(18px,2.4vw,26px) at a 1280px viewport: 2.4vw is 30.72px, so the clamp
// pins to its 26px maximum.
const PANEL_GUTTER = '26px'

test.describe('header meta row', () => {
  test('the meta row is the design\'s four mono pairs and nothing else', async ({ page }) => {
    await page.goto(`/task/${PRICED_SLUG}`)

    const meta = page.getByTestId('detail-meta')
    await expect(meta).toBeVisible()
    await expect(meta.getByTestId('detail-meta-label')).toHaveText(['tok', 'cost', 'sessions', 'model'])
    expect(await cssOf(meta, 'font-family')).toContain('JetBrains Mono')
    expect(await cssOf(meta, 'font-size')).toBe('11.5px')
    expect(await cssOf(meta, 'column-gap')).toBe('14px')
  })

  test('the pills row and the stats grid are gone from the header', async ({ page }) => {
    await page.goto(`/task/${PRICED_SLUG}`)

    const meta = page.getByTestId('detail-meta')
    await expect(meta.locator('.card-pills')).toHaveCount(0)
    await expect(meta.locator('.card-stats')).toHaveCount(0)
    await expect(meta.getByTestId('stage-pill')).toHaveCount(0)
  })

  // Dropping the pills row must not drop the way to the PR — the design puts
  // it in the header's own 3-dots menu, and this repo's Open PR button
  // already lives there. Scoped to the menu we just opened: `open-pr-btn`
  // isn't unique page-wide — the Done tab's own per-row expand block (always
  // in the DOM, just hidden by tab visibility, and retired outright by M3 —
  // see tech-design.md's selector contract) carries the same testid on its
  // own "Open PR" action for any done row with a PR.
  test('Open PR is still reachable from the header menu', async ({ page }) => {
    await page.goto(`/task/${'merge-ready'}`)

    await page.getByTestId('task-detail').getByTestId('card-menu-btn').click()
    const menu = page.getByTestId('card-menu')
    await expect(menu).toBeVisible()
    await expect(menu.getByTestId('open-pr-btn')).toBeVisible()
  })

  test('the header card uses the design\'s radius and padding', async ({ page }) => {
    await page.goto(`/task/${FLAT_SLUG}`)

    const head = page.locator('.detail-head')
    expect(await cssOf(head, 'border-radius')).toBe('16px')
    expect(await cssOf(head, 'padding-top')).toBe('22px')
    expect(await cssOf(head, 'padding-left')).toBe(PANEL_GUTTER)
    expect(await cssOf(head, 'background-color')).toBe(TOKEN.surface)
  })
})

// The rail's look (circles, rings, edges, selection) is the pipeline chart's
// now, and is pinned by dashboard-v4-pipeline-chart.spec.ts.
test.describe('stage rail', () => {
  test('the rail keeps the design\'s 26px top margin', async ({ page }) => {
    await page.goto(`/task/${FLAT_SLUG}`)

    const rail = page.getByTestId('stepper-wide')
    await expect(rail).toBeVisible()
    expect(await cssOf(rail, 'margin-top')).toBe('26px')
  })

  test('a rail node carries a name and one status line, and no state word', async ({ page }) => {
    await page.goto(`/task/${FLAT_SLUG}`)

    const rail = page.getByTestId('stepper-wide')
    await expect(rail.getByTestId('stage-node-data')).toHaveCount(0)
    await expect(page.getByTestId('stage-chain-dev').getByTestId('stage-node-name')).toHaveText('Dev')
    await expect(page.getByTestId('stage-chain-dev').getByTestId('stage-node-sub')).toHaveCount(1)
  })
})

test.describe('stage panel footer', () => {
  test('the footer is a full-bleed surface2 band on the panel\'s bottom corners', async ({ page }) => {
    await page.goto(`/task/${FLAT_SLUG}`)

    const footer = page.getByTestId('detail-panel-footer')
    await expect(footer).toBeVisible()
    expect(await cssOf(footer, 'background-color')).toBe(TOKEN.surface2)
    expect(await cssOf(footer, 'border-top-width')).toBe('1px')
    expect(await cssOf(footer, 'border-top-color')).toBe(TOKEN.border)
    expect(await cssOf(footer, 'border-bottom-left-radius')).toBe('17px')
    expect(await cssOf(footer, 'border-bottom-right-radius')).toBe('17px')
    expect(await cssOf(footer, 'padding-top')).toBe('16px')
    expect(await cssOf(footer, 'padding-left')).toBe(PANEL_GUTTER)
    expect(await cssOf(footer, 'margin-top')).toBe('20px')
  })

  // "Full bleed" is the point: the band's edges reach the panel card's edges
  // rather than sitting inset from them the way the old .stage-cta-bar did.
  test('the band spans the panel card edge to edge', async ({ page }) => {
    await page.goto(`/task/${FLAT_SLUG}`)

    const panel = await page.getByTestId('l2-panel').boundingBox()
    const footer = await page.getByTestId('detail-panel-footer').boundingBox()
    expect(footer!.x).toBeCloseTo(panel!.x, 0)
    expect(footer!.width).toBeCloseTo(panel!.width, 0)
  })

  test('the primary button is the design\'s ink CTA', async ({ page }) => {
    await page.goto(`/task/${FLAT_SLUG}`)

    const primary = page.getByTestId('detail-panel-footer').getByTestId('l2-cta')
    await expect(primary).toBeVisible()
    expect(await cssOf(primary, 'background-color')).toBe(TOKEN.ink)
    expect(await cssOf(primary, 'color')).toBe(TOKEN.bg)
    expect(await cssOf(primary, 'font-size')).toBe('13px')
    expect(await cssOf(primary, 'font-weight')).toBe('700')
    expect(await cssOf(primary, 'border-radius')).toBe('10px')
    expect(await cssOf(primary, 'min-width')).toBe('160px')
  })

  test('a secondary button keeps the surface treatment and its own min-width', async ({ page }) => {
    await page.goto(`/task/${TWO_BUTTON_SLUG}`)

    const secondary = page.getByTestId('detail-panel-footer').getByTestId('skip-cta')
    await expect(secondary).toBeVisible()
    expect(await cssOf(secondary, 'background-color')).toBe(TOKEN.surface)
    expect(await cssOf(secondary, 'color')).toBe(TOKEN.text2)
    expect(await cssOf(secondary, 'min-width')).toBe('140px')
  })

  test('the eyebrow and hint are gone', async ({ page }) => {
    await page.goto(`/task/${FLAT_SLUG}`)

    await expect(page.getByTestId('stage-cta-bar')).toHaveCount(0)
    await expect(page.getByTestId('stage-cta-eyebrow')).toHaveCount(0)
    await expect(page.getByTestId('stage-cta-hint')).toHaveCount(0)
  })
})

test.describe('stage panel header', () => {
  test('the panel header uses the design\'s type and its own status pill', async ({ page }) => {
    await page.goto(`/task/${FLAT_SLUG}`)

    const title = page.locator('.l2-panel-title')
    expect(await cssOf(title, 'font-size')).toBe('16px')
    expect(await cssOf(title, 'font-weight')).toBe('800')

    const pill = page.locator('.l2-panel-pill')
    expect(await cssOf(pill, 'font-size')).toBe('11.5px')
    expect(await cssOf(pill, 'font-weight')).toBe('700')
    expect(await cssOf(pill, 'border-radius')).toBe('999px')
  })

  // The panel's own padding is the design's, not the uniform inset this repo
  // used: `22px <gutter> 0` at the header, with the body and the footer
  // supplying their own.
  test('the panel header sits at the design\'s padding', async ({ page }) => {
    await page.goto(`/task/${FLAT_SLUG}`)

    const header = page.locator('.l2-panel-header')
    expect(await cssOf(header, 'padding-top')).toBe('22px')
    expect(await cssOf(header, 'padding-left')).toBe(PANEL_GUTTER)
    expect(await cssOf(header, 'padding-bottom')).toBe('0px')
  })

  // The other half of taking the summary off the rail. Every value the design
  // shows on this line is a stage outcome — "plan written 14:02 · approved
  // 14:09", "reviewed at 6bf1775 · 09:41" — and stageNote() already produces
  // that `<note> · <when>` shape. dev-ready's TIMELINE records
  // "round 1: looks good" against plan-review, which folds into the Planning
  // node (see stepper-node-grouping.spec.ts), so selecting Planning is what
  // surfaces it.
  test('the header\'s meta line carries the selected stage\'s recorded outcome', async ({ page }) => {
    await page.goto(`/task/${FLAT_SLUG}`)

    await page.getByTestId('stage-chain-planning').click()
    await expect(page.locator('.l2-panel-subtitle')).toContainText('round 1: looks good')
  })

  // The session count that used to live in this slot is gone — the design has
  // no room for it here, and the header's own meta row already reports
  // `sessions`.
  test('the meta line is not the session count any more', async ({ page }) => {
    await page.goto(`/task/${FLAT_SLUG}`)

    await page.getByTestId('stage-chain-planning').click()
    await expect(page.locator('.l2-panel-subtitle')).not.toHaveText(/^\d+ sessions?$/)
  })
})

test.describe('compact stepper is kept (DRIFT-2)', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  // Not a design requirement — a deliberate divergence the developer chose to
  // keep. Guarded here so the alignment pass cannot quietly delete it while
  // "matching the design".
  test('below 641px the compact stepper still replaces the rail', async ({ page }) => {
    await page.goto(`/task/${FLAT_SLUG}`)

    await expect(page.getByTestId('stepper-compact')).toBeVisible()
    await expect(page.getByTestId('stepper-wide')).toBeHidden()
    await expect(page.getByTestId('stepper-prev')).toBeVisible()
    await expect(page.getByTestId('stepper-next')).toBeVisible()
  })
})
