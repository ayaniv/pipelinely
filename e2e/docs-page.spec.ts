import { test, expect, type Page } from '@playwright/test'

// M0 — the dashboard's own Docs page: a third full page (/docs) next to
// Settings and Help, rendering docs/user-guide.md server-side through the
// same renderMarkdownToHtml the Plan tab already uses. See tech-design.md.
//
// Split the same way help-feedback.spec.ts splits its halves:
//   - this file proves what the dashboard SHOWS (the sidebar item, the page,
//     its URL, when it fetches, and what it does when the fetch fails).
//   - that GET /api/docs renders the guide file itself, 404s when it's
//     missing and 500s on a read error, is proved against the real handler in
//     src/server.docs.test.ts.
//
// Committed red with during planning (VERIFY runs
// `--grep-invert`); the dev stage removes the tag once green.
//
// Selectors are data-testid only; no assertion selects by visible copy — the
// guide's own prose is expected to change constantly, so nothing here may
// depend on a single word of it.

const DOCS_API = '**/api/docs'

// A guide small enough to assert exactly, in the shape the real route
// returns ({ html }), so the rendering cases don't depend on whatever
// docs/user-guide.md happens to say today.
const STUB_HTML = '<h1>Guide</h1><h2>Getting started</h2><p>Install it.</p><h2>Configuration</h2>'

function docsPage(page: Page) {
  return page.getByTestId('docs-page')
}

function docsBody(page: Page) {
  return page.getByTestId('docs-body')
}

async function stubDocs(page: Page, status: number, body?: unknown): Promise<void> {
  await page.route(DOCS_API, (route) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body ?? {}) }),
  )
}

// Counts every GET the page makes for the guide, so "fetched lazily" and
// "fetched once" are observable rather than assumed.
function recordDocsRequests(page: Page): string[] {
  const recorded: string[] = []
  page.on('request', (req) => {
    const { pathname } = new URL(req.url())
    if (pathname === '/api/docs') recorded.push(req.method())
  })
  return recorded
}

async function openDocsFromSidebar(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('sidebar-docs-btn').click()
  await expect(docsPage(page)).toBeVisible()
}

test.describe('sidebar Docs item', () => {
  test('is a real button, the same shape as the Settings and Help items beside it', async ({ page }) => {
    await page.goto('/')
    const btn = page.getByTestId('sidebar-docs-btn')

    await expect(btn).toBeVisible()
    expect(await btn.evaluate((el) => el.tagName)).toBe('BUTTON')
    await expect(btn).toHaveAttribute('type', 'button')
  })

  test('clicking it opens the Docs page at its own /docs URL and hides the board', async ({ page }) => {
    await stubDocs(page, 200, { html: STUB_HTML })
    await page.goto('/')
    await expect(docsPage(page)).toBeHidden()

    await page.getByTestId('sidebar-docs-btn').click()

    await expect(docsPage(page)).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/docs')
    await expect(page.getByTestId('board-column')).toBeHidden()
  })

  test('a cold load of /docs opens the page without a click', async ({ page }) => {
    await stubDocs(page, 200, { html: STUB_HTML })

    await page.goto('/docs')

    await expect(docsPage(page)).toBeVisible()
    await expect(page.getByTestId('board-column')).toBeHidden()
  })

  test('Docs, Help and Settings are mutually exclusive — opening one closes the others', async ({ page }) => {
    await stubDocs(page, 200, { html: STUB_HTML })
    await page.goto('/settings')
    await expect(page.getByTestId('settings-page')).toBeVisible()

    await page.getByTestId('sidebar-docs-btn').click()
    await expect(docsPage(page)).toBeVisible()
    await expect(page.getByTestId('settings-page')).toBeHidden()

    await page.getByTestId('sidebar-help-btn').click()
    await expect(page.getByTestId('help-page')).toBeVisible()
    await expect(docsPage(page)).toBeHidden()
  })

  test('a sidebar tab click leaves the Docs page and brings the board back', async ({ page }) => {
    await stubDocs(page, 200, { html: STUB_HTML })
    await openDocsFromSidebar(page)

    await page.getByTestId('tab-btn-backlog').click()

    await expect(docsPage(page)).toBeHidden()
    await expect(page.getByTestId('board-column')).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/backlog')
  })

  test('browser Back from /docs returns to the board', async ({ page }) => {
    await stubDocs(page, 200, { html: STUB_HTML })
    await openDocsFromSidebar(page)

    await page.goBack()

    await expect(docsPage(page)).toBeHidden()
    await expect(page.getByTestId('board-column')).toBeVisible()
  })
})

