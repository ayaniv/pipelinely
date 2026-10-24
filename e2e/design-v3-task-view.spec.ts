import { test, expect, type Page } from '@playwright/test'
import { STAGE_TONE, TOKEN, DESKTOP, cssOf } from './fixtures/designTokens'
import { freezeLiveFeed, pushSnapshot } from './fixtures/liveBoard'
import { gotoBoardTab } from './fixtures/boardTabs'

// dashboard-v3-update M5 — the inner task view picks up the card's stage
// identity and creature (REQUEST-v3-full.md §5, was CLAUDE_CODE_PROMPT_v3.md
// "Changes: inner task view"; Pipelinely
// Pipeline.dc.html head model, lines 930-950). The view derives stage,
// status, stage key and summary from the same task through the same shared
// model the card uses (QUESTIONS.md default #13), so a cold deep link matches
// the card exactly as a click-through does.

test.use({ colorScheme: 'light', viewport: DESKTOP })

const card = (page: Page, slug: string) => page.locator(`[data-testid="task-card"][data-slug="${slug}"]`)
const stagePill = (page: Page) => page.getByTestId('task-detail').getByTestId('detail-stage-pill')

async function openFromCard(page: Page, slug: string) {
  await page.goto('/')
  await card(page, slug).getByTestId('card-title').click()
  await expect(page.getByTestId('task-detail')).toBeVisible()
}

test.describe('header stage pill', () => {
  test('a Needs you task shows the card\'s own stage pill in stage colours, then "needs you"', async ({ page }) => {
    await page.goto('/')
    const cardPillText = await card(page, 'cr-fixes-ready').getByTestId('card-status-pill').innerText()
    await card(page, 'cr-fixes-ready').getByTestId('card-title').click()
    await expect(stagePill(page)).toHaveAttribute('data-tone', 'cr')
    await expect(stagePill(page)).toHaveText(cardPillText)
    expect(await cssOf(stagePill(page), 'background-color')).toBe(STAGE_TONE.cr.soft)
    await expect(page.getByTestId('detail-attention')).toHaveAttribute('data-attention', 'needs-you')
  })

  test('a Working task uses the accent pill with a pulsing dot, then "working"', async ({ page }) => {
    await page.goto('/task/board-metrics')
    await expect(page.getByTestId('task-detail')).toBeVisible()
    await freezeLiveFeed(page)
    await pushSnapshot(page, { taskPatches: { 'board-metrics': { stage: 'qa', status: 'working', attentionStatus: 'working' } } })
    expect(await cssOf(stagePill(page), 'background-color')).toBe(TOKEN.accentSoft)
    await expect(page.getByTestId('detail-attention')).toHaveAttribute('data-attention', 'working')
    const dot = stagePill(page).getByTestId('detail-stage-dot')
    expect(await cssOf(dot, 'animation-name')).not.toBe('none')
  })

  test('a done task shows a sage "Merged" pill', async ({ page }) => {
    await page.goto('/task/board-done-one')
    await expect(stagePill(page)).toHaveAttribute('data-variant', 'merged')
    expect(await cssOf(stagePill(page), 'background-color')).toBe(TOKEN.sageSoft)
  })

  test('a shelved task shows a neutral "Backlog" pill', async ({ page }) => {
    await page.goto('/task/shelved-task')
    await expect(stagePill(page)).toHaveAttribute('data-variant', 'backlog')
    expect(await cssOf(stagePill(page), 'background-color')).toBe(TOKEN.surface2)
  })

  test('a cold deep link (no router state) renders the same pill as the click-through', async ({ page }) => {
    await openFromCard(page, 'dev-ready')
    const viaCard = await stagePill(page).getAttribute('data-tone')
    await page.goto('/task/dev-ready')
    await expect(stagePill(page)).toHaveAttribute('data-tone', viaCard ?? 'missing')
  })
})

