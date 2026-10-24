import { test, expect, type Locator, type Page } from '@playwright/test'
import { DESKTOP } from './fixtures/designTokens'
import { freezeLiveFeed, pushSnapshot } from './fixtures/liveBoard'

// Dashboard v4 — the Active tab's Parent tasks section (DESIGN_PROMPT.md §1-§9).
// A fan-out parent is an overview row above Needs you, never a card: it shows
// its milestones as done / working / idle icons grouped by wave, a progress
// count and a Run wave / locked Wave N button. Fixtures only: the parents come
// from e2e/fixtures/tasks (wave-batch-parent: M0 merged, wave 2 = M1+M2, wave 3
// = M3) and the milestone states are varied by pushing patched snapshots.
// Nothing here dispatches: /batch-dispatch is always stubbed.

const PARENT = 'wave-batch-parent'
const WORKING_PARENT = 'working-fanout-parent'
const PARENT_REPO = 'cockpit-ai'
const MOBILE_CONTENT_WIDTH_PX = 650
const ROW_RIGHT_PADDING_PX = 16
const MIN_TITLE_CHARS = 30
const MIN_LENGTH_TITLE = 'Workspace billing model rework'
const LONG_PROJECT = 'acme-webapp-monorepo-with-a-very-long-project-name'
// Under one 12px character: the project is down to (at most) its ellipsis.
const MAX_SQUEEZED_PROJECT_PX = 12
// Room left on the line beyond the title: less than the title/project gap.
const TITLE_SLACK_PX = 6
// Six copies of the 30-character title run past the whole 1280px row, project or not.
const TITLE_REPEATS_PAST_ROW_WIDTH = 6

const MILESTONES_DONE = [
  { id: 'M0', name: 'Foundation', needs: [], estimate: '1h', specFile: null, wave: 1, task: null, state: 'done' },
]
const milestone = (id: string, wave: number, state: 'queued' | 'dispatched' | 'done', name = `${id} milestone`) =>
  ({ id, name, needs: [], estimate: null, specFile: null, wave, task: null, state })

const row = (page: Page, slug = PARENT) => page.locator(`[data-testid="parent-row"][data-slug="${slug}"]`)
const head = (page: Page, slug = PARENT) => row(page, slug).getByTestId('parent-row-head')
const waveButton = (page: Page, slug = PARENT) => row(page, slug).getByTestId('parent-wave-btn')

async function openFrozenBoard(page: Page) {
  await page.goto('/')
  await expect(row(page)).toBeVisible()
  await freezeLiveFeed(page)
}

// wave 1 done, wave 2 working (M1, M2), wave 3 idle (M3): the locked case.
async function pushLockedParent(page: Page) {
  await pushSnapshot(page, {
    taskPatches: {
      [PARENT]: { milestones: [milestone('M0', 1, 'done', 'Foundation'), milestone('M1', 2, 'dispatched', 'Left rail'), milestone('M2', 2, 'dispatched', 'Right rail'), milestone('M3', 3, 'queued', 'Polish')] },
    },
  })
}

function stubBatchDispatch(page: Page): { posts: unknown[] } {
  const recorded = { posts: [] as unknown[] }
  void page.route('**/batch-dispatch', (route) => {
    recorded.posts.push(route.request().postDataJSON())
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })
  return recorded
}

