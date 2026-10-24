import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { FIXTURE_BOOKMARKS_DIR } from './fixtures/fixtureDirs.js'

// Bookmarks M1 — the Bookmarks side-nav item and its /bookmarks page.
//
// The fixture server reads its bookmarks from FIXTURE_BOOKMARKS_DIR
// (playwright.config.ts sets PIPELINELY_BOOKMARKS_DIR to it). That directory is
// gitignored scratch — src/bookmarksPrivacy.test.ts proves it — and every test
// here empties and re-seeds it, so the tests share one directory and run
// in order on one worker. Every bookmark is invented; no real session or quote is used.
//
// "Open" on a session bookmark is honest about what the repo can do: it links
// to the task page (where the existing → Terminal / ↻ Resume button already
// handles a live or dead worker tab) when the task is still on this board,
// and otherwise says the task is gone and shows the session id. It never
// claims to resume a conversation. The fixture task `focus-dead-session`
// already exists in e2e/fixtures/tasks, so no new task is added to the board.
//
// Selectors are data-testid only.

const SESSION_ID = '0b5e2c1a-7d3f-4e8a-9c21-5f6a7b8c9d0e'
const ON_BOARD_SLUG = 'focus-dead-session'

interface SeedFields {
  id: string
  kind: 'text' | 'session'
  // Absent on purpose for the M0-era files, written before origin existed.
  origin?: 'answer' | 'quote'
  project?: string
  taskTitle?: string
  title: string
  text?: string | null
  note?: string
  tags?: string[]
  taskSlug?: string | null
  createdAt: string
}

const PARSER_QUOTE = 'Prefer one shared parser over two copies that drift.\n\n  - indented detail kept verbatim'

// Over the 260-character clamp threshold, with a line break to keep.
const LONG_ANSWER = `${'Split the invoice before it is finalised, one draft per workspace. '.repeat(5)}\n\nVoid the drafts if any one fails.`

const SEEDS: SeedFields[] = [
  { id: '20261004T000000Z-dddddd', kind: 'text', origin: 'answer', project: 'invented-repo', taskTitle: 'Invented task title', title: 'Shared parser', text: PARSER_QUOTE, note: 'style guide', tags: ['style'], taskSlug: ON_BOARD_SLUG, createdAt: '2026-10-04T00:00:00.000Z' },
  // An M0-era file: no origin, project or task title.
  { id: '20261003T000000Z-cccccc', kind: 'text', title: 'Quote the heredoc', text: "Use <<'EOF' so nothing expands.", tags: ['shell'], createdAt: '2026-10-03T00:00:00.000Z' },
  { id: '20261002T000000Z-bbbbbb', kind: 'session', project: 'invented-repo', taskTitle: 'Wrap the alpha', title: 'Where the gate went green', taskSlug: ON_BOARD_SLUG, tags: ['style', 'shell'], createdAt: '2026-10-02T00:00:00.000Z' },
  { id: '20261001T000000Z-aaaaaa', kind: 'session', title: 'A finished experiment', taskSlug: 'bookmarks-gone-task', tags: ['shell'], createdAt: '2026-10-01T00:00:00.000Z' },
]

async function resetBookmarks(seeds: SeedFields[] = []): Promise<void> {
  await fs.rm(FIXTURE_BOOKMARKS_DIR, { recursive: true, force: true })
  await fs.mkdir(FIXTURE_BOOKMARKS_DIR, { recursive: true })
  for (const seed of seeds) {
    const record = {
      version: 1,
      id: seed.id,
      kind: seed.kind,
      ...(seed.origin ? { origin: seed.origin } : {}),
      ...(seed.project ? { project: seed.project } : {}),
      ...(seed.taskTitle ? { taskTitle: seed.taskTitle } : {}),
      title: seed.title,
      text: seed.kind === 'text' ? seed.text : null,
      note: seed.note ?? '',
      tags: seed.tags ?? [],
      source: { taskSlug: seed.taskSlug ?? null, sessionId: SESSION_ID },
      createdAt: seed.createdAt,
    }
    await fs.writeFile(path.join(FIXTURE_BOOKMARKS_DIR, `${seed.id}.json`), JSON.stringify(record, null, 2))
  }
}

const item = (page: Page, id: string) => page.locator(`[data-testid="bookmark-item"][data-id="${id}"]`)

async function visibleIds(page: Page): Promise<string[]> {
  return page.getByTestId('bookmark-item').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-id') ?? ''))
}

