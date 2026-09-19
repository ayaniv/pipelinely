import { test, expect, type Page } from '@playwright/test'
import { TOKEN, DESKTOP, cssOf } from './fixtures/designTokens'

// A follow-up alignment round against `Pipelinely Dashboard v2.dc.html`, run
// after the developer compared the live board with the design side by side.
// Four things came back:
//
// 1. THE HANDOVER BUTTON. The design draws one button on both surfaces (the
//    card's ctx row, line 338, and the header meter's own segment, line 134):
//    a 30px amber capsule, `border-radius:999px`, `transition:background .18s
//    ease`, `:active` at `opacity:.9` and a `box-shadow:inset 0 0 0 2px
//    var(--amber)` focus ring. This repo squared the header copy's left edge
//    off (`border-radius:0 999px 999px 0`) and shipped neither the transition
//    nor the two interaction states — so the two surfaces did not match each
//    other, let alone the design.
// 2. NO BADGE ROW. The design's card has no stage/no-verifier/mode/repo pill
//    row at all — status pill, title, project/slug, rail, summary, ctx row,
//    footer, nothing else. The row came out of every card variant that drew
//    it, board card and milestone card alike.
// 3. THE BUTTON ROW IS `when · terminal · ⋮`. The design's card header-right
//    (lines 249-254) is the timestamp, a terminal icon button and the 3-dots
//    menu. This repo had an open-detail ARROW where the terminal belongs.
// 4. EVERY CARD SHOWS A CTA. The design's footer always carries one
//    (`showCta: isParent || status !== "working"`). This repo left a
//    decision-waiting card with a terminal-only footer and no CTA at all, and
//    offered a milestone-declaring PARENT the leaf CTA ("Start dev") for a
//    stage that is only ever dispatched per milestone. Both now read
//    "See details" and open the task detail — the label the developer asked
//    for in place of guessing at an action the card does not have.
//
// Fixture data lives in e2e/fixtures/tasks (see playwright.config.ts).

test.use({ colorScheme: 'light', viewport: DESKTOP })

// A hot (74%) paused card — the board's own Handover pill, and the one card
// whose ctx row renders it.
const HANDOVER_SLUG = 'handover-hot'
// A leaf task parked at a real pipeline handoff: it keeps its stage CTA.
const LEAF_CTA_SLUG = 'dev-ready'
// A leaf task waiting on a decision only a human can make — no stage to
// dispatch, which is exactly the card that used to render no CTA.
const DECISION_SLUG = 'dev-not-ready'
// A milestone-DECLARING parent. Its STATUS says "plan reviewed, ready for
// dev", which on a leaf would mean "Start dev" — but dev is dispatched per
// milestone here, so the parent has no single next action.
const PARENT_SLUG = 'fanout-parent'
// A working leaf: the design gives it no footer (`footerDisplay`), so it is
// the counter-case to "every card shows a CTA".
const WORKING_SLUG = 'board-metrics'
// The one fixture parent with a live (not done, not queued) milestone child,
// so the milestone card's own footer has a real next stage to name.
const MS_PARENT_SLUG = 'qa-spec-preview-parent'
const MS_ID = 'M0'
// A milestone-declaring parent whose OWN status is `working`. Two things
// meet on this one card and nowhere else in the fixture set:
//   - it keeps its footer (`isWorkingLeaf` is false for a parent), the branch
//     no other fixture exercises, since every other parent is `waiting:`;
//   - its attentionStatus resolves to `idle` — neither `needs-you` nor
//     `paused` — so `cardFooterHtml` renders the CTA WITHOUT `btn-primary`.
// Every other footer fixture is `waiting:`, i.e. `needs-you`, i.e. primary,
// which is exactly why the footer's non-primary width rule went unnoticed.
const WORKING_PARENT_SLUG = 'working-fanout-parent'
// A card whose footer is the merge branch (Merge + Open PR), not a single
// CTA button — the one footer shape with more than one control.
const MERGE_READY_SLUG = 'card-merge-ready'

