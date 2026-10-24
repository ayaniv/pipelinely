import { test, expect, type Locator, type Page } from '@playwright/test'
import { DESKTOP } from './fixtures/designTokens'
import { freezeLiveFeed, pushSnapshot } from './fixtures/liveBoard'

// creature-eyes-animation-shadow — the task creature has two round eyes of
// one diameter, bobs while its task is working (still under reduced motion,
// still when not working), and is drawn flat: no shadow on the body, the
// visor or the eyes. Everything is read from computed styles and test ids.

test.use({ viewport: DESKTOP })

const NEEDS_SLUG = 'cr-fixes-ready'
const WORKING_SLUG = 'board-metrics'
const WORKING_PATCH = { [WORKING_SLUG]: { status: 'working', attentionStatus: 'working', stage: 'dev' } }
const VIEW_STORAGE_KEY = 'cockpit-active-view'

const card = (page: Page, slug: string) => page.locator(`[data-testid="task-card"][data-slug="${slug}"]`)
const row = (page: Page, slug: string) => page.locator(`[data-testid="table-row"][data-slug="${slug}"]`)
const detailCreature = (page: Page) => page.getByTestId('detail-creature').getByTestId('creature')

interface EyeGeometry { width: number; height: number; radius: number }

async function eyeGeometry(creature: Locator): Promise<EyeGeometry[]> {
  // evaluateAll does not wait: a row pushed by a snapshot may not be rendered yet.
  await expect(creature.getByTestId('creature-eye')).toHaveCount(2)
  return creature.getByTestId('creature-eye').evaluateAll((eyes) =>
    eyes.map((eye) => {
      const style = getComputedStyle(eye)
      return { width: parseFloat(style.width), height: parseFloat(style.height), radius: parseFloat(style.borderTopLeftRadius) }
    }),
  )
}

async function expectRoundEqualEyes(creature: Locator) {
  const eyes = await eyeGeometry(creature)
  expect(eyes).toHaveLength(2)
  for (const eye of eyes) {
    expect(eye.width).toBeGreaterThan(0)
    expect(eye.height).toBe(eye.width)
    expect(Number.isInteger(eye.width)).toBe(true)
    expect(eye.radius).toBeGreaterThanOrEqual(eye.width / 2)
  }
  expect(eyes[1]).toEqual(eyes[0])
}

async function runningAnimationCount(creature: Locator): Promise<number> {
  return creature.evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length)
}

async function expectFlat(creature: Locator) {
  const parts = [creature, creature.getByTestId('creature-visor'), ...(await creature.getByTestId('creature-eye').all())]
  for (const part of parts) {
    const style = await part.evaluate((el) => {
      const s = getComputedStyle(el)
      return { boxShadow: s.boxShadow, filter: s.filter, textShadow: s.textShadow }
    })
    expect(style.boxShadow).toBe('none')
    expect(style.filter).not.toContain('drop-shadow')
    expect(style.textShadow).toBe('none')
  }
}

async function openBoardWithWorkingTask(page: Page) {
  await page.goto('/')
  await expect(card(page, NEEDS_SLUG)).toBeVisible()
  await freezeLiveFeed(page)
  await pushSnapshot(page, { taskPatches: WORKING_PATCH })
  await expect(card(page, WORKING_SLUG).getByTestId('creature')).toBeVisible()
}

