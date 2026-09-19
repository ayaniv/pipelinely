import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { gotoBoardTab, selectBoardTab } from './fixtures/boardTabs'
import { withFixtureLock } from './fixtures/fixtureLock'
import { removeTaskFile, writeTaskFile } from './fixtures/taskFiles'

// The You tab: a fourth board panel holding the GitHub-style work-density
// heatmap that until now rendered at the bottom of the Done section.
//
// Four things are under test here:
//
// 1. **The nav trigger is the sidebar's existing account row**, not a fourth
//    .tab-btn. `.sidebar-account` ("You", bottom of the rail) already existed
//    and already had `cursor: pointer` with nothing behind it; it becomes the
//    You tab's trigger. It deliberately carries NO count — You is not a list
//    of N things — so #tab-bar keeps exactly three counted .tab-btn children.
//
// 2. **The heatmap moves, Done goes back to being a plain list.** The chart
//    was never a Done-tab concern; it is a personal-history view. After this
//    change `.work-density` must be inside #you-section and absent from
//    #done-section.
//
// 3. **The cells become assertable.** The chart already computed the right
//    numbers, but expressed them only as a `title` string and a background
//    colour — neither of which a test may select on (this repo's convention
//    is data-testid, never text content, and a colour assertion would just
//    re-encode DENSITY_SHADES). Each cell gains
//    `data-testid="density-cell"` + `data-date` + `data-count` + `data-level`,
//    and the header total gains `data-testid="density-total"` + `data-count`.
//
// 4. **You shows just the chart, not the rest of the board's chrome.**
//    Caught live during QA: the focus hero, the toolbar (pulse chips +
//    filter/standup buttons) and the filter bar all stayed visible above
//    the heatmap the same as on Active/Backlog/Done. They're hidden on You
//    now (see switchTab's [data-active-tab] and the CSS on #weekly-focus/
//    .board-toolbar/#board-filters), which is also why the filter chip in
//    case 3's own project-filter test below now gets toggled from the Done
//    tab rather than from You — the toggle button that used to sit above
//    this panel isn't there to click anymore.
//
// The metric itself does NOT change: the chart stays sessions-started-per-day
// (`session.startedAt`, see sessionDensityByDay), which is why a task worked
// across several days spreads across the days it actually ran instead of
// piling onto its finish date. Nor does its filter behaviour: the board's
// project filter narrows Active/Backlog/Done but deliberately leaves the
// heatmap alone, since You is a whole-history view. Both are locked in below
// so neither drifts.
//
// Committed red with @pending during planning (VERIFY runs
// `--grep-invert @pending`); the dev stage removes the tag once green.

// ── seeding ────────────────────────────────────────────────────────────────
//
// Day cells key off `session.startedAt`, and the chart's window is a rolling
// 53 weeks ending today — so a checked-in absolute date would silently fall
// out of the grid one day and take these assertions with it. Every date here
// is therefore relative to today, and the METRICS files carrying them are
// written at runtime against the `you-density` fixture (a done task with no
// committed METRICS of its own) and removed afterwards.
//
// `METRICS-<id>.json` (non-numeric id) is the per-session shape that carries
// a real `startedAt`; `METRICS-<digits>.json` is the legacy handover snapshot
// that does not, which is what makes the fallback case below seedable.
const SLUG = 'you-density'

const BUSY_SESSIONS = 3      // three sessions on one day — the busiest real day in the window
const BUSY_DAYS_AGO = 2
const QUIET_DAYS_AGO = 9     // one session
const EMPTY_DAYS_AGO = 16    // no sessions at all

const BUSY_FILES = ['METRICS-you-busy-a.json', 'METRICS-you-busy-b.json', 'METRICS-you-busy-c.json']
const QUIET_FILE = 'METRICS-you-quiet.json'
const LEGACY_FILE = 'METRICS-7.json'          // digits only ⇒ parsed with startedAt: null
const UNPARSEABLE_FILE = 'METRICS-you-torn.json'