async function openBookmarksPage(page: Page): Promise<void> {
  await page.goto('/bookmarks')
  await expect(page.getByTestId('bookmarks-page')).toBeVisible()
}

// In order on one worker (one shared fixture dir), but a failure doesn't skip
// the rest — each case reports on its own.
test.describe.configure({ mode: 'default' })

test.afterAll(async () => {
  await fs.rm(FIXTURE_BOOKMARKS_DIR, { recursive: true, force: true })
})

test.describe('the Bookmarks side-nav item', () => {
  test.beforeEach(() => resetBookmarks(SEEDS))

  test('sits in the sidebar and opens /bookmarks', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('sidebar-bookmarks-btn').click()

    await expect(page).toHaveURL(/\/bookmarks$/)
    await expect(page.getByTestId('bookmarks-page')).toBeVisible()
  })

  test('is the only highlighted item while /bookmarks shows, and lets go when you leave', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('sidebar-bookmarks-btn').click()

    await expect(page.getByTestId('sidebar-bookmarks-btn')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('sidebar-bookmarks-btn')).toHaveClass(/\bis-active\b/)
    for (const tab of ['inprogress', 'done', 'backlog']) {
      await expect(page.getByTestId(`tab-btn-${tab}`)).not.toHaveAttribute('aria-current', 'page')
    }

    await page.getByTestId('tab-btn-done').click()
    await expect(page.getByTestId('bookmarks-page')).toHaveCount(0)
    await expect(page.getByTestId('sidebar-bookmarks-btn')).not.toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('tab-btn-done')).toHaveAttribute('aria-current', 'page')
  })

  test('a cold load or shared link to /bookmarks lands on the page (server and client routes agree)', async ({ page }) => {
    await openBookmarksPage(page)
    await expect(page.getByTestId('sidebar-bookmarks-btn')).toHaveAttribute('aria-current', 'page')
  })

  test('shows how many bookmarks there are, in the nav item', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('sidebar-bookmarks-count')).toHaveText(String(SEEDS.length))
  })

  test('the board stays out of the way on the Bookmarks page: no focus band, toolbar or project filter', async ({ page }) => {
    await openBookmarksPage(page)

    await expect(page.getByTestId('board-column')).toBeHidden()
    await expect(page.getByTestId('weekly-focus-hero')).toBeHidden()
    await expect(page.getByTestId('summary-strip')).toBeHidden()
    await expect(page.getByTestId('filter-toggle-btn')).toBeHidden()
    await expect(page.getByTestId('board-filters')).toBeHidden()
  })

  test('collapsed sidebar: icon only, still named and still reachable', async ({ page }) => {
    await page.goto('/')
    await page.getByTestId('sidebar-collapse-toggle').click()
    await expect(page.getByTestId('app-sidebar')).toHaveClass(/\bis-collapsed\b/)

    const bookmarksBtn = page.getByTestId('sidebar-bookmarks-btn')
    await expect(bookmarksBtn).toBeVisible()
    await expect(bookmarksBtn).toHaveAttribute('aria-label', 'Bookmarks')
    await expect(page.getByTestId('sidebar-bookmarks-label')).toBeHidden()

    await bookmarksBtn.click()
    await expect(page.getByTestId('bookmarks-page')).toBeVisible()
  })
})

