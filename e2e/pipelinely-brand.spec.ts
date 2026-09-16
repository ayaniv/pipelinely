import { test, expect } from '@playwright/test'

// M0 of the pipelinely redesign, later re-aligned to the "Pipelinely
// Pipeline" Claude Design project: the design-token swap, the two-family
// type stack (Figtree + JetBrains Mono), and the user-visible rebrand from
// "Cockpit AI" to "pipelinely.cc".
//
// The token assertions below are the enforcement mechanism for
// tech-design.md's Decision 1 — the old names are DELETED, not aliased to
// the new ones. Asserting only that the new names resolve would pass just as
// happily on a half-migrated stylesheet that still carries both
// vocabularies, so each case pairs "the new name resolves" with "the old one
// no longer does".
//
// Fixture data lives in e2e/fixtures/tasks (see playwright.config.ts).

// prefers-color-scheme is pinned so the three-state theme system's "no
// explicit choice" branch is deterministic — without this, whether the page
// starts light or dark depends on what the machine running the suite
// reports, and the toggle cases below would flip in the opposite direction
// on a dark-mode CI box.
test.use({ colorScheme: 'light' })

// The exact --bg values from the "Pipelinely Pipeline" design, per theme.
// Asserting the resolved value (rather than "the background looks darkish")
// is what actually distinguishes "the dark palette landed" from "some dark
// palette landed".
const BG_LIGHT = '#f1f4f4'
const BG_DARK = '#151b1d'

