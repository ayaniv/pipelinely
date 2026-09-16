import { test, expect } from '@playwright/test'
import { TOKEN, DESKTOP, MOBILE, cssOf } from './fixtures/designTokens'

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