const card = (page: Page, slug: string) =>
  page.locator(`[data-testid="task-card"][data-slug="${slug}"]`)

const milestoneCard = (page: Page) =>
  page.locator(`[data-testid="milestone-card"][data-milestone-id="${MS_ID}"]`)

// The design's terminal glyph (lines 253 and 334 draw the same two paths) —
// asserted rather than trusted, because "put a terminal icon there" is
// exactly the instruction a guessed-at icon satisfies too.
const TERMINAL_PATH_D = 'M5 8l4 4-4 4'

async function pathsOf(locator: ReturnType<Page['locator']>): Promise<string[]> {
  return locator.locator('svg path').evaluateAll(els =>
    els.map(el => el.getAttribute('d') ?? '')
  )
}

test.describe('the Handover button — one spec, both surfaces', () => {
  // The design's own capsule. Both copies are asserted against the same
  // values on purpose: "they match the design" and "they match each other"
  // are the two claims that regressed.
  for (const surface of [
    { name: 'a board card', testid: 'card-handover' },
    { name: 'the orchestrator header meter', testid: 'header-handover' },
  ]) {
    test(`${surface.name} renders the design's amber capsule`, async ({ page }) => {
      await page.goto('/')

      const pill = surface.testid === 'card-handover'
        ? card(page, HANDOVER_SLUG).getByTestId(surface.testid)
        : page.getByTestId(surface.testid)

      await expect(pill).toBeVisible()
      await expect(pill).toHaveText('Handover')
      expect(await cssOf(pill, 'height')).toBe('30px')
      expect(await cssOf(pill, 'padding-left')).toBe('15px')
      expect(await cssOf(pill, 'padding-right')).toBe('15px')
      expect(await cssOf(pill, 'background-color')).toBe(TOKEN.amberSoft)
      expect(await cssOf(pill, 'color')).toBe(TOKEN.amberInk)
      expect(await cssOf(pill, 'border-top-color')).toBe(TOKEN.amber)
      expect(await cssOf(pill, 'font-size')).toBe('11.5px')
      expect(await cssOf(pill, 'font-weight')).toBe('700')

      // The regression: the header copy squared its left edge off. The
      // design keeps a full capsule on both surfaces.
      for (const corner of [
        'border-top-left-radius',
        'border-top-right-radius',
        'border-bottom-left-radius',
        'border-bottom-right-radius',
      ]) {
        expect(await cssOf(pill, corner)).toBe('999px')
      }

      // `transition:background .18s ease` — the design's own easing on the
      // hover swap, which this repo shipped as an instant flip.
      expect(await cssOf(pill, 'transition-property')).toBe('background')
      expect(await cssOf(pill, 'transition-duration')).toBe('0.18s')
    })
  }

  // "Flush inside the pill's right edge" is the design's `margin:-1px -1px 0
  // 0` (line 134) — a full capsule still has to sit ON the meter pill's own
  // border, not beside it. Rounding the corners back must not undo that.
  test('the header copy still sits flush against the meter pill', async ({ page }) => {
    await page.goto('/')

    const pillBox = await page.getByTestId('header-ctx').boundingBox()
    const segBox = await page.getByTestId('header-handover').boundingBox()
    expect(pillBox!.x + pillBox!.width).toBeCloseTo(segBox!.x + segBox!.width, 0)
  })

  // Failure path for the design's one `ctxHot` rule: below the threshold
  // there is no button to style at all.
  test('a cold card offers no Handover button', async ({ page }) => {
    await page.goto('/')

    await expect(card(page, LEAF_CTA_SLUG).getByTestId('card-handover')).toHaveCount(0)
  })
})