test.describe('pipelinely rebrand', () => {
  test('the browser tab title and the header wordmark both read pipelinely.cc', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByTestId('header-wordmark')).toHaveText('pipelinely.cc')
    // The title carries a "(N) " prefix whenever tasks are waiting, which
    // the fixture set always has — hence the suffix match here, with the
    // full "(N) pipelinely.cc" shape pinned by the next case.
    await expect(page).toHaveTitle(/pipelinely\.cc$/)
  })

  test('a waiting-task count prefixes the title, and the brand name follows it', async ({ page }) => {
    await page.goto('/')

    // Regex rather than a hardcoded count: the number is the fixture set's
    // waiting-status total, which grows every time another feature adds a
    // fixture. What must hold is the shape and a non-zero count.
    const title = await page.title()
    expect(title).toMatch(/^\(\d+\) pipelinely\.cc$/)
    const waitingCount = Number(title.match(/^\((\d+)\)/)![1])
    expect(waitingCount).toBeGreaterThan(0)
  })

  test('the two design font families are all requested in one stylesheet link', async ({ page }) => {
    await page.goto('/')

    const hrefs = await page.locator('link[rel="stylesheet"]').evaluateAll(
      (links) => links.map((l) => (l as HTMLLinkElement).href)
    )
    const fontHref = hrefs.find((h) => h.includes('fonts.googleapis.com'))
    expect(fontHref).toBeTruthy()
    expect(fontHref).toContain('Figtree')
    expect(fontHref).toContain('JetBrains+Mono')
  })

  // Requesting the font isn't the same as using it — this closes that gap.
  // Every metric, label, slug, pill and timestamp is specified to use
  // JetBrains Mono (tech-design.md's Typography section).
  test('slug, pill and metric text actually render in JetBrains Mono, not just request it', async ({ page }) => {
    await page.goto('/')

    // Superseded: the card no longer shows the git branch (see
    // cockpit-ui-reconcile.spec.ts's "project and slug render in their own
    // row" case) — .card-slug-value is its mono replacement.
    const slugFont = await page.locator('.card[data-slug="dev-ready"] .card-slug-value')
      .evaluate((el) => getComputedStyle(el).fontFamily)
    expect(slugFont).toContain('JetBrains Mono')

    const pillFont = await page.locator('.card[data-slug="dev-ready"] .pill').first()
      .evaluate((el) => getComputedStyle(el).fontFamily)
    expect(pillFont).toContain('JetBrains Mono')

    // Superseded: M2 of the Claude Design v2 alignment removed the card's
    // inline TOK/COST metrics (see design-v2-active-board.spec.ts) — the
    // ctx percentage is the metric text that remains on the board card, and
    // board-metrics is the one fixture with a real one to check.
    const metricFont = await page.locator('.card[data-slug="board-metrics"]').getByTestId('ctx-value')
      .evaluate((el) => getComputedStyle(el).fontFamily)
    expect(metricFont).toContain('JetBrains Mono')
  })

  test('the design token vocabulary replaced the old one outright', async ({ page }) => {
    await page.goto('/')

    const tokens = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement)
      const read = (name: string) => style.getPropertyValue(name).trim()
      return {
        // A representative name from each new tier the design introduced:
        // panel surfaces, the third text level, an accent, and the
        // on-accent foreground.
        panel: read('--panel'),
        panel2: read('--panel2'),
        text3: read('--text3'),
        muted2: read('--muted2'),
        borderSoft: read('--border-soft'),
        am: read('--am'),
        bl: read('--bl'),
        sg: read('--sg'),
        rd: read('--rd'),
        gr: read('--gr'),
        onAccent: read('--on-accent'),
        // The Pipelinely Pipeline design's own exact token names (see its
        // README's Design Tokens table) — aliased onto the values above,
        // not a second copy (see the :root block's own comment).
        accent: read('--accent'),
        sage: read('--sage'),
        amber: read('--amber'),
        drift: read('--drift'),
        // Every old name, which must now resolve to nothing. "amber" is
        // deliberately NOT in this list any more — the current design
        // reintroduced it as one of its own real token names (above), so
        // it resolving to something is now correct, not a regression.
        cardBg: read('--card-bg'),
        borderSubtle: read('--border-subtle'),
        textPrimary: read('--text-primary'),
        textSecondary: read('--text-secondary'),
        textMuted: read('--text-muted'),
        cyan: read('--cyan'),
        green: read('--green'),
        purple: read('--purple'),
        blue: read('--blue'),
        red: read('--red'),
        focus: read('--focus'),
      }
    })

    for (const name of [
      'panel', 'panel2', 'text3', 'muted2', 'borderSoft',
      'am', 'bl', 'sg', 'rd', 'gr', 'onAccent',
      'accent', 'sage', 'amber', 'drift',
    ] as const) {
      expect(tokens[name], `new token ${name} should resolve`).not.toBe('')
    }

    for (const name of [
      'cardBg', 'borderSubtle', 'textPrimary', 'textSecondary', 'textMuted',
      'cyan', 'green', 'purple', 'blue', 'red', 'focus',
    ] as const) {
      expect(tokens[name], `old token ${name} should have been deleted`).toBe('')
    }
  })

  test('with no saved choice the page leaves data-theme unset and paints the light palette', async ({ page }) => {
    await page.goto('/')

    // A fresh Playwright context has empty localStorage, so this is the
    // "user has never touched the toggle" state: the media query governs
    // and nothing is stamped on the root element.
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/)
    const bg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    )
    expect(bg.toLowerCase()).toBe(BG_LIGHT)
  })

  test('toggling to dark repaints the dark palette and survives a reload', async ({ page }) => {
    await page.goto('/')
    await page.locator('#theme-toggle').click()

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    const darkBg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    )
    expect(darkBg.toLowerCase()).toBe(BG_DARK)

    await page.reload()

    // The head script applies the saved theme before first paint, so this
    // also covers "the rebrand did not break the no-flash path".
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    const afterReload = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    )
    expect(afterReload.toLowerCase()).toBe(BG_DARK)
  })

  // Failure path: a corrupt stored value must not stamp itself onto the
  // root element or leave the page unpainted — the head script's
  // light/dark allow-list is what protects this.
  test('a garbage saved theme value is ignored rather than applied', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await page.addInitScript(() => {
      try { localStorage.setItem('cockpit-theme', 'chartreuse') } catch { /* private mode */ }
    })
    await page.goto('/')

    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/)
    const bg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    )
    expect(bg.toLowerCase()).toBe(BG_LIGHT)
    expect(pageErrors).toEqual([])
  })
})