test.describe('the Bookmarks page', () => {
  test('empty state when nothing was saved yet, pointing at the skill', async ({ page }) => {
    await resetBookmarks([])
    await openBookmarksPage(page)

    await expect(page.getByTestId('bookmarks-empty')).toBeVisible()
    await expect(page.getByTestId('bookmarks-empty')).toContainText('/pipelinely-bookmark')
    await expect(page.getByTestId('bookmark-item')).toHaveCount(0)
    await expect(page.getByTestId('sidebar-bookmarks-count')).toHaveText('0')
  })

  test('the header says where bookmarks live and how to save one', async ({ page }) => {
    await resetBookmarks(SEEDS)
    await openBookmarksPage(page)

    await expect(page.getByTestId('bookmarks-path')).toHaveText('~/.config/pipelinely/bookmarks/')
    await expect(page.getByTestId('bookmarks-save-hint')).toContainText('/pipelinely-bookmark')
  })

  test('makes no request that leaves this machine', async ({ page, baseURL }) => {
    await resetBookmarks(SEEDS)
    const serverOrigin = new URL(baseURL ?? 'http://127.0.0.1').origin
    const foreignRequests: string[] = []
    page.on('request', (request) => {
      const { protocol, origin } = new URL(request.url())
      if ((protocol === 'http:' || protocol === 'https:') && origin !== serverOrigin) foreignRequests.push(request.url())
    })
    await openBookmarksPage(page)
    await expect(page.getByTestId('bookmark-item')).toHaveCount(SEEDS.length)

    expect(foreignRequests).toEqual([])
  })

  test.describe('with bookmarks', () => {
    test.beforeEach(() => resetBookmarks(SEEDS))

    test('lists every bookmark newest first, each marked with its kind', async ({ page }) => {
      await openBookmarksPage(page)

      expect(await visibleIds(page)).toEqual(SEEDS.map((seed) => seed.id))
      await expect(item(page, '20261004T000000Z-dddddd')).toHaveAttribute('data-kind', 'answer')
      await expect(item(page, '20261003T000000Z-cccccc')).toHaveAttribute('data-kind', 'quote')
      await expect(item(page, '20261002T000000Z-bbbbbb')).toHaveAttribute('data-kind', 'session')
    })

    test('a card names its task and project; without a snapshot it falls back to the slug', async ({ page }) => {
      await openBookmarksPage(page)

      const snapshotted = item(page, '20261004T000000Z-dddddd')
      await expect(snapshotted.getByTestId('bookmark-item-source')).toHaveText('Invented task title')
      await expect(snapshotted.getByTestId('bookmark-item-project')).toContainText('invented-repo')

      const oldFile = item(page, '20261001T000000Z-aaaaaa')
      await expect(oldFile.getByTestId('bookmark-item-source')).toHaveText('bookmarks-gone-task')
    })

    test('shows a text bookmark verbatim, whitespace kept', async ({ page }) => {
      await openBookmarksPage(page)
      const quote = item(page, '20261004T000000Z-dddddd').getByTestId('bookmark-item-text')
      expect(await quote.evaluate((node) => node.textContent)).toBe(PARSER_QUOTE)
    })

    test('a long answer is clamped, with Show all / Show less, and the text stays whole', async ({ page }) => {
      await resetBookmarks([{ id: '20261004T000000Z-dddddd', kind: 'text', origin: 'answer', title: 'Long', text: LONG_ANSWER, createdAt: '2026-10-04T00:00:00.000Z' }])
      await openBookmarksPage(page)
      const card = item(page, '20261004T000000Z-dddddd')
      const text = card.getByTestId('bookmark-item-text')

      await expect(text).toHaveAttribute('data-expanded', 'false')
      expect(await text.evaluate((node) => node.textContent)).toBe(LONG_ANSWER)
      await card.getByTestId('bookmark-item-toggle').click()
      await expect(text).toHaveAttribute('data-expanded', 'true')
      await card.getByTestId('bookmark-item-toggle').click()
      await expect(text).toHaveAttribute('data-expanded', 'false')
    })

    test('a short text has no Show all link', async ({ page }) => {
      await openBookmarksPage(page)
      await expect(item(page, '20261003T000000Z-cccccc').getByTestId('bookmark-item-toggle')).toHaveCount(0)
    })

    test('filters by kind: Answers, Quotes and Sessions', async ({ page }) => {
      await openBookmarksPage(page)

      await page.getByTestId('bookmarks-kind-filter-answer').click()
      expect(await visibleIds(page)).toEqual(['20261004T000000Z-dddddd'])

      await page.getByTestId('bookmarks-kind-filter-quote').click()
      expect(await visibleIds(page)).toEqual(['20261003T000000Z-cccccc'])

      await page.getByTestId('bookmarks-kind-filter-session').click()
      expect(await visibleIds(page)).toEqual(['20261002T000000Z-bbbbbb', '20261001T000000Z-aaaaaa'])

      await page.getByTestId('bookmarks-kind-filter-all').click()
      expect(await visibleIds(page)).toHaveLength(SEEDS.length)
    })

    test('filters by tag, across both kinds', async ({ page }) => {
      await openBookmarksPage(page)
      await page.locator('[data-testid="bookmarks-tag-filter"][data-tag="shell"]').click()
      expect(await visibleIds(page)).toEqual(['20261003T000000Z-cccccc', '20261002T000000Z-bbbbbb', '20261001T000000Z-aaaaaa'])
    })

    test('several tags narrow it: a bookmark needs every selected tag', async ({ page }) => {
      await openBookmarksPage(page)
      const tag = (name: string) => page.locator(`[data-testid="bookmarks-tag-filter"][data-tag="${name}"]`)

      await tag('shell').click()
      await tag('style').click()
      expect(await visibleIds(page)).toEqual(['20261002T000000Z-bbbbbb'])
      await expect(tag('shell')).toHaveAttribute('aria-pressed', 'true')
      await expect(tag('style')).toHaveAttribute('aria-pressed', 'true')

      await tag('style').click()
      await expect(tag('style')).toHaveAttribute('aria-pressed', 'false')
      expect(await visibleIds(page)).toHaveLength(3)
    })

    test('search, kind and tags combine', async ({ page }) => {
      await openBookmarksPage(page)

      await page.getByTestId('bookmarks-kind-filter-session').click()
      await page.locator('[data-testid="bookmarks-tag-filter"][data-tag="shell"]').click()
      await page.getByTestId('bookmarks-search').fill('experiment')
      expect(await visibleIds(page)).toEqual(['20261001T000000Z-aaaaaa'])

      await page.getByTestId('bookmarks-kind-filter-all').click()
      await page.getByTestId('bookmarks-search').fill('parser')
      await expect(page.getByTestId('bookmarks-no-matches')).toBeVisible()
    })

    test('search matches title, text, tags, task title, project and session id; no match shows its own state', async ({ page }) => {
      await openBookmarksPage(page)
      const search = page.getByTestId('bookmarks-search')

      await search.fill('copies that drift')
      expect(await visibleIds(page)).toEqual(['20261004T000000Z-dddddd'])

      await search.fill('INVENTED TASK')
      expect(await visibleIds(page)).toEqual(['20261004T000000Z-dddddd'])

      await search.fill('wrap the alpha')
      expect(await visibleIds(page)).toEqual(['20261002T000000Z-bbbbbb'])

      await search.fill(SESSION_ID.slice(0, 8))
      expect(await visibleIds(page)).toHaveLength(SEEDS.length)

      await search.fill('nothing-matches-this')
      await expect(page.getByTestId('bookmark-item')).toHaveCount(0)
      await expect(page.getByTestId('bookmarks-no-matches')).toBeVisible()
      await expect(page.getByTestId('bookmarks-empty')).toHaveCount(0)
    })

    test('copy puts the exact quote on the clipboard and says Copied', async ({ page }) => {
      await page.addInitScript(() => {
        const w = window as unknown as { __copied: string[] }
        w.__copied = []
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: (text: string) => { w.__copied.push(text); return Promise.resolve() } }, configurable: true })
      })
      await openBookmarksPage(page)
      const copy = item(page, '20261004T000000Z-dddddd').getByTestId('bookmark-item-copy')

      await copy.click()

      expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([PARSER_QUOTE])
      await expect(copy).toHaveAttribute('data-state', 'copied')
    })

    test('a session bookmark has no Copy', async ({ page }) => {
      await openBookmarksPage(page)
      await expect(item(page, '20261002T000000Z-bbbbbb').getByTestId('bookmark-item-copy')).toHaveCount(0)
    })

    test('a clipboard that refuses is reported on the item and logged', async ({ page }) => {
      const consoleErrors: string[] = []
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text())
      })
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true })
      })
      await openBookmarksPage(page)

      await item(page, '20261004T000000Z-dddddd').getByTestId('bookmark-item-copy').click()

      await expect(item(page, '20261004T000000Z-dddddd').getByTestId('bookmark-item-copy')).toHaveAttribute('data-state', 'failed')
      expect(consoleErrors.some((line) => line.startsWith('[action]'))).toBe(true)
    })

    // Delete removes the card at once and offers an undo for about five
    // seconds; the file is deleted only when that window closes.
    test('delete hides the card at once and keeps the file while the undo window is open', async ({ page }) => {
      await openBookmarksPage(page)

      await item(page, '20261003T000000Z-cccccc').getByTestId('bookmark-item-delete').click()

      await expect(item(page, '20261003T000000Z-cccccc')).toHaveCount(0)
      await expect(page.getByTestId('bookmark-undo-toast')).toBeVisible()
      await expect(fs.access(path.join(FIXTURE_BOOKMARKS_DIR, '20261003T000000Z-cccccc.json'))).resolves.toBeUndefined()
    })

    test('undo brings the card back and the file is never deleted', async ({ page }) => {
      await openBookmarksPage(page)

      await item(page, '20261003T000000Z-cccccc').getByTestId('bookmark-item-delete').click()
      await page.getByTestId('bookmark-undo-btn').click()

      await expect(item(page, '20261003T000000Z-cccccc')).toBeVisible()
      await expect(page.getByTestId('bookmark-undo-toast')).toHaveCount(0)
      // Past the window: a stray timer would have deleted it by now.
      await page.waitForTimeout(6000)
      await expect(fs.access(path.join(FIXTURE_BOOKMARKS_DIR, '20261003T000000Z-cccccc.json'))).resolves.toBeUndefined()
      expect(await visibleIds(page)).toHaveLength(SEEDS.length)
    })

    test('when the undo window closes the file is deleted and the toast goes', async ({ page }) => {
      await openBookmarksPage(page)

      await item(page, '20261003T000000Z-cccccc').getByTestId('bookmark-item-delete').click()

      await expect(page.getByTestId('bookmark-undo-toast')).toHaveCount(0, { timeout: 10_000 })
      await expect(async () => {
        await expect(fs.access(path.join(FIXTURE_BOOKMARKS_DIR, '20261003T000000Z-cccccc.json'))).rejects.toThrow()
      }).toPass({ timeout: 5000 })
      await expect(page.getByTestId('sidebar-bookmarks-count')).toHaveText(String(SEEDS.length - 1))
    })

    test('a delete the server refuses brings the card back and says so', async ({ page }) => {
      await page.route('**/api/bookmarks/*', (route) => (route.request().method() === 'DELETE' ? route.fulfill({ status: 500 }) : route.continue()))
      await openBookmarksPage(page)

      await item(page, '20261003T000000Z-cccccc').getByTestId('bookmark-item-delete').click()

      await expect(page.getByTestId('bookmark-delete-error')).toBeVisible({ timeout: 10_000 })
      await expect(item(page, '20261003T000000Z-cccccc')).toBeVisible()
      await expect(fs.access(path.join(FIXTURE_BOOKMARKS_DIR, '20261003T000000Z-cccccc.json'))).resolves.toBeUndefined()
    })

    test('a session bookmark whose task is on the board opens that task', async ({ page }) => {
      await openBookmarksPage(page)
      const session = item(page, '20261002T000000Z-bbbbbb')

      await expect(session.getByTestId('bookmark-item-task-gone')).toHaveCount(0)
      await session.getByTestId('bookmark-item-open-task').click()

      await expect(page).toHaveURL(new RegExp(`/task/${ON_BOARD_SLUG}$`))
      await expect(page.getByTestId('task-detail')).toBeVisible()
    })

    test('a session bookmark whose task is gone says so and shows the session id instead', async ({ page }) => {
      await openBookmarksPage(page)
      const session = item(page, '20261001T000000Z-aaaaaa')

      await expect(session.getByTestId('bookmark-item-open-task')).toHaveCount(0)
      await expect(session.getByTestId('bookmark-item-task-gone')).toBeVisible()
      await expect(session.getByTestId('bookmark-item-session-id')).toHaveAttribute('data-session-id', SESSION_ID)
    })

    test('360px wide: no sideways scrolling', async ({ page }) => {
      await page.setViewportSize({ width: 360, height: 800 })
      await resetBookmarks([...SEEDS, { id: '20261005T000000Z-eeeeee', kind: 'text', origin: 'answer', taskTitle: 'A very long task title '.repeat(6), title: 'Long', text: LONG_ANSWER, createdAt: '2026-10-05T00:00:00.000Z' }])
      await openBookmarksPage(page)

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow).toBeLessThanOrEqual(0)
    })
  })

  test('a corrupted file is reported, never hidden or deleted, and the rest still lists', async ({ page }) => {
    await resetBookmarks(SEEDS.slice(0, 1))
    const corruptPath = path.join(FIXTURE_BOOKMARKS_DIR, '20261005T000000Z-eeeeee.json')
    await fs.writeFile(corruptPath, '{"kind":')
    await openBookmarksPage(page)

    await expect(page.getByTestId('bookmarks-unreadable-notice')).toHaveAttribute('data-count', '1')
    expect(await visibleIds(page)).toEqual([SEEDS[0].id])
    expect(await fs.readFile(corruptPath, 'utf-8')).toBe('{"kind":')
  })

  test('bookmarks that fail to load show an error state, not an empty page', async ({ page }) => {
    await resetBookmarks(SEEDS)
    await page.route('**/api/bookmarks', (route) => route.fulfill({ status: 500 }))
    await openBookmarksPage(page)

    await expect(page.getByTestId('bookmarks-load-error')).toBeVisible()
    await expect(page.getByTestId('bookmarks-empty')).toHaveCount(0)
  })
})