const SEEDED_FILES = [...BUSY_FILES, QUIET_FILE, LEGACY_FILE, UNPARSEABLE_FILE]

// Local calendar date N days before today, as the 'YYYY-MM-DD' key the cells
// are stamped with. Mirrors localDateKey in index.html/taskParser.ts — local,
// not UTC, because the chart buckets by the developer's own calendar day.
function dayKeyAgo(daysAgo: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - daysAgo)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Noon local keeps the ISO timestamp on the intended calendar day in every
// timezone the suite might run in — midnight would land on the day before in
// any positive-offset zone once serialised.
function startedAtAgo(daysAgo: number): string {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() - daysAgo)
  return d.toISOString()
}

// Zero tokens on purpose: you-density's completion day is its STATUS mtime,
// which puts it in the same Done date group as design-v2-done-priced, and
// that group's total-spend assertions (design-v2-backlog-done.spec.ts) must
// not move because this fixture exists.
function sessionSnapshot(startedAt: string | null): string {
  return JSON.stringify({
    contextPct: 20,
    inputTokens: 0,
    outputTokens: 0,
    model: { id: 'claude-sonnet-5', display_name: 'Sonnet 5' },
    ...(startedAt ? { startedAt } : {}),
    // Deliberately old, so `current` never resolves true and this done
    // fixture is never mistaken for a live session.
    updatedAt: startedAt ?? startedAtAgo(30),
  })
}

async function seedSessions(): Promise<void> {
  for (const file of BUSY_FILES) {
    await writeTaskFile(SLUG, file, sessionSnapshot(startedAtAgo(BUSY_DAYS_AGO)))
  }
  await writeTaskFile(SLUG, QUIET_FILE, sessionSnapshot(startedAtAgo(QUIET_DAYS_AGO)))
}

async function clearSeed(): Promise<void> {
  for (const file of SEEDED_FILES) await removeTaskFile(SLUG, file)
}

// The server reparses on a watched-file change and pushes over SSE, so the
// write and the render are not synchronous — poll the snapshot the page will
// be rendering from rather than racing it.
async function waitForSessionCount(request: APIRequestContext, expected: number): Promise<void> {
  await expect
    .poll(async () => {
      const { tasks } = await (await request.get('/api/tasks')).json()
      return tasks.find((t: { slug: string }) => t.slug === SLUG)?.sessions?.length ?? -1
    }, { timeout: 15_000 })
    .toBe(expected)
}

const cell = (page: Page, dateKey: string) =>
  page.locator(`[data-testid="density-cell"][data-date="${dateKey}"]`)

const countOf = async (page: Page, dateKey: string): Promise<number> =>
  Number(await cell(page, dateKey).getAttribute('data-count'))

const levelOf = async (page: Page, dateKey: string): Promise<number> =>
  Number(await cell(page, dateKey).getAttribute('data-level'))

const totalOf = async (page: Page): Promise<number> =>
  Number(await page.getByTestId('density-total').getAttribute('data-count'))

// ── the nav trigger ────────────────────────────────────────────────────────