test.describe('the badge row is gone', () => {
  test('a board card draws no stage / no-verifier / mode / repo pills', async ({ page }) => {
    await page.goto('/')

    const c = card(page, LEAF_CTA_SLUG)
    await expect(c).toBeVisible()
    await expect(c.getByTestId('card-meta-row')).toHaveCount(0)
    await expect(c.getByTestId('stage-pill')).toHaveCount(0)
    await expect(c.getByTestId('no-verifier-pill')).toHaveCount(0)
    await expect(c.locator('.card-secondary-pills')).toHaveCount(0)
  })

  // The second card variant that drew the row. The milestone card is
  // deliberately the same rendering as a board card (see
  // renderMilestoneCard's own comment), so it loses the row too rather than
  // keeping a stray copy in the detail panel.
  test('a milestone card draws none either', async ({ page }) => {
    await page.goto(`/task/${MS_PARENT_SLUG}`)

    const c = milestoneCard(page)
    await expect(c).toBeVisible()
    await expect(c.locator('.card-secondary-pills')).toHaveCount(0)
    await expect(c.getByTestId('stage-pill')).toHaveCount(0)
  })

  // The pills carried real information, so the claim is "off the card", not
  // "gone from the app" — the task detail header still names the stage.
  test('the stage is still readable in the task detail view', async ({ page }) => {
    await page.goto(`/task/${LEAF_CTA_SLUG}`)

    await expect(page.getByTestId('task-detail')).toBeVisible()
    await expect(page.locator('.stage-chain').first()).toBeVisible()
  })
})

test.describe('the card button row', () => {
  test('the open-detail arrow is gone from every card variant', async ({ page }) => {
    await page.goto('/')
    await expect(card(page, LEAF_CTA_SLUG).getByTestId('card-open-detail')).toHaveCount(0)

    await page.goto(`/task/${MS_PARENT_SLUG}`)
    await expect(milestoneCard(page).getByTestId('card-open-detail')).toHaveCount(0)
  })

  // The design's own order: `{{ c.when }}`, the terminal button, the 3-dots
  // menu (lines 249-254).
  test('the row reads timestamp, terminal, menu', async ({ page }) => {
    await page.goto('/')

    const row = card(page, LEAF_CTA_SLUG).locator('.card-header-right')
    const testids = await row.locator('> *').evaluateAll(els =>
      els.map(el => (el as HTMLElement).dataset.testid ?? el.className)
    )
    expect(testids[0]).toBe('card-time')
    expect(testids[1]).toBe('focus-btn')
    expect(testids[2]).toContain('card-menu-wrap')
  })

  test('the terminal button draws the design\'s glyph and opens the terminal', async ({ page }) => {
    await page.goto('/')

    const btn = card(page, LEAF_CTA_SLUG).locator('.card-header-right').getByTestId('focus-btn')
    await expect(btn).toBeVisible()
    await expect(btn).toHaveAttribute('title', 'Open terminal')
    await expect(btn).toHaveAttribute('data-action', 'focus')
    expect(await pathsOf(btn)).toContain(TERMINAL_PATH_D)
  })

  // A paused card reaches the same button through the resume testid — the
  // one affordance that used to live in the footer, so losing it would be a
  // real regression rather than a restyle.
  test('a paused card keeps its resume button in the row', async ({ page }) => {
    await page.goto('/')

    const btn = card(page, HANDOVER_SLUG).locator('.card-header-right').getByTestId('resume-btn')
    await expect(btn).toBeVisible()
    expect(await pathsOf(btn)).toContain(TERMINAL_PATH_D)
  })

  // One terminal button per card footer is the design's footer (line 345):
  // the CTA alone, `flex:1 1 auto`. The button moved up into the row above.
  test('the footer carries the CTA alone', async ({ page }) => {
    await page.goto('/')

    const footer = card(page, LEAF_CTA_SLUG).locator('.card-footer')
    await expect(footer.getByTestId('card-cta-btn')).toHaveCount(1)
    await expect(footer.getByTestId('focus-btn')).toHaveCount(0)
    await expect(footer.getByTestId('resume-btn')).toHaveCount(0)
  })

  // The merge footer (cardFooterHtml's own merge branch) is the one footer
  // with more than one control, and it lost its terminal button to the
  // header row too — otherwise a merge-ready card would carry two.
  test('the merge footer lost its terminal button as well', async ({ page }) => {
    await page.goto('/')

    const c = card(page, MERGE_READY_SLUG)
    const footer = c.locator('.card-footer')
    await expect(footer.getByTestId('card-merge-pr-btn')).toHaveCount(1)
    await expect(footer.getByTestId('focus-btn')).toHaveCount(0)
    await expect(c.locator('.card-header-right').getByTestId('focus-btn')).toHaveCount(1)
  })

  // A milestone card with a live child gets the same treatment.
  test('a milestone card with a live child carries the terminal button', async ({ page }) => {
    await page.goto(`/task/${MS_PARENT_SLUG}`)

    const btn = milestoneCard(page).locator('.card-header-right').getByTestId('focus-btn')
    await expect(btn).toBeVisible()
    expect(await pathsOf(btn)).toContain(TERMINAL_PATH_D)
  })
})