const widthOf = (locator: Locator) => locator.evaluate((el) => el.getBoundingClientRect().width)

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`Parent tasks section (${colorScheme})`, () => {
    test.use({ colorScheme, viewport: DESKTOP })

    test('sits above Needs you with a "Parent tasks · N" header, in both views, with no colour key', async ({ page }) => {
      await openFrozenBoard(page)
      const section = page.getByTestId('parent-tasks-section')
      const parentCount = await page.getByTestId('parent-row').count()
      await expect(section.getByTestId('active-group-header')).toContainText('Parent tasks')
      await expect(section.getByTestId('active-group-count')).toHaveText(`· ${parentCount}`)
      await expect(section.locator('.active-group-rule')).toHaveCount(1)
      await expect(page.getByTestId('parent-colour-key')).toHaveCount(0)

      const sectionBox = await section.boundingBox()
      const needsBox = await page.getByTestId('active-group-needs').boundingBox()
      expect(sectionBox!.y + sectionBox!.height).toBeLessThanOrEqual(needsBox!.y)

      await page.getByTestId('active-view-table').click()
      await expect(page.getByTestId('active-table-working')).toBeVisible()
      await expect(page.getByTestId('parent-tasks-section')).toBeVisible()
      const tableSectionBox = await page.getByTestId('parent-tasks-section').boundingBox()
      const tableNeedsBox = await page.getByTestId('active-group-needs').boundingBox()
      expect(tableSectionBox!.y + tableSectionBox!.height).toBeLessThanOrEqual(tableNeedsBox!.y)
    })

    test('a parent is never a card or a table row, and the pulse chips and Active count exclude it', async ({ page }) => {
      await openFrozenBoard(page)
      const parentSlugs = await page.getByTestId('parent-row').evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.slug))
      expect(parentSlugs).toContain(PARENT)
      for (const slug of parentSlugs) await expect(page.locator(`[data-testid="task-card"][data-slug="${slug}"]`)).toHaveCount(0)

      const leafCount = await page.getByTestId('task-card').count()
      await expect(page.getByTestId('tab-count-inprogress')).toHaveText(String(leafCount))
      const chips = await Promise.all(['pulse-chip-working', 'pulse-chip-waiting'].map((id) => page.getByTestId(id).innerText()))
      const chipTotal = chips.reduce((sum, text) => sum + Number(text.match(/\d+/)![0]), 0)
      expect(chipTotal).toBeLessThanOrEqual(leafCount)

      await page.getByTestId('active-view-table').click()
      await expect(page.getByTestId('active-table-working')).toBeVisible()
      for (const slug of parentSlugs) await expect(page.locator(`[data-testid="table-row"][data-slug="${slug}"]`)).toHaveCount(0)
      await expect(page.getByTestId('tab-count-inprogress')).toHaveText(String(leafCount))
    })

    test('hides when the project filter leaves no parent, and returns when it is cleared', async ({ page }) => {
      await openFrozenBoard(page)
      if (await page.getByTestId('board-filters').isHidden()) await page.getByTestId('filter-toggle-btn').click()
      const chips = await page.locator('[data-testid^="filter-chip-project-"]').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.testid!))
      const otherChip = chips.find((id) => !id.endsWith(`-${PARENT_REPO}`))
      expect(otherChip).toBeTruthy()
      await page.getByTestId(otherChip!).click()
      await expect(page.getByTestId('parent-tasks-section')).toHaveCount(0)
      await page.getByTestId(otherChip!).click()
      await expect(page.getByTestId('parent-tasks-section')).toBeVisible()
    })

    test('a row starts collapsed, toggles on a click, rotates its chevron and remembers it across a view switch', async ({ page }) => {
      await openFrozenBoard(page)
      await expect(row(page).getByTestId('parent-expanded')).toHaveCount(0)
      const closedTransform = await row(page).getByTestId('parent-chevron').evaluate((el) => getComputedStyle(el).transform)

      await head(page).click()
      await expect(row(page).getByTestId('parent-expanded')).toBeVisible()
      await expect(row(page).getByTestId('parent-chevron')).toHaveAttribute('aria-expanded', 'true')
      await expect.poll(() => row(page).getByTestId('parent-chevron').evaluate((el) => getComputedStyle(el).transform)).not.toBe(closedTransform)

      await page.getByTestId('active-view-table').click()
      await expect(row(page).getByTestId('parent-expanded')).toBeVisible()
      await page.getByTestId('active-view-cards').click()
      await expect(row(page).getByTestId('parent-expanded')).toBeVisible()

      await head(page).click()
      await expect(row(page).getByTestId('parent-expanded')).toHaveCount(0)
    })

    test('an expanded row lists a column per wave and links to the Dev stage of the parent', async ({ page }) => {
      await openFrozenBoard(page)
      await head(page).click()
      const columns = row(page).getByTestId('parent-wave-col')
      await expect(columns).toHaveCount(3)
      await expect(columns.first().getByTestId('parent-wave-eyebrow')).toHaveText('WAVE 1')
      await expect(columns.nth(1).getByTestId('parent-milestone-line')).toHaveCount(2)
      const link = row(page).getByTestId('parent-open-plan')
      await expect(link).toHaveAttribute('href', `/task/${PARENT}?stage=dev`)
      await link.click()
      await expect(page).toHaveURL(new RegExp(`/task/${PARENT}\\?stage=dev`))
    })

    test('Run wave N stages the wave and never toggles the row', async ({ page }) => {
      const recorded = stubBatchDispatch(page)
      await openFrozenBoard(page)
      // The fixture server is not the canonical dispatch instance; Run wave is
      // only enabled on one.
      await pushSnapshot(page, { isCanonical: true })
      await expect(waveButton(page)).toHaveAttribute('data-kind', 'run')
      await expect(waveButton(page)).toBeEnabled()
      await waveButton(page).click()
      await expect.poll(() => recorded.posts.length).toBe(1)
      expect(recorded.posts[0]).toEqual({ kind: 'wave', slugs: [`${PARENT}-m1`, `${PARENT}-m2`] })
      await expect(row(page).getByTestId('parent-expanded')).toHaveCount(0)
    })

    test('the locked Wave N button is disabled, explains what it waits on, and never toggles the row', async ({ page }) => {
      const recorded = stubBatchDispatch(page)
      await openFrozenBoard(page)
      await pushLockedParent(page)
      const button = waveButton(page)
      await expect(button).toHaveAttribute('data-kind', 'locked')
      await expect(button).toBeDisabled()
      await expect(button).toHaveAttribute('title', 'Waiting on wave 2 · M1 working, M2 working')
      expect(await button.evaluate((el) => getComputedStyle(el).cursor)).toBe('not-allowed')
      await row(page).getByTestId('parent-wave-btn-slot').click({ position: { x: 2, y: 2 } })
      await button.click({ force: true })
      await expect(row(page).getByTestId('parent-expanded')).toHaveCount(0)
      expect(recorded.posts).toEqual([])
    })

    test('off the canonical instance Run wave is disabled and says why, and a click stages nothing', async ({ page }) => {
      const recorded = stubBatchDispatch(page)
      await openFrozenBoard(page)
      await pushSnapshot(page, { isCanonical: false })
      const button = waveButton(page)
      await expect(button).toBeDisabled()
      await expect(button).toHaveAttribute('title', 'Read-only — this is not the canonical dashboard instance')
      await button.click({ force: true })
      expect(recorded.posts).toEqual([])
    })

    test('a wave with nothing queued and unblocked is disabled instead of clicking into nothing', async ({ page }) => {
      await openFrozenBoard(page)
      await pushSnapshot(page, { isCanonical: true, taskPatches: { [PARENT]: { milestones: [milestone('M0', 1, 'done'), { ...milestone('M1', 2, 'queued'), needs: ['M9'] }] } } })
      await expect(waveButton(page)).toBeDisabled()
      await expect(waveButton(page)).toHaveAttribute('title', 'Waiting on wave 2 · M1 queued')
    })

    test('a parent with no idle wave left shows no button', async ({ page }) => {
      await openFrozenBoard(page)
      await pushSnapshot(page, { taskPatches: { [PARENT]: { milestones: [milestone('M0', 1, 'done'), milestone('M1', 2, 'dispatched')] } } })
      await expect(row(page).getByTestId('parent-progress')).toHaveText('1 / 2 done')
      await expect(waveButton(page)).toHaveCount(0)
    })

    test('the three icon states are 15px and look different with colour removed', async ({ page }) => {
      await openFrozenBoard(page)
      await pushSnapshot(page, { taskPatches: { [PARENT]: { milestones: [milestone('M0', 1, 'done'), milestone('M1', 2, 'dispatched'), milestone('M2', 2, 'queued')] } } })
      const icons = row(page).getByTestId('milestone-icon')
      await expect(icons).toHaveCount(3)
      expect(await icons.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.state))).toEqual(['done', 'working', 'idle'])
      for (let index = 0; index < 3; index++) {
        const box = await icons.nth(index).boundingBox()
        expect(Math.round(box!.width)).toBe(15)
        expect(Math.round(box!.height)).toBe(15)
      }
      await page.addStyleTag({ content: 'html { filter: grayscale(1) !important; }' })
      const shots = await Promise.all([0, 1, 2].map((index) => icons.nth(index).screenshot({ animations: 'disabled' })))
      expect(shots[0].equals(shots[1])).toBe(false)
      expect(shots[0].equals(shots[2])).toBe(false)
      expect(shots[1].equals(shots[2])).toBe(false)
      await expect(icons.nth(0).getByTestId('milestone-icon-tick')).toHaveCount(1)
      await expect(icons.nth(1).getByTestId('milestone-icon-arc')).toHaveCount(1)
    })

    test('hovering an icon names the milestone and its state', async ({ page }) => {
      await openFrozenBoard(page)
      await pushLockedParent(page)
      const icon = row(page).getByTestId('milestone-icon').nth(1)
      await expect(icon).toHaveAttribute('aria-label', 'M1 · Left rail · working')
      await expect(icon.locator('title')).toHaveText('M1 · Left rail · working')
    })

    test('the working spinner turns for 1s, linear; reduced motion stops it but keeps the arc', async ({ page }) => {
      await openFrozenBoard(page)
      await pushLockedParent(page)
      const arc = row(page).getByTestId('milestone-icon-arc').first()
      const motion = () => arc.evaluate((el) => { const s = getComputedStyle(el); return { name: s.animationName, duration: s.animationDuration, timing: s.animationTimingFunction } })
      expect(await motion()).toEqual({ name: 'milestoneSpin', duration: '1s', timing: 'linear' })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      expect((await motion()).name).toBe('none')
      await expect(arc).toBeVisible()
    })

    test('no creature carries a shadow anywhere: cards, table rows or parent rows', async ({ page }) => {
      await openFrozenBoard(page)
      const noShadows = async () => {
        const styles = await page.getByTestId('creature').evaluateAll((els) => els.map((el) => { const s = getComputedStyle(el); return { boxShadow: s.boxShadow, filter: s.filter } }))
        expect(styles.length).toBeGreaterThan(0)
        for (const style of styles) expect(style).toEqual({ boxShadow: 'none', filter: 'none' })
      }
      await noShadows()
      await expect(row(page).getByTestId('creature')).toHaveCount(1)
      await page.getByTestId('active-view-table').click()
      await expect(page.getByTestId('active-table-working')).toBeVisible()
      await noShadows()
    })

    // The v4 HTML's chevron is a bare 14px icon against the row's 16px right padding.
    test('the chevron icon lines up with the row\'s right padding', async ({ page }) => {
      await openFrozenBoard(page)
      const headRight = await head(page).evaluate((el) => el.getBoundingClientRect().right)
      const iconRight = await row(page).getByTestId('parent-chevron').locator('svg').evaluate((el) => el.getBoundingClientRect().right)
      expect(Math.round(headRight - iconRight)).toBe(ROW_RIGHT_PADDING_PX)
    })

    test('a parent creature is 22x20 with two eyes', async ({ page }) => {
      await openFrozenBoard(page)
      const creature = row(page).getByTestId('creature')
      const box = await creature.boundingBox()
      expect([Math.round(box!.width), Math.round(box!.height)]).toEqual([22, 20])
      await expect(creature.getByTestId('creature-eye')).toHaveCount(2)
    })

    test('uses the surface tokens: the row is on --surface and hover moves it to --surface2', async ({ page }) => {
      await openFrozenBoard(page)
      const tokens = await page.evaluate(() => {
        const probe = document.createElement('div')
        const resolve = (name: string) => { probe.style.background = `var(${name})`; document.body.appendChild(probe); const value = getComputedStyle(probe).backgroundColor; probe.remove(); return value }
        return { surface: resolve('--surface'), surface2: resolve('--surface2'), border: resolve('--border') }
      })
      const rowStyle = await row(page).evaluate((el) => { const s = getComputedStyle(el); return { background: s.backgroundColor, radius: s.borderRadius, border: s.borderTopColor, width: s.borderTopWidth } })
      expect(rowStyle).toEqual({ background: tokens.surface, radius: '14px', border: tokens.border, width: '1px' })
      await head(page).hover({ position: { x: 300, y: 4 } })
      await expect.poll(() => head(page).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(tokens.surface2)
    })
  })
}