test.describe('You tab navigation', () => {
  test('the sidebar account row is the You tab trigger and carries no count', async ({ page }) => {
    await page.goto('/')

    const you = page.getByTestId('sidebar-account')
    await expect(you).toBeVisible()
    await expect(you).toHaveAttribute('data-tab', 'you')

    // A real control, not a div with cursor:pointer — same call the Settings
    // row already made (button.sidebar-foot-item).
    expect(await you.evaluate((el) => el.tagName)).toBe('BUTTON')

    // You is not a list of N things, so it gets no counter — and the counted
    // tab bar stays exactly three buttons wide.
    await expect(page.locator('[data-testid="tab-count-you"]')).toHaveCount(0)
    await expect(page.locator('#tab-bar .tab-btn')).toHaveCount(3)
  })

  test('clicking You shows its panel and hides the other three', async ({ page }) => {
    await gotoBoardTab(page, 'you')

    await expect(page.getByTestId('you-section')).toBeVisible()
    await expect(page.getByTestId('active-sessions')).toBeHidden()
    await expect(page.getByTestId('backlog-section')).toBeHidden()
    await expect(page.getByTestId('done-section')).toBeHidden()
  })

  test('the You trigger takes the active-state class, and gives it back', async ({ page }) => {
    await gotoBoardTab(page, 'you')
    await expect(page.getByTestId('sidebar-account')).toHaveClass(/is-active/)
    await expect(page.getByTestId('tab-btn-done')).not.toHaveClass(/is-active/)

    await selectBoardTab(page, 'done')
    await expect(page.getByTestId('sidebar-account')).not.toHaveClass(/is-active/)
    await expect(page.getByTestId('tab-btn-done')).toHaveClass(/is-active/)
  })

  // Every other board tab is a real page with its own URL (see tabUrl /
  // matchTabFromPath and the /backlog, /done routes in server.ts). You is
  // one too, which means the server has to serve the shell at /you for a
  // cold load — a client-only tab would 404 on a shared link.
  test('/you is a real route that loads cold into the You panel', async ({ page }) => {
    const response = await page.goto('/you')

    expect(response?.status()).toBe(200)
    await expect(page.getByTestId('you-section')).toBeVisible()
    await expect(page.getByTestId('sidebar-account')).toHaveClass(/is-active/)
  })

  test('selecting You pushes /you, and Back returns to the previous tab', async ({ page }) => {
    await gotoBoardTab(page, 'done')
    await expect(page).toHaveURL(/\/done$/)

    await selectBoardTab(page, 'you')
    await expect(page).toHaveURL(/\/you$/)

    await page.goBack()
    await expect(page).toHaveURL(/\/done$/)
    await expect(page.getByTestId('done-section')).toBeVisible()
    await expect(page.getByTestId('you-section')).toBeHidden()
  })

  // The standup button is Done-only (`hidden = tab !== 'done'`); You must not
  // inherit it just by being another panel.
  test('the copy-standup button stays hidden on You', async ({ page }) => {
    await gotoBoardTab(page, 'you')
    await expect(page.getByTestId('standup-btn')).toBeHidden()
  })

  // Caught live during QA: You is meant to show just the chart, not the
  // rest of the board's shared chrome (the focus hero, the toolbar, the
  // filter bar) — see switchTab's [data-active-tab] and the CSS on
  // #weekly-focus/.board-toolbar/#board-filters.
  test('the board chrome is hidden on You, and comes back on Done', async ({ page }) => {
    await gotoBoardTab(page, 'done')
    await expect(page.locator('#weekly-focus')).toBeVisible()
    await expect(page.locator('.board-toolbar')).toBeVisible()

    await selectBoardTab(page, 'you')
    await expect(page.locator('#weekly-focus')).toBeHidden()
    await expect(page.locator('.board-toolbar')).toBeHidden()
    await expect(page.getByTestId('board-filters')).toBeHidden()

    await selectBoardTab(page, 'done')
    await expect(page.locator('#weekly-focus')).toBeVisible()
    await expect(page.locator('.board-toolbar')).toBeVisible()
  })

  // The fix hides #board-filters on You by CSS alone, without ever touching
  // its own `hidden` attribute (the only record filter-toggle-btn's handler
  // has of whether the bar is open) — so a bar left open elsewhere must
  // still be open on return, not reset by the trip through You.
  test('leaving the filter bar open survives a trip through You', async ({ page }) => {
    await gotoBoardTab(page, 'done')
    await page.getByTestId('filter-toggle-btn').click()
    await expect(page.getByTestId('board-filters')).toBeVisible()

    await selectBoardTab(page, 'you')
    await expect(page.getByTestId('board-filters')).toBeHidden()

    await selectBoardTab(page, 'done')
    await expect(page.getByTestId('board-filters')).toBeVisible()
  })
})

