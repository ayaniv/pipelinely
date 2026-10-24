import { test, expect } from '@playwright/test'
import { TOKEN, DESKTOP, cssOf } from './fixtures/designTokens'

// M5 of the Claude Design v2 alignment: the milestone drill-down — Screen 3
// (Pipelinely Milestone.dc.html).
//
// The handoff marks this file "reference only", but this repo already HAS a
// milestone drill-down (renderMilestoneDetail), and the task's scope is every
// page, so the developer put it in scope.
//
// Today the drill-down opens on a one-line `.l2-head` strip — a back chevron,
// "M0 · name", and the slug pushed right. The design gives it the same header
// CARD the pipeline view has: a status pill beside the mono milestone id, an
// h1, a slug line, terminal / VS Code / 3-dots on the right, a ctx row and a
// mono meta row. Above the card sits a back link naming the PARENT task
// rather than an anonymous chevron.
//
// THE ONE PLACE THIS RAIL DIFFERS FROM SCREEN 2's. The milestone rail is four
// nodes at 92px (not five at 82px), its completed nodes are SAGE rather than
// accent, its rings are 1.5px rather than 2px, and its upcoming nodes are
// DASHED. Those are genuinely different values in the design, not one
// treatment reused — so the rail needs a scoping hook rather than a second
// set of rules fighting the first over the same class.
//
// Landed as part of M5 — every case below was committed red with a
// `@pending` tag (so VERIFY's `--grep-invert @pending` could keep the gate
// reachable while the milestone was in flight) and the tag is now removed,
// per M5's own definition of done.

test.use({ colorScheme: 'light', viewport: DESKTOP })

const PARENT_SLUG = 'fanout-parent'
// M1 is queued: a click on a queued wave-graph node drills into it, while a
// dispatched one (M0) opens its own task page.
const MILESTONE_ID = 'M1'
// clamp(18px,2.4vw,26px) at 1280px pins to 26px — same gutter as Screen 2.
const PANEL_GUTTER = '26px'

// The drill-down is reached by opening the parent and clicking a queued milestone
// in the wave graph, which is how a developer actually gets there.
async function openMilestone(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`/task/${PARENT_SLUG}`)
  await page.getByTestId(`wave-task-${MILESTONE_ID}`).click()
  await page.getByTestId('milestone-detail-head').waitFor({ state: 'visible' })
}

test.describe('parent back link', () => {
  test('the drill-down opens under a link naming the parent task', async ({ page }) => {
    await openMilestone(page)

    const back = page.getByTestId('milestone-parent-link')
    await expect(back).toBeVisible()
    // The design's own treatment: 13px/600 text2 with a 7px gap and a
    // 6px/18px vertical rhythm above the header card.
    expect(await cssOf(back, 'font-size')).toBe('13px')
    expect(await cssOf(back, 'font-weight')).toBe('600')
    expect(await cssOf(back, 'color')).toBe(TOKEN.text2)
    expect(await cssOf(back, 'column-gap')).toBe('7px')
    expect(await cssOf(back, 'margin-top')).toBe('6px')
    expect(await cssOf(back, 'margin-bottom')).toBe('18px')
  })

  test('the link goes back to the parent task, not just up one level', async ({ page }) => {
    await openMilestone(page)

    await page.getByTestId('milestone-parent-link').click()
    await expect(page).toHaveURL(new RegExp(`/task/${PARENT_SLUG}$`))
    await expect(page.getByTestId('milestone-detail-head')).toHaveCount(0)
  })

  // The one-line strip it replaces is gone, not merely restyled — leaving it
  // would give the page two back affordances stacked on each other.
  test('the old one-line l2-head strip is gone', async ({ page }) => {
    await openMilestone(page)

    await expect(page.locator('.l2-head')).toHaveCount(0)
    await expect(page.getByTestId('l2-back')).toHaveCount(0)
  })
})

