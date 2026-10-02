import { test, expect } from '@playwright/test'
import { TOKEN, DESKTOP, MOBILE, cssOf } from './fixtures/designTokens'
import { openWithSnapshot } from './fixtures/snapshotStub'

// M1 of the Claude Design v2 alignment: the top bar's orchestrator context
// meter and its Handover segment.
//
// This is the one genuinely new piece of data in the whole alignment pass.
// The design's top bar carries `ctx · <76px meter> · 82%` with a Handover
// segment fused flush into the pill's right edge whenever ctx is hot
// (Pipelinely Dashboard v2.dc.html lines 110-121; HOME_CTX = 82,
// CTX_HANDOVER_AT = 60). This repo's header had no ctx meter at all and no
// source for one: scripts/write-metrics.sh only ever writes into a task
// directory, and the orchestrator's own session is not a task.
//
// M1 adds `<TASKS_DIR>/ORCHESTRATOR_METRICS` — the same JSON shape a task's
// own METRICS file already uses, so there is one parser, not two — exposed on
// the /api/tasks snapshot and the /events stream as orchestratorContextPct.
//
// COVERAGE SPLIT, deliberate: the fixture set pins one orchestrator context
// value (82, the design's own), so the cases here cover the HOT branch, the
// API contract, and the responsive rule. The cold branch, a missing file and
// a malformed file are covered at the vitest level against the parser itself
// (src/taskParser.test.ts), which is where a "what happens when the file is
// garbage" question actually belongs — and the cold *styling* of the very
// same shared meter is asserted in design-v2-active-board.spec.ts against the
// board-metrics card (42%). Mutating a checked-in fixture mid-run to flip the
// branch would race every other worker in a fullyParallel suite.

test.use({ colorScheme: 'light', viewport: DESKTOP })

// The value in e2e/fixtures/tasks/ORCHESTRATOR_METRICS, chosen to match the
// design's own HOME_CTX so the mock and the mockup agree.
const ORCHESTRATOR_CTX = 82

test.describe('orchestrator context pill', () => {
  test('the header shows the orchestrator\'s context as a labelled meter', async ({ page }) => {
    await page.goto('/')

    const pill = page.getByTestId('header-ctx')
    await expect(pill).toBeVisible()
    await expect(page.getByTestId('header-ctx-value')).toHaveText(`${ORCHESTRATOR_CTX}%`)

    // The design's own pill geometry: a 32px-tall stretch row so the
    // Handover segment can sit flush inside its right edge.
    expect(await cssOf(pill, 'height')).toBe('32px')
    expect(await cssOf(pill, 'border-radius')).toBe('999px')
    expect(await cssOf(pill, 'background-color')).toBe(TOKEN.surface)
    expect(await cssOf(pill, 'align-items')).toBe('stretch')

    const meter = page.getByTestId('header-ctx-meter')
    expect(await cssOf(meter, 'width')).toBe('76px')
    expect(await cssOf(meter, 'height')).toBe('6px')
  })

  // Pixel-level spacing of the design's ctx pill (Pipelinely Dashboard
  // v3.dc.html line 127): `gap:11px; padding:0 14px 0 11px`, meter
  // `min-width:60px`. The design puts this padding/gap on the one clickable
  // link that also carries the home icon — not a separate inner "body" div
  // — so it's asserted on that control (orchestrator-tab-btn) directly. The
  // header reuses the card's ctx row, whose own gap/min-width differ, so
  // these are asserted on the header specifically.
  test('the home+ctx control uses the design\'s gap, padding and meter min-width', async ({ page }) => {
    await page.goto('/')

    const control = page.getByTestId('orchestrator-tab-btn')
    expect(await cssOf(control, 'column-gap')).toBe('11px')
    expect(await cssOf(control, 'padding-left')).toBe('11px')
    expect(await cssOf(control, 'padding-right')).toBe('14px')
    expect(await cssOf(page.getByTestId('header-ctx-meter'), 'min-width')).toBe('60px')
  })

  test('the fill width tracks the reported percentage', async ({ page }) => {
    await page.goto('/')

    const track = await page.getByTestId('header-ctx-meter').boundingBox()
    const fill = await page.getByTestId('header-ctx-fill').boundingBox()
    expect(fill!.width).toBeCloseTo(track!.width * (ORCHESTRATOR_CTX / 100), 0)
  })

  // The design's one hot-context rule, applied here exactly as it is on every
  // card: >60% recolours the track, the fill and the number to amber.
  test('a hot context recolours the meter to amber', async ({ page }) => {
    await page.goto('/')

    expect(await cssOf(page.getByTestId('header-ctx-fill'), 'background-color')).toBe(TOKEN.amber)
    expect(await cssOf(page.getByTestId('header-ctx-meter'), 'background-color')).toBe(TOKEN.amberSoft)
    expect(await cssOf(page.getByTestId('header-ctx-value'), 'color')).toBe(TOKEN.amberInk)
  })

  test('a hot context reveals the Handover segment inside the pill', async ({ page }) => {
    await page.goto('/')

    const handover = page.getByTestId('header-handover')
    await expect(handover).toBeVisible()
    await expect(handover).toHaveText('Handover')
    expect(await cssOf(handover, 'height')).toBe('30px')
    expect(await cssOf(handover, 'background-color')).toBe(TOKEN.amberSoft)
    expect(await cssOf(handover, 'color')).toBe(TOKEN.amberInk)
    expect(await cssOf(handover, 'border-top-color')).toBe(TOKEN.amber)

    // "Flush inside the pill's right edge" is the design's own
    // `margin:-1px -1px 0 0` — the segment's border overlaps the pill's
    // rather than sitting beside it, so their right edges coincide.
    const pillBox = await page.getByTestId('header-ctx').boundingBox()
    const segBox = await handover.boundingBox()
    expect(pillBox!.x + pillBox!.width).toBeCloseTo(segBox!.x + segBox!.width, 0)
  })

  test('the snapshot API carries the orchestrator context', async ({ request }) => {
    const res = await request.get('/api/tasks')
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.orchestratorContextPct).toBe(ORCHESTRATOR_CTX)
  })
})