test.describe('every card shows a CTA', () => {
  test('a leaf task parked at a handoff keeps its stage CTA', async ({ page }) => {
    await page.goto('/')

    const cta = card(page, LEAF_CTA_SLUG).getByTestId('card-cta-btn')
    await expect(cta).toContainText('Start dev')
    await expect(cta).toHaveAttribute('data-action', 'stage-skill')
  })

  // The developer's own example: the parent's STATUS would name "dev" on a
  // leaf, but dev is dispatched per milestone, so the parent has no single
  // next action to offer.
  test('a milestone-declaring parent reads "See details", not a stage', async ({ page }) => {
    await page.goto('/')

    const cta = card(page, PARENT_SLUG).getByTestId('card-cta-btn')
    await expect(cta).toContainText('See details')
    await expect(cta).not.toContainText('Start dev')
    await expect(cta).toHaveAttribute('data-action', 'open-detail')
  })

  test('the parent CTA opens that task\'s detail view', async ({ page }) => {
    await page.goto('/')
    await card(page, PARENT_SLUG).getByTestId('card-cta-btn').click()

    await expect(page.getByTestId('task-detail')).toBeVisible()
    await expect(page).toHaveURL(`/task/${PARENT_SLUG}`)
  })

  // The card that used to render a terminal-only footer and no CTA at all.
  test('a card waiting on a human decision reads "See details" too', async ({ page }) => {
    await page.goto('/')

    const cta = card(page, DECISION_SLUG).getByTestId('card-cta-btn')
    await expect(cta).toBeVisible()
    await expect(cta).toContainText('See details')
  })

  // The sweep the task actually asked for: not "the three cards we thought
  // of", but every card the board renders a footer for. A merge-ready card
  // counts as answered by its own Merge button rather than a `card-cta-btn`
  // — that footer IS its call to action (see cardFooterHtml's merge branch).
  test('no card on the board renders a footer without a CTA', async ({ page }) => {
    await page.goto('/')
    await expect(card(page, LEAF_CTA_SLUG)).toBeVisible()

    const missing = await page.locator('[data-testid="task-card"]').evaluateAll(cards =>
      cards
        .filter(c => c.querySelector('.card-footer'))
        .filter(c => !c.querySelector('[data-testid="card-cta-btn"], [data-testid="card-merge-pr-btn"]'))
        .map(c => (c as HTMLElement).dataset.slug ?? '?')
    )
    expect(missing).toEqual([])
  })

  // The design's own counter-case (`footerDisplay`): a working LEAF is
  // already doing the thing, so it has no footer to fill.
  test('a working leaf still has no footer', async ({ page }) => {
    await page.goto('/')

    await expect(card(page, WORKING_SLUG).locator('.card-footer')).toHaveCount(0)
  })

  // The header already carries the terminal button on every card, so a
  // working leaf's ctx row must not draw a second one beside the meter.
  test('a working leaf shows its terminal button once, in the header', async ({ page }) => {
    await page.goto('/')

    const c = card(page, WORKING_SLUG)
    await expect(c.getByTestId('focus-btn')).toHaveCount(1)
    await expect(c.locator('.card-header-right').getByTestId('focus-btn')).toHaveCount(1)
    await expect(c.getByTestId('card-terminal-inline')).toHaveCount(0)
  })

  // A milestone card is a card. Its child is parked at "CR approved, ready
  // for QA", so the footer names that stage rather than showing a bare
  // terminal button.
  test('a milestone card with a live child names its next stage', async ({ page }) => {
    await page.goto(`/task/${MS_PARENT_SLUG}`)

    const cta = milestoneCard(page).getByTestId('card-cta-btn')
    await expect(cta).toContainText('Start QA')
    await expect(cta).toHaveAttribute('data-action', 'stage-skill')
  })

  // The other half of `isWorkingLeaf`. The leaf case above asserts the
  // footer is suppressed; this asserts a PARENT is not caught by the same
  // rule — its own session running says nothing about whether its
  // milestones need attention.
  test('a working parent keeps its footer', async ({ page }) => {
    await page.goto('/')

    const c = card(page, WORKING_PARENT_SLUG)
    await expect(c).toHaveAttribute('data-lifecycle-status', 'working')
    await expect(c.locator('.card-footer')).toHaveCount(1)
    await expect(c.getByTestId('card-cta-btn')).toContainText('See details')
  })
})