test.describe('Parent row truncation', () => {
  test.use({ colorScheme: 'light', viewport: DESKTOP })

  test('at 650px of content width a title shows at least 30 characters, and the project is cut before the title', async ({ page }) => {
    await openFrozenBoard(page)
    await pushSnapshot(page, { taskPatches: { [PARENT]: { title: MIN_LENGTH_TITLE, repo: LONG_PROJECT, milestones: MILESTONES_DONE } } })
    await row(page).evaluate((el, width) => { (el as HTMLElement).style.width = `${width}px` }, MOBILE_CONTENT_WIDTH_PX)
    const title = row(page).getByTestId('parent-title')
    const project = row(page).getByTestId('parent-project')
    expect(MIN_LENGTH_TITLE.length).toBeGreaterThanOrEqual(MIN_TITLE_CHARS)
    expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    expect(await widthOf(project)).toBeLessThan(await project.evaluate((el) => el.scrollWidth))
  })

  test('a title longer than the row is cut with an ellipsis and keeps the full text as its tooltip', async ({ page }) => {
    await openFrozenBoard(page)
    const longer = Array(TITLE_REPEATS_PAST_ROW_WIDTH).fill(MIN_LENGTH_TITLE).join(' ')
    await pushSnapshot(page, { taskPatches: { [PARENT]: { title: longer } } })
    const title = row(page).getByTestId('parent-title')
    await expect(title).toHaveAttribute('title', longer)
    expect(await title.evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === 'ellipsis')).toBe(true)
  })

  // The project gives up its width before the title loses a character: by the
  // time the title is cut, the project is (all but) gone.
  // The borderline case: the line is just wide enough for the whole title, so
  // the project must take every pixel of the squeeze and the title none.
  test('a title that only just fits keeps every character while the project gives way', async ({ page }) => {
    await openFrozenBoard(page)
    await pushSnapshot(page, { taskPatches: { [PARENT]: { title: MIN_LENGTH_TITLE, repo: LONG_PROJECT } } })
    const title = row(page).getByTestId('parent-title')
    await row(page).evaluate((el, slackPx) => {
      const line = el.querySelector<HTMLElement>('.parent-line')!
      const titleWidth = el.querySelector<HTMLElement>('[data-testid="parent-title"]')!.scrollWidth
      const rowWidth = el.getBoundingClientRect().width
      ;(el as HTMLElement).style.width = `${rowWidth - (line.clientWidth - (titleWidth + slackPx))}px`
    }, TITLE_SLACK_PX)
    expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    expect(await widthOf(row(page).getByTestId('parent-project'))).toBeLessThan(MAX_SQUEEZED_PROJECT_PX)
  })

  test('at phone width the row never overflows the page', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await openFrozenBoard(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  })
})