// The home icon (bring-back-the-orchestrator-tab) used to be a free-standing
// button beside this pill, colliding with it visually. Per Claude Design v3
// (Pipelinely Dashboard v3.dc.html lines 127-134) it is now the FIRST CHILD
// of the very same clickable link that carries "ctx", the meter and the
// percentage — not a separate segment of its own — so its presence no
// longer depends on ctx being known, unlike the meter and Handover trio
// beside it.
//
// The header chrome is React-rendered, so these cases drive it the way
// production does rather than through page globals. The ctx
// value arrives the way it does in production — through the snapshot —
// via fixtures/snapshotStub.ts, which serves a mutated copy rather than
// mutating the shared ORCHESTRATOR_METRICS fixture (that would race every
// other worker in this fullyParallel suite). Every assertion is unchanged;
// only what drives the page changed.
test.describe('merged header control — home affordance', () => {
  test('the home icon renders inside the ctx pill even when no ctx value is known', async ({ page }) => {
    await openWithSnapshot(page, '/', (snapshot) => { snapshot.orchestratorContextPct = null })

    const pill = page.getByTestId('header-ctx')
    await expect(pill).toBeVisible()
    await expect(pill.getByTestId('orchestrator-tab-btn')).toBeVisible()
    await expect(page.getByTestId('header-ctx-home-icon')).toBeVisible()
    await expect(page.getByTestId('header-ctx-body')).toBeHidden()
    await expect(page.getByTestId('header-handover')).toBeHidden()

    // aria-label overrides the button's accessible name entirely (CR
    // suggestion) — with no ctx value known it stays the plain navigation
    // label, not a dangling "(context %)" fragment.
    await expect(pill.getByTestId('orchestrator-tab-btn')).toHaveAttribute('aria-label', 'Bring back the orchestrator tab')
  })

  test('a known but cool context shows the meter without Handover, and the home icon stays', async ({ page }) => {
    const COOL_CTX = 30
    await openWithSnapshot(page, '/', (snapshot) => { snapshot.orchestratorContextPct = COOL_CTX })

    const pill = page.getByTestId('header-ctx')
    await expect(pill.getByTestId('orchestrator-tab-btn')).toBeVisible()
    await expect(pill.getByTestId('header-ctx-home-icon')).toBeVisible()
    await expect(page.getByTestId('header-ctx-value')).toHaveText(`${COOL_CTX}%`)
    await expect(page.getByTestId('header-handover')).toBeHidden()

    // With a ctx value known, aria-label folds it in — the button's
    // accessible name otherwise loses the "ctx N%" text nested inside it.
    await expect(pill.getByTestId('orchestrator-tab-btn')).toHaveAttribute(
      'aria-label', `Bring back the orchestrator tab (context ${COOL_CTX}%)`
    )
  })

  // Pixel-precision geometry of the merged control itself (Pipelinely
  // Dashboard v3.dc.html line 128): a 14x14 icon, coloured var(--text3) at
  // rest and var(--accent) on hover — the same treatment the design gives
  // the whole home+ctx link, not just the icon glyph.
  test('the home icon is 14x14 and the control recolours on hover', async ({ page }) => {
    await page.goto('/')

    const icon = page.getByTestId('header-ctx-home-icon')
    const box = await icon.boundingBox()
    expect(box!.width).toBeCloseTo(14, 0)
    expect(box!.height).toBeCloseTo(14, 0)

    const control = page.getByTestId('orchestrator-tab-btn')
    expect(await cssOf(control, 'color')).toBe(TOKEN.text3)
    await control.hover()
    expect(await cssOf(control, 'color')).toBe(TOKEN.accent)
  })

  // Regression coverage for a bug the merge itself introduced: restoring a
  // flashed button's content by reassigning its textContent would wipe the
  // control's SVG icon (and, when ctx is known, its live meter) the first
  // time anyone clicked it. A flash must swap in a separate status child and
  // hide the icon/meter only for the flash's duration. Also covers a CR
  // finding: the meter's hiding rule (`.is-flashing .header-ctx-body
  // { display: none }`) must actually hide the meter, not just the icon.
  // Driven by a real click on a canonical instance (the button is disabled
  // otherwise) with /orchestrator/tab stubbed to succeed.
  test('a flash swaps in status text without destroying the icon, then restores it', async ({ page }) => {
    await page.route('**/orchestrator/tab', (route) => route.fulfill({ status: 200, json: {} }))
    await openWithSnapshot(page, '/', (snapshot) => { snapshot.isCanonical = true; snapshot.orchestratorContextPct = 30 })

    const btn = page.getByTestId('orchestrator-tab-btn')
    const icon = page.getByTestId('header-ctx-home-icon')
    const meterValue = page.getByTestId('header-ctx-value')
    const status = page.getByTestId('orchestrator-tab-status')
    await expect(icon).toBeVisible()
    await expect(meterValue).toBeVisible()
    await expect(status).toBeHidden()

    await btn.click()

    await expect(btn).toHaveClass(/btn-ok/)
    await expect(icon).toBeHidden()
    await expect(meterValue).toBeHidden()
    await expect(status).toHaveText('✓')

    await expect(icon).toBeVisible({ timeout: 4000 })
    await expect(meterValue).toBeVisible()
    await expect(status).toBeHidden()
    await expect(btn).not.toHaveClass(/btn-ok/)
  })
})