test.describe('Docs page — rendering the guide', () => {
  test('renders the HTML the route returns, as real elements rather than escaped text', async ({ page }) => {
    await stubDocs(page, 200, { html: STUB_HTML })
    await openDocsFromSidebar(page)

    await expect(docsBody(page).locator('h1')).toHaveCount(1)
    await expect(docsBody(page).locator('h2')).toHaveCount(2)
    await expect(page.getByTestId('docs-error')).toBeHidden()
  })

  test('renders the repo\'s real user guide, section for section', async ({ page, request }) => {
    // No stub: the one case that proves the page is wired to the actual
    // docs/user-guide.md rather than to whatever a test hands it. It counts
    // headings instead of reading copy, so editing the guide never breaks it.
    const response = await request.get('/api/docs')
    expect(response.status()).toBe(200)
    const { html } = (await response.json()) as { html: string }
    const sectionCount = (html.match(/<h2>/g) ?? []).length
    expect(sectionCount, 'the guide should have at least a few sections').toBeGreaterThan(2)

    await openDocsFromSidebar(page)

    await expect(docsBody(page).locator('h2')).toHaveCount(sectionCount)
  })

  test('the guide is fetched only when the page is opened, and only once', async ({ page }) => {
    const requests = recordDocsRequests(page)
    await stubDocs(page, 200, { html: STUB_HTML })

    await page.goto('/')
    await expect(page.getByTestId('board-column')).toBeVisible()
    expect(requests, 'the board must not pay for the guide').toEqual([])

    await page.getByTestId('sidebar-docs-btn').click()
    await expect(docsBody(page).locator('h1')).toHaveCount(1)
    expect(requests).toEqual(['GET'])

    // Leave and come back: the already-loaded guide is reused.
    await page.getByTestId('tab-btn-backlog').click()
    await expect(docsPage(page)).toBeHidden()
    await page.getByTestId('sidebar-docs-btn').click()
    await expect(docsPage(page)).toBeVisible()

    expect(requests).toEqual(['GET'])
  })

  test('a failed fetch shows an error instead of a blank page, and leaves the body empty', async ({ page }) => {
    await stubDocs(page, 500)

    await openDocsFromSidebar(page)

    await expect(page.getByTestId('docs-error')).toBeVisible()
    await expect(docsBody(page)).toBeEmpty()
  })

  test('a missing guide file (404) is reported the same visible way as any other failure', async ({ page }) => {
    await stubDocs(page, 404)

    await openDocsFromSidebar(page)

    await expect(page.getByTestId('docs-error')).toBeVisible()
    await expect(docsBody(page)).toBeEmpty()
  })

  test('a retry after a failure can still load the guide', async ({ page }) => {
    let attempt = 0
    await page.route(DOCS_API, (route) => {
      attempt += 1
      return attempt === 1
        ? route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
        : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ html: STUB_HTML }) })
    })

    await openDocsFromSidebar(page)
    await expect(page.getByTestId('docs-error')).toBeVisible()

    await page.getByTestId('tab-btn-backlog').click()
    await page.getByTestId('sidebar-docs-btn').click()

    await expect(docsBody(page).locator('h1')).toHaveCount(1)
    await expect(page.getByTestId('docs-error')).toBeHidden()
  })
})