test.describe('the footer CTA spans the footer', () => {
  // The design's footer CTA is `flex:1 1 auto` (Pipelinely Dashboard v2
  // .dc.html line 345) — ONE full-width button, whatever its colour. This
  // repo had the whole geometry (`flex`, the 10px/14px padding, the 10px
  // radius, the 13px type) scoped to `.btn-primary`, so a non-primary CTA
  // fell back to the base `.btn`'s `display:inline-block` and rendered
  // shrink-to-fit — hugging the left edge with the rest of the footer empty.
  // Asserted as a ratio of the footer's own content box rather than a pixel
  // width, so the case survives the card grid being re-sized.
  async function ctaFillRatio(page: Page, slug: string): Promise<number> {
    return card(page, slug).evaluate(el => {
      const footer = el.querySelector('.card-footer') as HTMLElement
      const cta = el.querySelector('[data-testid="card-cta-btn"]') as HTMLElement
      const style = getComputedStyle(footer)
      const inner =
        footer.getBoundingClientRect().width -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight)
      return cta.getBoundingClientRect().width / inner
    })
  }

  test('a primary CTA fills its footer', async ({ page }) => {
    await page.goto('/')

    await expect(card(page, LEAF_CTA_SLUG).getByTestId('card-cta-btn'))
      .toHaveAttribute('data-primary', 'true')
    expect(await ctaFillRatio(page, LEAF_CTA_SLUG)).toBeCloseTo(1, 2)
  })

  // The regression case: same footer, same design rule, no `btn-primary`.
  test('a NON-primary CTA fills its footer too', async ({ page }) => {
    await page.goto('/')

    await expect(card(page, WORKING_PARENT_SLUG).getByTestId('card-cta-btn'))
      .toHaveAttribute('data-primary', 'false')
    expect(await ctaFillRatio(page, WORKING_PARENT_SLUG)).toBeCloseTo(1, 2)
  })

  // The design gives both states the same geometry and varies only the
  // colour (`ctaBg`/`ctaFg`/`ctaBorder`, lines 649-651), so the padding,
  // radius and type size must not live on the primary rule either.
  test('both states share the design\'s own button geometry', async ({ page }) => {
    await page.goto('/')

    for (const slug of [LEAF_CTA_SLUG, WORKING_PARENT_SLUG]) {
      const cta = card(page, slug).getByTestId('card-cta-btn')
      expect(await cssOf(cta, 'padding-top')).toBe('10px')
      expect(await cssOf(cta, 'padding-left')).toBe('14px')
      expect(await cssOf(cta, 'border-radius')).toBe('10px')
      expect(await cssOf(cta, 'font-size')).toBe('13px')
      expect(await cssOf(cta, 'justify-content')).toBe('center')
    }
  })
})

