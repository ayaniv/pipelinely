import { test, expect, type Page, type Route } from '@playwright/test'
import { TOKEN, DESKTOP, cssOf } from './fixtures/designTokens'
import { freezeLiveFeed, pushSnapshot } from './fixtures/liveBoard'

// dashboard-v3-update M3 — task creatures (REQUEST-v3-full.md §3; Pipelinely
// Dashboard v3.dc.html `dot` fixtures and the header creature markup). A
// creature is a permanent per-task identity {name, color, shape}, assigned
// once by the server and stored in the task's own CREATURE file. M3 commits a
// CREATURE file for every fixture task, so the server never writes into the
// checked-in fixture tree during an e2e run, and these cases read the
// assigned values back from /api/tasks rather than hardcoding them.

test.use({ colorScheme: 'light', viewport: DESKTOP })

interface Creature { name: string; color: string; shape: string }
interface ApiTask { slug: string; status: string; creature: Creature | null }

const card = (page: Page, slug: string) => page.locator(`[data-testid="task-card"][data-slug="${slug}"]`)
const EYE_INK = 'rgb(28, 36, 38)' // #1c2426
// An asymmetric 8-value border-radius: four horizontal radii / four vertical,
// each a whole percentage between 30 and 70.
const SHAPE_RE = /^(\d{2})% (\d{2})% (\d{2})% (\d{2})% \/ (\d{2})% (\d{2})% (\d{2})% (\d{2})%$/

async function apiTasks(page: Page): Promise<ApiTask[]> {
  const snapshot = (await page.request.get('/api/tasks').then((r) => r.json())) as { tasks: ApiTask[] }
  return snapshot.tasks
}

async function openFrozenBoard(page: Page) {
  await page.goto('/')
  await expect(page.getByTestId('task-card').first()).toBeVisible()
  await freezeLiveFeed(page)
}

function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}

function hueOf(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max === min) return 0
  const d = max - min
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}