test.describe('milestone header card', () => {
  test('the header is a card at the design\'s radius and padding', async ({ page }) => {
    await openMilestone(page)

    const head = page.getByTestId('milestone-detail-head')
    expect(await cssOf(head, 'border-radius')).toBe('16px')
    expect(await cssOf(head, 'background-color')).toBe(TOKEN.surface)
    expect(await cssOf(head, 'padding-top')).toBe('22px')
    expect(await cssOf(head, 'padding-left')).toBe(PANEL_GUTTER)
  })

  test('the status row pairs a status pill with the mono milestone id', async ({ page }) => {
    await openMilestone(page)

    const pill = page.getByTestId('milestone-status-pill')
    await expect(pill).toBeVisible()
    expect(await cssOf(pill, 'border-radius')).toBe('999px')
    expect(await cssOf(pill, 'font-size')).toBe('11.5px')
    expect(await cssOf(pill, 'font-weight')).toBe('700')

    const id = page.getByTestId('milestone-detail-id')
    await expect(id).toHaveText(MILESTONE_ID)
    expect(await cssOf(id, 'font-family')).toContain('JetBrains Mono')
    expect(await cssOf(id, 'font-size')).toBe('11px')
    expect(await cssOf(id, 'color')).toBe(TOKEN.text3)
  })

  // The milestone h1 is deliberately a notch smaller than the session h1:
  // clamp(20px,2.2vw,25px) against Screen 2's clamp(22px,2.4vw,27px). At a
  // 1280px viewport both clamps pin to their maximum.
  test('the milestone title is the design\'s h1, one notch below the session\'s', async ({ page }) => {
    await openMilestone(page)

    const title = page.getByTestId('milestone-title')
    expect(await cssOf(title, 'font-size')).toBe('25px')
    expect(await cssOf(title, 'font-weight')).toBe('800')
  })
})

// The rail's colours, rings and sizes are the pipeline chart's now, and are
// pinned by dashboard-v4-pipeline-chart.spec.ts; what stays here is that a
// milestone's chart is its own four nodes.
test.describe('milestone stage rail', () => {
  test('the rail is four chart nodes under the 26px rail margin', async ({ page }) => {
    await openMilestone(page)

    const rail = page.getByTestId('stepper-wide')
    await expect(rail.locator('.stage-chain-node')).toHaveCount(4)
    expect(await cssOf(rail, 'margin-top')).toBe('26px')
  })

  test('every node carries a name and one status line', async ({ page }) => {
    await openMilestone(page)

    const rail = page.getByTestId('stepper-wide')
    await expect(rail.getByTestId('stage-node-name')).toHaveCount(4)
    await expect(rail.getByTestId('stage-node-sub')).toHaveCount(4)
    await expect(rail.getByTestId('stage-node-data')).toHaveCount(0)
  })
})

test.describe('milestone detail panel', () => {
  test('the panel opens with the design\'s mono dispatch block', async ({ page }) => {
    await openMilestone(page)

    const dispatch = page.getByTestId('milestone-dispatch')
    await expect(dispatch).toBeVisible()
    // The design's uppercase micro-label: mono 10.5px, .14em tracking.
    const eyebrow = dispatch.getByTestId('milestone-dispatch-label')
    expect(await cssOf(eyebrow, 'font-size')).toBe('10.5px')
    expect(await cssOf(eyebrow, 'text-transform')).toBe('uppercase')
    expect(await cssOf(eyebrow, 'letter-spacing')).toBe('1.47px') // .14em at 10.5px

    // Its two rows are the real facts this repo already holds for a
    // milestone — the declared `needs:` and the verifier.
    await expect(dispatch.getByTestId('milestone-dispatch-row')).toHaveCount(2)
  })

  test('the panel ends on the same full-bleed footer band as Screen 2', async ({ page }) => {
    await openMilestone(page)

    const footer = page.getByTestId('detail-panel-footer')
    await expect(footer).toBeVisible()
    expect(await cssOf(footer, 'background-color')).toBe(TOKEN.surface2)
    expect(await cssOf(footer, 'border-bottom-left-radius')).toBe('17px')

    const panel = await page.getByTestId('l2-panel').boundingBox()
    const band = await footer.boundingBox()
    expect(band!.x).toBeCloseTo(panel!.x, 0)
    expect(band!.width).toBeCloseTo(panel!.width, 0)
  })

  // Failure path: a queued milestone has nothing recorded on any stage, and
  // says so rather than leaving a blank region.
  test('a stage with no history says the milestone is not dispatched yet', async ({ page }) => {
    await openMilestone(page)

    await page.getByTestId('stage-chain-merge').click()
    const note = page.getByTestId('not-dispatched-note')
    await expect(note).toBeVisible()
    expect(await cssOf(note, 'color')).toBe(TOKEN.text3)
  })
})