// The orchestrator-tab control's failure paths — a non-2xx /orchestrator/tab
// response, and the fetch throwing outright. The canonical-instance
// integration suite (orchestrator-session-self-heal.spec.ts) exercises them
// against a real orchestrator session and is deliberately not run against
// this repo's own dev session locally, so they are routed through page.route
// here and run safely against any e2e instance. This e2e webServer is never
// canonical, so the snapshot is served as canonical (see snapshotStub.ts) to
// get an enabled button to click — a UI click Playwright would otherwise
// refuse to send to a disabled control.
test.describe('orchestrator tab control — failure paths', () => {
  test('a non-2xx response flashes btn-err with the server\'s own message', async ({ page }) => {
    await page.route('**/orchestrator/tab', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'orchestrator not running' }) })
    )
    await openWithSnapshot(page, '/', (snapshot) => { snapshot.isCanonical = true })

    await page.getByTestId('orchestrator-tab-btn').click()

    await expect(page.getByTestId('orchestrator-tab-btn')).toHaveClass(/btn-err/)
    await expect(page.getByTestId('orchestrator-tab-status')).toHaveText('orchestrator not running')
  })

  test('a thrown fetch (no server) flashes btn-err with "no server"', async ({ page }) => {
    await page.route('**/orchestrator/tab', (route) => route.abort('connectionrefused'))
    await openWithSnapshot(page, '/', (snapshot) => { snapshot.isCanonical = true })

    await page.getByTestId('orchestrator-tab-btn').click()

    await expect(page.getByTestId('orchestrator-tab-btn')).toHaveClass(/btn-err/)
    await expect(page.getByTestId('orchestrator-tab-status')).toHaveText('no server')
  })
})

test.describe('orchestrator context pill — mobile', () => {
  test.use({ viewport: MOBILE })

  // The design hides the bar below 860px but keeps the label and the number
  // ("The bar itself is hidden on mobile (label + number remain)").
  test('the bar is hidden below the breakpoint but the number stays', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByTestId('header-ctx-meter')).toBeHidden()
    await expect(page.getByTestId('header-ctx-value')).toBeVisible()
    await expect(page.getByTestId('header-ctx-value')).toHaveText(`${ORCHESTRATOR_CTX}%`)
  })
})