test.describe('header creature', () => {
  test('the header starts with the task\'s 30px creature and its name, before the stage pill', async ({ page }) => {
    const tasks = (await page.request.get('/api/tasks').then((r) => r.json())).tasks as { slug: string; creature: { name: string } }[]
    const creature = tasks.find((t) => t.slug === 'cr-fixes-ready')!.creature
    await openFromCard(page, 'cr-fixes-ready')
    const detail = page.getByTestId('task-detail')
    const body = detail.getByTestId('detail-creature').getByTestId('creature')
    await expect(body).toHaveAttribute('data-name', creature.name)
    await expect(body).toHaveAttribute('title', `${creature.name} is on this task`)
    const [bodyBox, pillBox] = await Promise.all([body.boundingBox(), stagePill(page).boundingBox()])
    expect(Math.round(bodyBox!.width)).toBe(30)
    expect(bodyBox!.x).toBeLessThan(pillBox!.x)
    await expect(detail.getByTestId('detail-creature').getByTestId('creature-name')).toHaveText(creature.name)
  })

  test('with creaturePlacement "off" the header has no creature', async ({ page }) => {
    await page.goto('/task/cr-fixes-ready')
    await expect(page.getByTestId('task-detail')).toBeVisible()
    await freezeLiveFeed(page)
    await pushSnapshot(page, { settings: { creaturePlacement: 'off' } })
    await expect(page.getByTestId('detail-creature')).toHaveCount(0)
    await expect(stagePill(page)).toBeVisible()
  })
})

test.describe('rail current stage', () => {
  test('the node for the task\'s own stage is marked, even when the selected tab defaults elsewhere', async ({ page }) => {
    await page.goto('/task/board-metrics')
    await expect(page.getByTestId('task-detail')).toBeVisible()
    await freezeLiveFeed(page)
    // A working QA task has no next-stage marker, so the selected tab falls
    // back to Dev — the rail must still mark QA as where the task is.
    await pushSnapshot(page, { taskPatches: { 'board-metrics': { stage: 'qa', status: 'working', attentionStatus: 'working' } } })
    await expect(page.getByTestId('stage-chain-qa')).toHaveAttribute('data-task-stage', 'true')
    await expect(page.getByTestId('stage-chain-dev')).not.toHaveAttribute('data-task-stage', 'true')
  })

  test('it matches the stage the card showed', async ({ page }) => {
    await page.goto('/')
    const cardStage = await card(page, 'qa-fixes-ready').locator('[data-testid="mini-stage-node"][data-state="current"]').getAttribute('data-stage')
    await card(page, 'qa-fixes-ready').getByTestId('card-title').click()
    await expect(page.getByTestId(`stage-chain-${cardStage}`)).toHaveAttribute('data-task-stage', 'true')
  })

  test('a done task marks no node as its current stage', async ({ page }) => {
    await page.goto('/task/board-done-one')
    await expect(page.getByTestId('pipeline-chart')).toBeVisible()
    await expect(page.locator('[data-task-stage="true"]')).toHaveCount(0)
  })
})

test.describe('summary callout', () => {
  test('a Needs you task shows the card\'s summary callout under the title and slug', async ({ page }) => {
    await page.goto('/task/dev-ready')
    await expect(page.getByTestId('task-detail')).toBeVisible()
    await freezeLiveFeed(page)
    await pushSnapshot(page, { taskPatches: { 'dev-ready': { stage: 'dev', waitingReason: 'Plan reviewed. Two milestones, both ready to start.' } } })
    const summary = page.getByTestId('task-detail').getByTestId('detail-summary')
    await expect(summary).toBeVisible()
    await expect(summary).toHaveAttribute('data-icon', 'dot')
    expect(await cssOf(summary, 'background-color')).toBe(STAGE_TONE.dev.soft)
    await expect(summary.getByTestId('card-summary-head')).toHaveCSS('color', STAGE_TONE.dev.ink)

    const [slugBox, summaryBox] = await Promise.all([page.getByTestId('detail-slug-row').boundingBox(), summary.boundingBox()])
    expect(summaryBox!.y).toBeGreaterThan(slugBox!.y)
  })

  test('a Working task has no summary callout', async ({ page }) => {
    await page.goto('/task/board-metrics')
    await expect(page.getByTestId('task-detail')).toBeVisible()
    await freezeLiveFeed(page)
    await pushSnapshot(page, { taskPatches: { 'board-metrics': { status: 'working', attentionStatus: 'working' } } })
    await expect(stagePill(page)).toBeVisible()
    await expect(page.getByTestId('detail-summary')).toHaveCount(0)
  })
})

test.describe('Back returns to the originating tab', () => {
  test('from Active', async ({ page }) => {
    await openFromCard(page, 'dev-ready')
    await expect(stagePill(page)).toBeVisible()
    await page.getByTestId('detail-close').click()
    await expect(page).toHaveURL('/')
  })

  test('from Done', async ({ page }) => {
    await gotoBoardTab(page, 'done')
    await page.getByTestId('done-row-link').first().click()
    await expect(stagePill(page)).toHaveAttribute('data-variant', 'merged')
    await page.getByTestId('detail-close').click()
    await expect(page).toHaveURL('/done')
  })
})
