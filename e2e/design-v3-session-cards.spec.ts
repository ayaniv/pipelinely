import { test, expect, type Page, type Route } from '@playwright/test'
import { STAGE_TONE, STAGE_TONE_DARK, TOKEN, DESKTOP, MOBILE, cssOf } from './fixtures/designTokens'
import { freezeLiveFeed, pushSnapshot } from './fixtures/liveBoard'
import { PUSHED_APPROVAL_BUTTON_COUNT, PUSHED_APPROVAL_PROMPT } from './fixtures/approvalPrompts'

// dashboard-v3-update M2 — the v3 session card (REQUEST-v3-full.md §2, was
// CLAUDE_CODE_PROMPT_v3.md
// "Session cards" + "Stage palette"; Pipelinely Dashboard v3.dc.html lines
// 294-460 and its `nodes()` / `tone()` / card model). Committed red, tagged
//; M2's dev stage removes the tags once green.
//
// Fixture tasks used (e2e/fixtures/tasks):
//   dev-ready             waiting "plan reviewed, ready for dev"      → Needs you, dev
//   cr-fixes-ready        waiting "… triage and dispatch cr-fixes"   → Needs you, CR fixes, PR #42
//   qa-fixes-ready        waiting "… triage and dispatch qa-fixes"   → Needs you, QA fixes, PR #42
//   merge-ready           waiting "QA passed, ready to merge"        → Needs you, merge, PR #42
//   filters-web-needs-you waiting with no next-stage marker          → Needs you, no next step
//   fanout-parent         milestone-declaring parent                 → Needs you, parent
//   qa-spec-preview-parent-m0  live milestone child                  → Needs you, ↳ parent pill
//   board-metrics         working                                    → Working

test.use({ colorScheme: 'light', viewport: DESKTOP })

const card = (page: Page, slug: string) => page.locator(`[data-testid="task-card"][data-slug="${slug}"]`)

async function openFrozenBoard(page: Page) {
  await page.goto('/')
  await expect(page.getByTestId('task-card').first()).toBeVisible()
  await freezeLiveFeed(page)
}

test.describe('stage palette tokens', () => {
  test('the five stage tones are defined for light theme', async ({ page }) => {
    await page.goto('/')
    const read = (name: string) => page.evaluate((n) => {
      const probe = document.createElement('div')
      probe.style.color = `var(${n})`
      document.body.appendChild(probe)
      const value = getComputedStyle(probe).color
      probe.remove()
      return value
    }, name)
    for (const [key, tone] of Object.entries(STAGE_TONE)) {
      expect(await read(`--${key}C`)).toBe(tone.c)
      expect(await read(`--${key}Soft`)).toBe(tone.soft)
      expect(await read(`--${key}Ink`)).toBe(tone.ink)
    }
  })

  test('dark theme redefines them rather than inheriting light', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('cockpit-theme', 'dark'))
    await page.goto('/')
    const devCurrent = card(page, 'dev-ready').locator('[data-testid="mini-stage-node"][data-state="current"]')
    expect(await cssOf(devCurrent, 'border-top-color')).toBe(STAGE_TONE_DARK.dev.c)
  })
})