// The inner page's Back control (Pipelinely Pipeline.dc.html lines 91-93).
//
// The design puts Back in the APP HEADER as a 32px pill — `‹ Back` on a
// surface capsule, pushed hard left with `margin-right:auto` so the rest of
// the header chrome sits to its right. This repo shipped the header slot for
// it (`#header-back-slot`), the `.back-pill` hover rule and even the
// responsive `order` comment describing the design's own `backOrder` — and
// then never rendered anything into it. The actual back affordance was a bare
// `‹` glyph at 26px/300 tucked into the detail title row, which is neither
// the design's shape nor its position.
test.describe('the inner page\'s Back control', () => {
  const backPill = (page: Page) => page.getByTestId('detail-close')

  test('the board itself has no Back pill', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByTestId('header-back-slot')).toBeHidden()
    await expect(backPill(page)).toHaveCount(0)
  })

  test('opening a task fills the header slot with the design\'s Back pill', async ({ page }) => {
    await page.goto(`/task/${LEAF_CTA_SLUG}`)
    await expect(page.getByTestId('task-detail')).toBeVisible()

    const back = backPill(page)
    await expect(back).toBeVisible()
    await expect(back).toHaveText('Back')
    // It lives in the header, not inside the detail panel.
    await expect(page.getByTestId('header-back-slot').getByTestId('detail-close')).toHaveCount(1)
    await expect(page.getByTestId('task-detail').getByTestId('detail-close')).toHaveCount(0)
  })

  test('it renders the design\'s own pill geometry', async ({ page }) => {
    await page.goto(`/task/${LEAF_CTA_SLUG}`)
    const back = backPill(page)
    await expect(back).toBeVisible()

    expect(await cssOf(back, 'height')).toBe('32px')
    expect(await cssOf(back, 'border-radius')).toBe('999px')
    expect(await cssOf(back, 'background-color')).toBe(TOKEN.surface)
    expect(await cssOf(back, 'border-top-color')).toBe(TOKEN.border)
    expect(await cssOf(back, 'color')).toBe(TOKEN.text2)
    expect(await cssOf(back, 'font-size')).toBe('12.5px')
    expect(await cssOf(back, 'font-weight')).toBe('600')
    // The design's asymmetric padding: tighter on the icon side.
    expect(await cssOf(back, 'padding-left')).toBe('12px')
    expect(await cssOf(back, 'padding-right')).toBe('15px')
    expect(await cssOf(back, 'column-gap')).toBe('8px')
  })

  // The design's own back chevron, asserted by path rather than trusted —
  // the same reason the terminal button's glyph is asserted above.
  test('it draws the design\'s back chevron', async ({ page }) => {
    await page.goto(`/task/${LEAF_CTA_SLUG}`)

    expect(await pathsOf(backPill(page))).toContain('M19 12H6M11.5 18l-6-6 6-6')
  })

  // `margin-right:auto` in the design: Back is the leftmost thing in the
  // header and everything else is pushed to the right of it.
  test('it sits to the left of the header chrome', async ({ page }) => {
    await page.goto(`/task/${LEAF_CTA_SLUG}`)

    const back = await backPill(page).boundingBox()
    const spend = await page.getByTestId('header-spend').boundingBox()
    expect(back!.x + back!.width).toBeLessThan(spend!.x)
  })

  test('clicking it returns to the board', async ({ page }) => {
    await page.goto(`/task/${LEAF_CTA_SLUG}`)
    await expect(page.getByTestId('task-detail')).toBeVisible()

    await backPill(page).click()

    await expect(page.getByTestId('task-detail')).toBeHidden()
    await expect(page.getByTestId('summary-strip')).toBeVisible()
    await expect(page).toHaveURL('/')
    // And the slot empties again, rather than leaving a stale pill in the
    // header over the board.
    await expect(page.getByTestId('header-back-slot')).toBeHidden()
  })

  test('the old chevron glyph is gone from the title row', async ({ page }) => {
    await page.goto(`/task/${LEAF_CTA_SLUG}`)

    await expect(page.locator('.detail-title-row .detail-back')).toHaveCount(0)
  })
})