// ── the heatmap moved off Done ─────────────────────────────────────────────

test.describe('the heatmap lives on You, not Done', () => {
  test('the work-density card renders inside the You panel', async ({ page }) => {
    await gotoBoardTab(page, 'you')

    await expect(page.getByTestId('work-density')).toBeVisible()
    await expect(page.locator('[data-testid="you-section"] .work-density')).toHaveCount(1)
  })

  test('the Done panel is a plain list again, with no heatmap in it', async ({ page }) => {
    await gotoBoardTab(page, 'done')

    await expect(page.getByTestId('done-date-group').first()).toBeVisible()
    await expect(page.locator('[data-testid="done-section"] .work-density')).toHaveCount(0)
    await expect(page.locator('[data-testid="done-section"] [data-testid="work-density"]')).toHaveCount(0)
  })
})

// ── the cells reflect real data ────────────────────────────────────────────

test.describe('the heatmap reflects real completed-task data', () => {
  // you-density's METRICS files are shared mutable fixture state, so every
  // case that depends on them runs under one lock and in declaration order —
  // the seed is torn down once, at the end, rather than per case.
  test.describe.configure({ mode: 'serial' })

  let releaseLock: (() => void) | null = null
  let lockDone: Promise<void> | null = null

  test.beforeAll(async ({ request }) => {
    // withFixtureLock takes a callback, but this seed has to outlive a single
    // callback and span every case in the describe — so the callback parks on
    // a promise this hook holds the resolver for, and afterAll releases it.
    lockDone = withFixtureLock('you-density-metrics', async () => {
      await new Promise<void>((resolve) => { releaseLock = resolve })
    })
    await expect.poll(() => releaseLock !== null, { timeout: 30_000 }).toBe(true)

    await clearSeed()
    await seedSessions()
    await waitForSessionCount(request, BUSY_SESSIONS + 1)
  })

  test.afterAll(async () => {
    await clearSeed()
    releaseLock?.()
    await lockDone
  })

  test('a seeded day cell carries that day\'s exact session count', async ({ page }) => {
    await gotoBoardTab(page, 'you')

    expect(await countOf(page, dayKeyAgo(BUSY_DAYS_AGO))).toBe(BUSY_SESSIONS)
    expect(await countOf(page, dayKeyAgo(QUIET_DAYS_AGO))).toBe(1)
  })

  test('a day with no sessions is an explicit zero cell, not a gap', async ({ page }) => {
    await gotoBoardTab(page, 'you')

    await expect(cell(page, dayKeyAgo(EMPTY_DAYS_AGO))).toHaveCount(1)
    expect(await countOf(page, dayKeyAgo(EMPTY_DAYS_AGO))).toBe(0)
    expect(await levelOf(page, dayKeyAgo(EMPTY_DAYS_AGO))).toBe(0)
  })

  // densityLevel scales against the busiest day in the window rather than a
  // fixed absolute count, so the busiest seeded day must top out at 4 and a
  // lighter day must land strictly between "none" and "busiest". Asserted as
  // an ordering, not as three hardcoded numbers, because the ceiling depends
  // on the whole fixture set's real maximum.
  test('shading steps up with the count, topping out on the busiest day', async ({ page }) => {
    await gotoBoardTab(page, 'you')

    const busy = await levelOf(page, dayKeyAgo(BUSY_DAYS_AGO))
    const quiet = await levelOf(page, dayKeyAgo(QUIET_DAYS_AGO))
    const empty = await levelOf(page, dayKeyAgo(EMPTY_DAYS_AGO))

    expect(busy).toBe(4)
    expect(quiet).toBeGreaterThanOrEqual(1)
    expect(quiet).toBeLessThan(busy)
    expect(empty).toBe(0)
  })

  test('the header total equals the sum of every cell in the window', async ({ page }) => {
    await gotoBoardTab(page, 'you')

    const counts = await page
      .locator('[data-testid="density-cell"]')
      .evaluateAll((cells) => cells.map((el) => Number((el as HTMLElement).dataset.count)))

    // 53 weeks × 7 days — every day in the window has a cell, seeded or not.
    expect(counts).toHaveLength(53 * 7)
    expect(counts.reduce((sum, n) => sum + n, 0)).toBe(await totalOf(page))
    expect(await totalOf(page)).toBeGreaterThanOrEqual(BUSY_SESSIONS + 1)
  })

  // The board's project filter is documented as narrowing Active, Backlog and
  // Done. You is a whole-history view and deliberately opts out — asserted
  // because filterProjects is board-wide state a user can easily leave set
  // from another tab, so "does it still apply here?" is a real question
  // someone will answer the other way by accident. The toggle itself is set
  // from Done rather than You: the filter bar's own trigger is hidden on You
  // now (see "the board chrome is hidden on You" above), so there's nothing
  // to click here anymore.
  test('the project filter does not narrow the heatmap', async ({ page }) => {
    await gotoBoardTab(page, 'you')
    const before = await totalOf(page)
    const busyBefore = await countOf(page, dayKeyAgo(BUSY_DAYS_AGO))

    await selectBoardTab(page, 'done')
    await page.getByTestId('filter-toggle-btn').click()
    const chip = page.locator('[data-testid^="filter-chip-project-"]').first()
    await chip.click()
    await expect(chip).toHaveClass(/is-active/)

    await selectBoardTab(page, 'you')
    expect(await totalOf(page)).toBe(before)
    expect(await countOf(page, dayKeyAgo(BUSY_DAYS_AGO))).toBe(busyBefore)
  })

  // ── failure paths ────────────────────────────────────────────────────────

  // The documented fallback: a session with no startedAt (a legacy
  // METRICS-<digits>.json handover snapshot) is attributed to its own task's
  // completion day — the best real information available for it — rather than
  // being dropped. Asserted as a delta on the total, because that completion
  // day is a STATUS mtime shared with other fixtures and so has no
  // independently-known absolute count.
  test('a session with no startedAt still counts, on its task\'s completion day', async ({ page, request }) => {
    await gotoBoardTab(page, 'you')
    const before = await totalOf(page)

    await writeTaskFile(SLUG, LEGACY_FILE, sessionSnapshot(null))
    await waitForSessionCount(request, BUSY_SESSIONS + 2)

    await page.reload()
    await selectBoardTab(page, 'you')
    expect(await totalOf(page)).toBe(before + 1)

    await removeTaskFile(SLUG, LEGACY_FILE)
    await waitForSessionCount(request, BUSY_SESSIONS + 1)
  })

  // A METRICS file caught mid-write drops out of the history without taking
  // the chart with it (see parsePerSession's own comment). The chart must
  // still render and every other day's count must be untouched.
  test('an unparseable METRICS file leaves the chart standing', async ({ page, request }) => {
    await gotoBoardTab(page, 'you')
    const before = await totalOf(page)

    await writeTaskFile(SLUG, UNPARSEABLE_FILE, '{ "startedAt": "2026-0')
    // The torn file contributes no session, so the count the server settles
    // on is the same one it already had — poll it to give the reparse a
    // chance to land before asserting nothing changed.
    await waitForSessionCount(request, BUSY_SESSIONS + 1)

    await page.reload()
    await selectBoardTab(page, 'you')
    await expect(page.getByTestId('work-density')).toBeVisible()
    expect(await totalOf(page)).toBe(before)
    expect(await countOf(page, dayKeyAgo(BUSY_DAYS_AGO))).toBe(BUSY_SESSIONS)

    await removeTaskFile(SLUG, UNPARSEABLE_FILE)
  })
})