test.describe('card header', () => {
  test('pill, off-focus chip, then a right-aligned date, terminal and 3-dots group', async ({ page }) => {
    await openFrozenBoard(page)
    await pushSnapshot(page, { taskPatches: { 'board-metrics': { attentionStatus: 'working', status: 'working' } } })
    const header = card(page, 'board-metrics').getByTestId('card-header')
    await expect(header.getByTestId('card-status-pill')).toBeVisible()
    await expect(header.getByTestId('card-time')).toBeVisible()
    await expect(header.getByTestId('focus-btn')).toBeVisible()
    await expect(header.getByTestId('card-menu-btn')).toBeVisible()
    const terminal = await header.getByTestId('focus-btn').boundingBox()
    expect(terminal!.width).toBe(24)
    expect(terminal!.height).toBe(24)
  })

  test('the header wraps instead of squeezing on a narrow card', async ({ page }) => {
    await page.goto('/')
    expect(await cssOf(card(page, 'dev-ready').getByTestId('card-header'), 'flex-wrap')).toBe('wrap')
  })

  test('a session with no live terminal (paused) shows no terminal button anywhere on the card', async ({ page }) => {
    await page.goto('/')
    const paused = card(page, 'filters-api-paused')
    await expect(paused).toBeVisible()
    await expect(paused.getByTestId('focus-btn')).toHaveCount(0)
    await expect(paused.getByTestId('resume-btn')).toHaveCount(0)
  })

  test('the footer carries no terminal button', async ({ page }) => {
    await page.goto('/')
    const footer = card(page, 'dev-ready').getByTestId('card-footer')
    await expect(footer).toBeVisible()
    await expect(footer.getByTestId('focus-btn')).toHaveCount(0)
  })
})