async function openDetail(page: Page, slug: string, taskPatches: Record<string, Record<string, unknown>> = {}) {
  await page.goto(`/task/${slug}`)
  await expect(detailCreature(page)).toBeVisible()
  await freezeLiveFeed(page)
  await pushSnapshot(page, { taskPatches })
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} mode`, () => {
    test.use({ colorScheme })

    test('card creatures have two round eyes of one diameter and no shadow', async ({ page }) => {
      await openBoardWithWorkingTask(page)
      for (const slug of [NEEDS_SLUG, WORKING_SLUG]) {
        const creature = card(page, slug).getByTestId('creature')
        await expectRoundEqualEyes(creature)
        await expectFlat(creature)
      }
    })

    test('the inner page header creature has two round eyes of one diameter and no shadow', async ({ page }) => {
      await openDetail(page, NEEDS_SLUG)
      await expectRoundEqualEyes(detailCreature(page))
      await expectFlat(detailCreature(page))
    })

    test('table row creatures have two round eyes of one diameter and no shadow', async ({ page }) => {
      await page.addInitScript((key) => localStorage.setItem(key, 'table'), VIEW_STORAGE_KEY)
      await page.goto('/')
      await expect(page.getByTestId('active-table-needs')).toBeVisible()
      await freezeLiveFeed(page)
      await pushSnapshot(page, { taskPatches: WORKING_PATCH })
      for (const slug of [NEEDS_SLUG, WORKING_SLUG]) {
        const creature = row(page, slug).getByTestId('creature')
        await expectRoundEqualEyes(creature)
        await expectFlat(creature)
      }
    })
  })
}

test.describe('working animation', () => {
  test('a Working card\'s creature animates; a Needs-you card\'s creature is still', async ({ page }) => {
    await openBoardWithWorkingTask(page)
    await expect.poll(() => runningAnimationCount(card(page, WORKING_SLUG).getByTestId('creature'))).toBeGreaterThan(0)
    expect(await runningAnimationCount(card(page, NEEDS_SLUG).getByTestId('creature'))).toBe(0)
  })

  test('the animation stops once the task stops working', async ({ page }) => {
    await openBoardWithWorkingTask(page)
    const creature = card(page, WORKING_SLUG).getByTestId('creature')
    await expect.poll(() => runningAnimationCount(creature)).toBeGreaterThan(0)
    await pushSnapshot(page, { taskPatches: { [WORKING_SLUG]: { status: 'working', attentionStatus: 'needs-you' } } })
    await expect.poll(() => runningAnimationCount(creature)).toBe(0)
  })

  test('the inner page header creature animates while working and is still otherwise', async ({ page }) => {
    await openDetail(page, WORKING_SLUG, WORKING_PATCH)
    await expect.poll(() => runningAnimationCount(detailCreature(page))).toBeGreaterThan(0)
    await pushSnapshot(page, { taskPatches: { [WORKING_SLUG]: { status: 'paused', attentionStatus: 'paused' } } })
    await expect.poll(() => runningAnimationCount(detailCreature(page))).toBe(0)
  })

  // offsetWidth/offsetHeight ignore transforms, so the layout is judged by what
  // the bob could push around: the creature's name and the card itself, sampled
  // across one full bob cycle (1.1s).
  test('the bob never moves the card layout: the name and card keep their boxes', async ({ page }) => {
    await openBoardWithWorkingTask(page)
    const workingCard = card(page, WORKING_SLUG)
    await expect.poll(() => runningAnimationCount(workingCard.getByTestId('creature'))).toBeGreaterThan(0)
    const boxes = await workingCard.evaluate(async (cardEl) => {
      const name = cardEl.querySelector('[data-testid="creature-name"]') as HTMLElement
      const samples: string[] = []
      for (let i = 0; i < 12; i++) {
        const nameBox = name.getBoundingClientRect()
        const cardBox = cardEl.getBoundingClientRect()
        samples.push(JSON.stringify([nameBox.x, nameBox.y, nameBox.width, nameBox.height, cardBox.width, cardBox.height]))
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return samples
    })
    expect(new Set(boxes).size).toBe(1)
  })

  // emulateMedia rather than test.use({ reducedMotion }): the context option
  // does not reach matchMedia under this config's ui project.
  test('a Working creature is still when the viewer prefers reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openBoardWithWorkingTask(page)
    const creature = card(page, WORKING_SLUG).getByTestId('creature')
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
    expect(await creature.evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
    expect(await runningAnimationCount(creature)).toBe(0)
  })
})