test.describe('Parent tasks outside the section', () => {
  test.use({ colorScheme: 'light', viewport: DESKTOP })

  test('a parent whose milestones have all merged leaves the Active tab', async ({ page }) => {
    await openFrozenBoard(page)
    await pushSnapshot(page, { taskPatches: { [PARENT]: { showsOnBoard: false, milestones: [milestone('M0', 1, 'done'), milestone('M1', 2, 'done')] } } })
    await expect(row(page)).toHaveCount(0)
  })

  test('a task with milestones that is still awaiting plan review stays a card in Needs you, not a parent row', async ({ page }) => {
    await openFrozenBoard(page)
    await pushSnapshot(page, { taskPatches: { [PARENT]: { stageHistory: [], status: 'waiting', attentionStatus: 'needs-you', waitingReason: 'plan ready for review' } } })
    await expect(row(page)).toHaveCount(0)
    await expect(page.locator(`[data-testid="active-group-needs"] [data-slug="${PARENT}"]`).first()).toBeVisible()
  })

  test('a plan-approved parent whose first wave has not started waits in the Backlog tab and joins the section once a milestone is dispatched', async ({ page }) => {
    await openFrozenBoard(page)
    const allQueued = [milestone('M0', 1, 'queued'), milestone('M1', 2, 'queued')]
    await pushSnapshot(page, { taskPatches: { [PARENT]: { milestones: allQueued } } })
    await expect(row(page)).toHaveCount(0)
    await expect(page.locator(`[data-testid="task-card"][data-slug="${PARENT}"]`)).toHaveCount(0)
    await page.getByTestId('tab-btn-backlog').click()
    const planned = page.locator(`[data-testid="backlog-planned-parent"][data-slug="${PARENT}"]`)
    await expect(planned).toBeVisible()
    await expect(planned.getByTestId('backlog-planned-parent-open')).toHaveAttribute('href', new RegExp(`/task/${PARENT}\\?stage=dev`))
    await pushSnapshot(page, { taskPatches: { [PARENT]: { milestones: [milestone('M0', 1, 'dispatched'), milestone('M1', 2, 'queued')] } } })
    await expect(planned).toHaveCount(0)
    await page.getByTestId('tab-btn-inprogress').click()
    await expect(row(page)).toBeVisible()
  })

  test('a board whose only tasks are parents still shows the section and no empty state', async ({ page }) => {
    await openFrozenBoard(page)
    await pushSnapshot(page, { onlySlugs: [PARENT, WORKING_PARENT], taskPatches: { [WORKING_PARENT]: { milestones: [milestone('M0', 1, 'dispatched')] } } })
    await expect(page.getByTestId('parent-row')).toHaveCount(2)
    await expect(page.getByTestId('board-empty-state')).toHaveCount(0)
  })
})