test.describe('assignment', () => {
  // Done tasks are not backfilled (QUESTIONS.md #9), so only tasks that are
  // still in play are guaranteed one.
  test('every task not yet done carries a stored creature with a hex colour and a seeded 8-value shape', async ({ page }) => {
    const tasks = (await apiTasks(page)).filter((t) => t.status !== 'done')
    expect(tasks.length).toBeGreaterThan(0)
    for (const task of tasks) {
      expect(task.creature, task.slug).not.toBeNull()
      expect(task.creature!.name).toMatch(/^[A-Z][a-z]+$/)
      expect(task.creature!.color).toMatch(/^#[0-9a-f]{6}$/i)
      const match = task.creature!.shape.match(SHAPE_RE)
      expect(match, `${task.slug}: ${task.creature!.shape}`).not.toBeNull()
      for (const value of match!.slice(1).map(Number)) {
        expect(value).toBeGreaterThanOrEqual(30)
        expect(value).toBeLessThanOrEqual(70)
      }
    }
  })

  test('names are unique among active tasks', async ({ page }) => {
    const active = (await apiTasks(page)).filter((t) => t.status !== 'done')
    const names = active.map((t) => t.creature!.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test('the identity is stable: two reads and a reload return the same creature', async ({ page }) => {
    const first = await apiTasks(page)
    await page.goto('/')
    await page.reload()
    const second = await apiTasks(page)
    const bySlug = new Map(second.map((t) => [t.slug, t.creature]))
    for (const task of first.filter((t) => t.creature !== null)) expect(bySlug.get(task.slug), task.slug).toEqual(task.creature)
  })

  test('a subtask gets its own name and a lighter or darker shade of its parent\'s colour', async ({ page }) => {
    const tasks = await apiTasks(page)
    // fanout-parent-m0 is done and done tasks get no creature, so this uses
    // the one live milestone child in the fixture set.
    const parent = tasks.find((t) => t.slug === 'qa-spec-preview-parent')!.creature!
    const child = tasks.find((t) => t.slug === 'qa-spec-preview-parent-m0')!.creature!
    expect(child.name).not.toBe(parent.name)
    expect(child.color.toLowerCase()).not.toBe(parent.color.toLowerCase())
    const hueDrift = Math.abs(hueOf(child.color) - hueOf(parent.color))
    expect(Math.min(hueDrift, 360 - hueDrift)).toBeLessThanOrEqual(12)
  })
})

test.describe('card header', () => {
  test('a Needs you card leads with a 24px creature followed by its name', async ({ page }) => {
    await page.goto('/')
    const creature = (await apiTasks(page)).find((t) => t.slug === 'cr-fixes-ready')!.creature!
    const header = card(page, 'cr-fixes-ready').getByTestId('card-header')
    const body = header.getByTestId('creature')
    await expect(body).toBeVisible()
    await expect(body).toHaveAttribute('data-name', creature.name)
    // First item in the header, before the stage pill.
    const [bodyBox, pillBox] = await Promise.all([body.boundingBox(), header.getByTestId('card-status-pill').boundingBox()])
    expect(bodyBox!.x).toBeLessThan(pillBox!.x)
    expect(Math.round(bodyBox!.width)).toBe(24)
    expect(Math.round(bodyBox!.height)).toBe(24)

    const name = header.getByTestId('creature-name')
    await expect(name).toHaveText(creature.name)
    await expect(name).toHaveCSS('font-size', '12.5px')
    await expect(name).toHaveCSS('font-weight', '700')
    await expect(name).toHaveCSS('color', TOKEN.ink)
    await expect(body).toHaveAttribute('title', `${creature.name} is on this task`)
  })

  // The newer design handoff (CLAUDE_CODE_PROMPT_v3_full.md, lines 41 and 78)
  // shows the name on Working cards too, 12.5px 700 ink.
  test('a Working card shows the creature and its name as well as the tooltip', async ({ page }) => {
    await openFrozenBoard(page)
    await pushSnapshot(page, { taskPatches: { 'board-metrics': { status: 'working', attentionStatus: 'working' } } })
    const creature = (await apiTasks(page)).find((t) => t.slug === 'board-metrics')!.creature!
    const header = card(page, 'board-metrics').getByTestId('card-header')
    await expect(header.getByTestId('creature')).toHaveAttribute('title', `${creature.name} is on this task`)
    const name = header.getByTestId('creature-name')
    await expect(name).toHaveText(creature.name)
    await expect(name).toHaveCSS('font-size', '12.5px')
    await expect(name).toHaveCSS('font-weight', '700')
    await expect(name).toHaveCSS('color', TOKEN.ink)
  })

  test('the drawing is CSS only: colour body with the stored shape, a white visor and two dark eyes', async ({ page }) => {
    await page.goto('/')
    const creature = (await apiTasks(page)).find((t) => t.slug === 'cr-fixes-ready')!.creature!
    const body = card(page, 'cr-fixes-ready').getByTestId('creature')
    expect(await cssOf(body, 'background-color')).toBe(hexToRgb(creature.color))
    const [h1, h2, h3, h4] = creature.shape.split(' / ')[0].split(' ')
    expect(await cssOf(body, 'border-top-left-radius')).toContain(h1)
    expect(await cssOf(body, 'border-top-right-radius')).toContain(h2)
    expect(await cssOf(body, 'border-bottom-right-radius')).toContain(h3)
    expect(await cssOf(body, 'border-bottom-left-radius')).toContain(h4)
    // Flat since creature-eyes-animation-shadow: the v4 design drops the body's shadow.
    expect(await cssOf(body, 'box-shadow')).toBe('none')

    const visor = body.getByTestId('creature-visor')
    await expect(visor).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    const eyes = visor.getByTestId('creature-eye')
    await expect(eyes).toHaveCount(2)
    for (const eye of await eyes.all()) await expect(eye).toHaveCSS('background-color', EYE_INK)
    await expect(body.locator('img, svg')).toHaveCount(0)
  })

  test('changing a task\'s status or stage never changes its creature', async ({ page }) => {
    await openFrozenBoard(page)
    const before = await card(page, 'dev-ready').getByTestId('creature').getAttribute('data-name')
    await pushSnapshot(page, { taskPatches: { 'dev-ready': { status: 'working', attentionStatus: 'working', stage: 'qa' } } })
    await expect(card(page, 'dev-ready').getByTestId('creature')).toHaveAttribute('data-name', before!)
  })

  test('a task without a creature (unreadable CREATURE file) still renders its card, just without one', async ({ page }) => {
    await openFrozenBoard(page)
    await pushSnapshot(page, { taskPatches: { 'dev-ready': { creature: null } } })
    await expect(card(page, 'dev-ready').getByTestId('card-title')).toBeVisible()
    await expect(card(page, 'dev-ready').getByTestId('creature')).toHaveCount(0)
  })
})

test.describe('long names', () => {
  const LONG_NAMES = {
    'one unbroken word': 'Supercalifragilisticexpialidocious'.repeat(8),
    'many words': 'The Magnificent Wandering Creature of the Northern Reaches And Beyond'.repeat(1),
  }
  for (const width of [300, 420]) {
    for (const [label, name] of Object.entries(LONG_NAMES)) {
      test(`${label} stays inside the card at ${width}px, on Needs you and Working cards`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 })
        await openFrozenBoard(page)
        const creature = (await apiTasks(page)).find((t) => t.slug === 'dev-ready')!.creature!
        await pushSnapshot(page, { taskPatches: { 'dev-ready': { creature: { ...creature, name } }, 'board-metrics': { creature: { ...creature, name } } } })
        for (const slug of ['dev-ready', 'board-metrics']) {
          const cardBox = (await card(page, slug).boundingBox())!
          const nameBox = (await card(page, slug).getByTestId('creature-name').boundingBox())!
          expect(nameBox.x + nameBox.width, `${slug} name right edge`).toBeLessThanOrEqual(cardBox.x + cardBox.width)
          expect(nameBox.x, `${slug} name left edge`).toBeGreaterThanOrEqual(cardBox.x)
        }
      })
    }
  }
})

test.describe('creaturePlacement setting', () => {
  test('"off" hides every creature on the board', async ({ page }) => {
    await openFrozenBoard(page)
    await expect(page.getByTestId('creature').first()).toBeVisible()
    await pushSnapshot(page, { settings: { creaturePlacement: 'off' } })
    await expect(page.getByTestId('creature')).toHaveCount(0)
    await expect(page.getByTestId('creature-name')).toHaveCount(0)
  })

  test('the Settings page switch posts the new placement', async ({ page }) => {
    const bodies: unknown[] = []
    await page.route('**/settings', (route: Route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      bodies.push(route.request().postDataJSON())
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    })
    await page.goto('/settings')
    const toggle = page.getByTestId('settings-creatures-switch')
    await expect(toggle).toBeChecked()
    await toggle.click()
    await expect.poll(() => bodies).toEqual([{ creaturePlacement: 'off' }])
  })

  test('a failed write reverts the switch', async ({ page }) => {
    await page.route('**/settings', (route: Route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"disk full"}' })
        : route.fallback(),
    )
    await page.goto('/settings')
    const toggle = page.getByTestId('settings-creatures-switch')
    await toggle.click()
    await expect(toggle).toBeChecked()
  })
})