test.describe('card title and PR link', () => {
  test('the title is the link to the task and turns accent on hover', async ({ page }) => {
    await page.goto('/')
    const title = card(page, 'dev-ready').getByTestId('card-title')
    await expect(title).toHaveAttribute('href', '/task/dev-ready')
    await title.hover()
    await expect(title).toHaveCSS('color', TOKEN.accent)
    await title.click()
    await expect(page).toHaveURL(/\/task\/dev-ready/)
  })

  test('a task with a PR shows a right-aligned GitHub #<n> link that opens the PR, not the card', async ({ page }) => {
    const opened: string[] = []
    await page.route('**/open-pr/*', (route: Route) => {
      opened.push(new URL(route.request().url()).pathname)
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    })
    await openFrozenBoard(page)
    await pushSnapshot(page, { taskPatches: { 'cr-fixes-ready': { prNumber: '42' } } })
    const prLink = card(page, 'cr-fixes-ready').getByTestId('card-pr-link')
    await expect(prLink).toBeVisible()
    await expect(prLink).toHaveAttribute('data-pr', '42')
    await expect(prLink.getByTestId('github-icon')).toBeVisible()

    // Right-aligned on the project/slug row.
    const row = card(page, 'cr-fixes-ready').getByTestId('card-slug-row')
    const [rowBox, linkBox] = await Promise.all([row.boundingBox(), prLink.boundingBox()])
    expect(Math.abs(rowBox!.x + rowBox!.width - (linkBox!.x + linkBox!.width))).toBeLessThanOrEqual(2)

    await prLink.click()
    await expect.poll(() => opened).toEqual(['/open-pr/cr-fixes-ready'])
    await expect(page.getByTestId('task-detail')).toBeHidden()
    await expect(page).toHaveURL('/')
  })

  test('the "off focus" chip sits inline right after the title, not in the header, and there is no title arrow', async ({ page }) => {
    await page.goto('/')
    const target = card(page, 'board-metrics')
    await target.getByTestId('card-menu-btn').click()
    // Looked up from the page: M4 portals the open menu to document.body.
    await page.getByTestId('card-menu-toggle-off-focus').click()
    const chip = target.getByTestId('card-title-block').getByTestId('card-off-focus-chip')
    await expect(chip).toBeVisible()
    await expect(target.getByTestId('card-header').getByTestId('card-off-focus-chip')).toHaveCount(0)
    const [titleBox, chipBox] = await Promise.all([target.getByTestId('card-title').boundingBox(), chip.boundingBox()])
    expect(chipBox!.x).toBeGreaterThan(titleBox!.x)
    await expect(target.getByTestId('card-title-arrow')).toHaveCount(0)
  })

  // fanout-parent-m0 is done (no Active card); qa-spec-preview-parent-m0 is
  // the live milestone child with a card of its own.
  test('a subtask carries a "↳ parent" pill that opens the parent', async ({ page }) => {
    await page.goto('/')
    const child = card(page, 'qa-spec-preview-parent-m0')
    await child.getByTestId('ms-parent-link').click()
    await expect(page).toHaveURL(/\/task\/qa-spec-preview-parent(\?|$)/)
  })

  test('a task without a PR shows no PR link', async ({ page }) => {
    await page.goto('/')
    await expect(card(page, 'dev-ready')).toBeVisible()
    await expect(card(page, 'dev-ready').getByTestId('card-pr-link')).toHaveCount(0)
  })

  test('a failed PR open flashes on the link and still does not open the card', async ({ page }) => {
    await page.route('**/open-pr/*', (route: Route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"gh failed"}' }))
    await openFrozenBoard(page)
    await pushSnapshot(page, { taskPatches: { 'cr-fixes-ready': { prNumber: '42' } } })
    const prLink = card(page, 'cr-fixes-ready').getByTestId('card-pr-link')
    await prLink.click()
    await expect(prLink).toHaveClass(/btn-err/)
    await expect(page.getByTestId('task-detail')).toBeHidden()
  })
})

test.describe('grid widths', () => {
  test('Needs you cards are at least 420px (two per row); Working cards stay at the 300px column', async ({ page }) => {
    await page.goto('/')
    const needs = page.getByTestId('active-group-needs').getByTestId('task-card').first()
    const working = page.getByTestId('active-group-working').getByTestId('task-card').first()
    const needsBox = await needs.boundingBox()
    const workingBox = await working.boundingBox()
    expect(needsBox!.width).toBeGreaterThanOrEqual(420)
    expect(workingBox!.width).toBeGreaterThanOrEqual(300)
    expect(workingBox!.width).toBeLessThan(420)
  })

  test('cards still collapse to one column on mobile', async ({ page }) => {
    await page.setViewportSize(MOBILE)
    await page.goto('/')
    const needs = page.getByTestId('active-group-needs').getByTestId('task-card').first()
    const box = await needs.boundingBox()
    expect(box!.width).toBeLessThanOrEqual(MOBILE.width)
  })
})

test.describe('stage rail', () => {
  test('Needs you rails label every node and bold the current one in the stage ink', async ({ page }) => {
    await page.goto('/')
    const rail = card(page, 'cr-fixes-ready')
    await expect(rail.getByTestId('mini-stage-label')).toHaveCount(5)
    const current = rail.locator('[data-testid="mini-stage-node"][data-state="current"]')
    await expect(current).toHaveAttribute('data-stage', 'cr')
    expect(await cssOf(current, 'border-top-color')).toBe(STAGE_TONE.cr.c)
    const currentLabel = rail.locator('[data-testid="mini-stage-label"][data-current="true"]')
    await expect(currentLabel).toHaveCSS('font-weight', '700')
    await expect(currentLabel).toHaveCSS('color', STAGE_TONE.cr.ink)
  })

  test('Working rails use the stage colour too, but carry no labels', async ({ page }) => {
    await openFrozenBoard(page)
    await pushSnapshot(page, { taskPatches: { 'board-metrics': { stage: 'qa', attentionStatus: 'working', status: 'working' } } })
    const working = card(page, 'board-metrics')
    await expect(working.getByTestId('mini-stage-label')).toHaveCount(0)
    const current = working.locator('[data-testid="mini-stage-node"][data-state="current"]')
    expect(await cssOf(current, 'border-top-color')).toBe(STAGE_TONE.qa.c)
  })
})

test.describe('summary callout', () => {
  test('Needs you: stage-soft background, first sentence bold in stage ink, the rest in text2', async ({ page }) => {
    await openFrozenBoard(page)
    await pushSnapshot(page, { taskPatches: { 'dev-ready': { stage: 'dev', waitingReason: 'Plan reviewed. Two milestones, both ready to start.' } } })
    const summary = card(page, 'dev-ready').getByTestId('card-summary')
    await expect(summary).toBeVisible()
    expect(await cssOf(summary, 'background-color')).toBe(STAGE_TONE.dev.soft)
    const head = summary.getByTestId('card-summary-head')
    await expect(head).toHaveCSS('font-weight', '700')
    await expect(head).toHaveCSS('color', STAGE_TONE.dev.ink)
    await expect(summary.getByTestId('card-summary-rest')).toHaveCSS('color', TOKEN.text2)
    // The callout replaces the plain note line, so the reason is not shown twice.
    await expect(card(page, 'dev-ready').getByTestId('card-note')).toHaveCount(0)
  })

  test('the icon follows the stage key: check for merge, bubble for CR/QA fixes, dot otherwise', async ({ page }) => {
    await page.goto('/')
    await expect(card(page, 'merge-ready').getByTestId('card-summary')).toHaveAttribute('data-icon', 'check')
    await expect(card(page, 'cr-fixes-ready').getByTestId('card-summary')).toHaveAttribute('data-icon', 'comment')
    await expect(card(page, 'qa-fixes-ready').getByTestId('card-summary')).toHaveAttribute('data-icon', 'comment')
    await expect(card(page, 'dev-ready').getByTestId('card-summary')).toHaveAttribute('data-icon', 'dot')
  })

  test('a single-sentence summary has no rest line', async ({ page }) => {
    await openFrozenBoard(page)
    await pushSnapshot(page, { taskPatches: { 'dev-ready': { waitingReason: 'plan reviewed, ready for dev' } } })
    const summary = card(page, 'dev-ready').getByTestId('card-summary')
    await expect(summary.getByTestId('card-summary-head')).toBeVisible()
    await expect(summary.getByTestId('card-summary-rest')).toHaveCount(0)
  })

  test('Working cards have no summary callout', async ({ page }) => {
    await page.goto('/')
    await expect(card(page, 'board-metrics')).toBeVisible()
    await expect(card(page, 'board-metrics').getByTestId('card-summary')).toHaveCount(0)
  })
})

test.describe('ctx bar', () => {
  test('fills in the stage colour; above 60% the value turns amber and Handover appears', async ({ page }) => {
    await openFrozenBoard(page)
    await pushSnapshot(page, { taskPatches: { 'merge-ready': { contextPct: 40 }, 'cr-fixes-ready': { contextPct: 74 } } })
    const cool = card(page, 'merge-ready')
    expect(await cssOf(cool.getByTestId('ctx-meter-fill'), 'background-color')).toBe(STAGE_TONE.merge.c)
    await expect(cool.getByTestId('card-handover')).toHaveCount(0)

    const hot = card(page, 'cr-fixes-ready')
    expect(await cssOf(hot.getByTestId('ctx-meter-fill'), 'background-color')).toBe(STAGE_TONE.cr.c)
    await expect(hot.getByTestId('ctx-value')).toHaveCSS('color', TOKEN.amberInk)
    await expect(hot.getByTestId('card-handover')).toBeVisible()
  })

  test('at exactly 60% it is not hot', async ({ page }) => {
    await openFrozenBoard(page)
    await pushSnapshot(page, { taskPatches: { 'cr-fixes-ready': { contextPct: 60 } } })
    await expect(card(page, 'cr-fixes-ready').getByTestId('card-handover')).toHaveCount(0)
  })
})

test.describe('footer CTAs', () => {
  async function expectEvenSplit(page: Page, slug: string, left: string, right: string) {
    const footer = card(page, slug).getByTestId('card-footer')
    const [a, b] = await Promise.all([footer.getByTestId(left).boundingBox(), footer.getByTestId(right).boundingBox()])
    expect(Math.abs(a!.width - b!.width)).toBeLessThanOrEqual(1)
  }

  test('Dev: Start dev plus an outlined Read plan, split 50/50', async ({ page }) => {
    await page.goto('/')
    const footer = card(page, 'dev-ready').getByTestId('card-footer')
    await expect(footer.getByTestId('card-cta-btn')).toHaveAttribute('data-stage', 'dev')
    await expect(footer.getByTestId('card-cta-secondary')).toHaveAttribute('data-action', 'read-plan')
    await expectEvenSplit(page, 'dev-ready', 'card-cta-btn', 'card-cta-secondary')
  })

  test('Read plan opens the task on its Plan stage', async ({ page }) => {
    await page.goto('/')
    await card(page, 'dev-ready').getByTestId('card-cta-secondary').click()
    await expect(page).toHaveURL('/task/dev-ready?stage=planning')
    await expect(page.getByTestId('task-detail')).toBeVisible()
  })

  // `stage` is the pipeline Stage the run CTA dispatches; `chainId` is the task
  // view's ?stage= id for the same step. They differ for CR fixes
  // ('comment-fix' vs 'cr-fixes'): detailNav only honours a ChainStageId, so a
  // link built from the pipeline Stage would silently land on the default tab.
  for (const [slug, stage, chainId] of [['cr-fixes-ready', 'comment-fix', 'cr-fixes'], ['qa-fixes-ready', 'qa-fixes', 'qa-fixes']] as const) {
    test(`${stage}: the run CTA plus an outlined Triage comments that opens the triage checklist`, async ({ page }) => {
      await page.goto('/')
      const footer = card(page, slug).getByTestId('card-footer')
      await expect(footer.getByTestId('card-cta-btn')).toHaveAttribute('data-stage', stage)
      await expect(footer.getByTestId('card-cta-secondary')).toHaveAttribute('data-action', 'triage-comments')
      await expectEvenSplit(page, slug, 'card-cta-btn', 'card-cta-secondary')
      await footer.getByTestId('card-cta-secondary').click()
      await expect(page).toHaveURL(`/task/${slug}?stage=${chainId}`)
      await expect(page.getByTestId('triage-checklist')).toBeVisible()
    })
  }

  test('Merge: Merge plus an outlined Open PR with the GitHub icon, split 50/50', async ({ page }) => {
    await page.goto('/')
    const footer = card(page, 'merge-ready').getByTestId('card-footer')
    await expect(footer.getByTestId('card-merge-pr-btn')).toBeVisible()
    await expect(footer.getByTestId('card-open-pr-btn').getByTestId('github-icon')).toBeVisible()
    await expectEvenSplit(page, 'merge-ready', 'card-merge-pr-btn', 'card-open-pr-btn')
  })

  test('no next step: a single outlined Show task that opens the task', async ({ page }) => {
    await page.goto('/')
    const footer = card(page, 'filters-web-needs-you').getByTestId('card-footer')
    const cta = footer.getByTestId('card-cta-btn')
    await expect(cta).toHaveAttribute('data-action', 'open-detail')
    await expect(cta).toHaveAttribute('data-primary', 'false')
    await expect(footer.getByTestId('card-cta-secondary')).toHaveCount(0)
    await cta.click()
    await expect(page).toHaveURL(/\/task\/filters-web-needs-you/)
  })

  test('Working leaf cards have no footer at all', async ({ page }) => {
    await page.goto('/')
    const working = card(page, 'board-metrics')
    await expect(working).toBeVisible()
    await expect(working.getByTestId('card-footer')).toHaveCount(0)
  })
})

test.describe('stage colour scope', () => {
  test('Needs you badge uses the stage soft/ink; Working badge stays accent', async ({ page }) => {
    await openFrozenBoard(page)
    await pushSnapshot(page, { taskPatches: { 'board-metrics': { stage: 'code-review', attentionStatus: 'working', status: 'working' } } })
    expect(await cssOf(card(page, 'cr-fixes-ready').getByTestId('card-status-pill'), 'background-color')).toBe(STAGE_TONE.cr.soft)
    expect(await cssOf(card(page, 'board-metrics').getByTestId('card-status-pill'), 'background-color')).toBe(TOKEN.accentSoft)
  })

  test('card background and border stay neutral regardless of stage', async ({ page }) => {
    await page.goto('/')
    const needs = card(page, 'cr-fixes-ready')
    expect(await cssOf(needs, 'background-color')).toBe(TOKEN.surface)
    expect(await cssOf(needs, 'border-top-color')).toBe(TOKEN.amber)
    const working = card(page, 'board-metrics')
    expect(await cssOf(working, 'background-color')).toBe(TOKEN.surfaceMute)
    expect(await cssOf(working, 'border-top-color')).toBe(TOKEN.border)
  })
})

// Master's blocked-worker approval callout (#140-#142: ApprovalCallout and its
// answer buttons, card-approval*) predates nothing in v3 and must survive the
// card rewrite. These cases pin where it sits on a v3 card; the callout's own
// behaviour stays owned by answer-dialog-card.spec.ts and
// dashboard-blocked-workers.spec.ts, which must stay green unchanged. The
// prompt is pushed, not polled from the fixture tmux, so the cases don't wait
// on COCKPIT_APPROVAL_POLL_MS and no click can reach /answer-dialog.

test.describe('approval callout on the v3 card', () => {
  test('a blocked working worker sits in Needs you with its answer buttons and terminal button, and no empty summary or dispatch footer', async ({ page }) => {
    await openFrozenBoard(page)
    await pushSnapshot(page, {
      taskPatches: { 'board-metrics': { status: 'working', attentionStatus: 'needs-you', waitingReason: '', approvalPrompt: PUSHED_APPROVAL_PROMPT } },
    })
    const blocked = page.getByTestId('active-group-needs').locator('[data-testid="task-card"][data-slug="board-metrics"]')
    await expect(blocked).toBeVisible()
    await expect(blocked.getByTestId('card-approval')).toBeVisible()
    await expect(blocked.getByTestId('card-approval-option')).toHaveCount(PUSHED_APPROVAL_BUTTON_COUNT)
    await expect(blocked.getByTestId('card-header').getByTestId('focus-btn')).toBeVisible()
    // No waitingReason: the v3 summary callout renders nothing rather than an empty box.
    await expect(blocked.getByTestId('card-summary')).toHaveCount(0)
    // Its session is running (stopped on a dialog): a Start/Run CTA would dispatch a second one.
    await expect(blocked.getByTestId('card-footer')).toHaveCount(0)
  })

  test('with a summary too, the summary callout comes first and the approval callout under it, both above the ctx bar', async ({ page }) => {
    await openFrozenBoard(page)
    await pushSnapshot(page, { taskPatches: { 'dev-ready': { approvalPrompt: PUSHED_APPROVAL_PROMPT } } })
    const target = card(page, 'dev-ready')
    const [summary, approval, ctx] = await Promise.all([
      target.getByTestId('card-summary').boundingBox(),
      target.getByTestId('card-approval').boundingBox(),
      target.getByTestId('ctx-meter').boundingBox(),
    ])
    expect(approval!.y).toBeGreaterThanOrEqual(summary!.y + summary!.height - 1)
    expect(ctx!.y).toBeGreaterThanOrEqual(approval!.y + approval!.height - 1)
    await expect(target.getByTestId('card-approval-option')).toHaveCount(PUSHED_APPROVAL_BUTTON_COUNT)
  })

  test('a paused task stopped on a dialog still shows the terminal button', async ({ page }) => {
    await openFrozenBoard(page)
    await pushSnapshot(page, { taskPatches: { 'filters-api-paused': { attentionStatus: 'needs-you', approvalPrompt: PUSHED_APPROVAL_PROMPT } } })
    const blocked = card(page, 'filters-api-paused')
    await expect(blocked.getByTestId('card-approval')).toBeVisible()
    await expect(blocked.getByTestId('card-header').getByTestId('focus-btn')).toBeVisible()
  })
})
