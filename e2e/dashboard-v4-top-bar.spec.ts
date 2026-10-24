import { test, expect, type Locator, type Page } from '@playwright/test'
import { DESKTOP, WIDE, cssOf } from './fixtures/designTokens'
import { alphaOf, resolvedColor } from './fixtures/flowGeometry'

// dashboard-v4-inner-view M0 — the sticky top bar (REQUEST-v4.md §1;
// Pipelinely Pipeline.dc.html's <header>: position:sticky; top:0;
// background color-mix(--bg 78%, transparent); backdrop-filter blur(10px);
// a faint bottom border; an inner 1180px column with the page's own gutters).
//
// The bar is the app's one shared <header> (AppFrame.tsx). It is sticky on the
// inner task view only (QUESTIONS.md default #3); the board keeps today's
// static header. Its contents (Back, spend, ctx, live, theme) are unchanged.

test.use({ colorScheme: 'light', viewport: DESKTOP })

const TASK = 'dev-ready'
const NARROW_760 = { width: 760, height: 900 }
// The design's bar background, verbatim; resolved in whichever theme is active.
const BAR_BACKGROUND = 'color-mix(in oklab, var(--bg) 78%, transparent)'
// Scrolled far enough that a non-sticky header would be off screen.
const SCROLL_PX = 900

const header = (page: Page) => page.getByTestId('app-header')
const headerInner = (page: Page) => page.getByTestId('app-header-inner')

async function openTaskPage(page: Page) {
  await page.goto(`/task/${TASK}`)
  await expect(page.getByTestId('task-detail')).toBeVisible()
}

// The content column's inner edges: the task view's page column minus its own
// horizontal padding, i.e. where the cards start and end.
async function contentEdges(page: Page): Promise<{ left: number; right: number }> {
  return page.getByTestId('task-detail').evaluate((el) => {
    const rect = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return { left: rect.left + parseFloat(style.paddingLeft), right: rect.right - parseFloat(style.paddingRight) }
  })
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error('element has no bounding box — is it rendered and visible?')
  return box
}

// Makes the page tall enough to scroll on any fixture task, so "stays at the
// top after scrolling" is never vacuously true on a short page.
async function padPageForScroll(page: Page) {
  await page.getByTestId('task-detail').evaluate((el, extra) => { (el as HTMLElement).style.paddingBottom = `${extra}px` }, SCROLL_PX * 2)
}

test.describe('sticky top bar', () => {
  test('on the task view the bar is sticky at the top of the viewport', async ({ page }) => {
    await openTaskPage(page)
    expect(await cssOf(header(page), 'position')).toBe('sticky')
    expect(await cssOf(header(page), 'top')).toBe('0px')
  })

  test('it stays pinned to the top, with Back clickable, after the page scrolls', async ({ page }) => {
    await openTaskPage(page)
    await padPageForScroll(page)
    await page.mouse.wheel(0, SCROLL_PX)
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(SCROLL_PX / 2)

    expect((await boxOf(header(page))).y).toBe(0)
    await expect(page.getByTestId('detail-close')).toBeInViewport()
    await page.getByTestId('detail-close').click()
    await expect(page.getByTestId('task-detail')).toHaveCount(0)
  })

  test('it spans the whole main area, so content scrolls under a full-width bar', async ({ page }) => {
    await openTaskPage(page)
    const main = await page.getByTestId('app-main').evaluate((el) => el.getBoundingClientRect().width)
    expect(Math.round((await boxOf(header(page))).width)).toBe(Math.round(main))
  })

  test('its background is the page --bg at about 78% opacity, with a 10px backdrop blur', async ({ page }) => {
    await openTaskPage(page)
    const background = await cssOf(header(page), 'background-color')
    expect(alphaOf(background)).toBeCloseTo(0.78, 2)
    expect(background).toBe(await resolvedColor(page, BAR_BACKGROUND))
    expect(await cssOf(header(page), 'backdrop-filter')).toBe('blur(10px)')
  })

  test('it has a faint 1px bottom border', async ({ page }) => {
    await openTaskPage(page)
    expect(await cssOf(header(page), 'border-bottom-width')).toBe('1px')
    expect(await cssOf(header(page), 'border-bottom-style')).toBe('solid')
    const borderAlpha = alphaOf(await cssOf(header(page), 'border-bottom-color'))
    expect(borderAlpha).toBeGreaterThan(0)
    expect(borderAlpha).toBeLessThan(1)
  })

  test('the inner row uses the content column\'s max-width and box-sizing', async ({ page }) => {
    await openTaskPage(page)
    const column = page.getByTestId('task-detail')
    expect(await cssOf(headerInner(page), 'max-width')).toBe(await cssOf(column, 'max-width'))
    expect(await cssOf(headerInner(page), 'box-sizing')).toBe(await cssOf(column, 'box-sizing'))
    expect(await cssOf(headerInner(page), 'padding-left')).toBe(await cssOf(column, 'padding-left'))
    expect(await cssOf(headerInner(page), 'padding-right')).toBe(await cssOf(column, 'padding-right'))
  })
})

test.describe('the bar lines up with the content column', () => {
  for (const viewport of [DESKTOP, WIDE]) {
    test(`at ${viewport.width}px Back's left edge meets the cards' left edge and theme's right edge meets their right edge`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await openTaskPage(page)
      const edges = await contentEdges(page)
      const back = await boxOf(page.getByTestId('detail-close'))
      const theme = await boxOf(page.getByTestId('theme-toggle'))
      expect(Math.abs(back.x - edges.left)).toBeLessThanOrEqual(1)
      expect(Math.abs(theme.x + theme.width - edges.right)).toBeLessThanOrEqual(1)
    })
  }

  test('at 760px the bar\'s contents stay inside the content column', async ({ page }) => {
    await page.setViewportSize(NARROW_760)
    await openTaskPage(page)
    const edges = await contentEdges(page)
    const inner = await headerInner(page).evaluate((el) => {
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return { left: rect.left + parseFloat(style.paddingLeft), right: rect.right - parseFloat(style.paddingRight) }
    })
    expect(Math.abs(inner.left - edges.left)).toBeLessThanOrEqual(1)
    expect(Math.abs(inner.right - edges.right)).toBeLessThanOrEqual(1)
  })
})

test.describe('dark mode', () => {
  test.use({ colorScheme: 'dark' })

  test('the bar\'s translucent background follows the dark --bg token, with no other change', async ({ page }) => {
    await openTaskPage(page)
    const background = await cssOf(header(page), 'background-color')
    expect(alphaOf(background)).toBeCloseTo(0.78, 2)
    // The same expression resolved against the dark theme's own --bg.
    expect(background).toBe(await resolvedColor(page, BAR_BACKGROUND))
  })
})

test.describe('scope: the board keeps its static header', () => {
  test('on the Active board the header is not sticky', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('board-column')).toBeVisible()
    expect(await cssOf(header(page), 'position')).not.toBe('sticky')
  })
})
