import { test, expect, type Page, type Request } from '@playwright/test'
import { gotoBoardTab } from './fixtures/boardTabs.js'
import { startCanonicalServer, stopCanonicalServer } from './fixtures/canonicalServer.js'

// Covers the dashboard half of "batch dispatch stages, never auto-submits".
//
// Incident this exists for (2026-09-06): clicking "Run wave" auto-submitted one
// real `/pipelinely-dev <slug>` per milestone straight into the developer's live,
// attended orchestrator session — N real dispatches, zero confirmation. The
// batch-backlog "Run selected (N)" toolbar had the identical shape. Both now
// stage ONE combined, unsent command via POST /batch-dispatch, which the
// developer reads and sends themselves.
//
// `ui` project on purpose: every assertion here is about what the dashboard
// SENDS, which a route mock answers exactly. Nothing here touches osascript —
// whether the staged text actually lands unsent in a real iTerm2 pane is the
// separate, VM-only e2e/integration/batch-dispatch-staging.spec.ts. Splitting
// them this way is what lets the regression that matters (no auto-submit) run
// in the local-safe suite at all.
//
// The `data-testid` selectors below are the existing ones (`wave-batch-btn`,
// `ms-dispatch-status`, `backlog-run-selected-btn`, `backlog-batch-bar`); no
// assertion selects by visible copy.

const PARENT = 'wave-batch-parent'

// wave-batch-parent's wave 2 holds M1 and M2, both `needs: M0` with M0 merged
// — the "two queued, unblocked milestones in one wave" shape this feature is
// for. See e2e/fixtures/tasks/wave-batch-parent/tech-design.md.
const WAVE = 2
const WAVE_SLUGS = [`${PARENT}-m1`, `${PARENT}-m2`]

// The wave-batch and backlog "Run selected" buttons this file clicks are
// both canonical-dispatch-gate's proactively-disabled CTAs (see index.html's
// renderMilestoneWaves/renderBacklog) — this suite's own shared webServer
// (playwright.config.ts) deliberately never sets COCKPIT_DISPATCH_ENABLED,
// so every test here runs its own dedicated, canonical instance of
// src/server.ts to see those buttons enabled at all. Every dispatch route is
// still stubbed via page.route below, so nothing real ever reaches
// writeToOrchestrator — this only needs the canonical instance for the
// client-side isCanonical read that drives the disabled attribute.
let canonicalUrl: string
test.beforeAll(async () => {
  canonicalUrl = await startCanonicalServer()
})
test.afterAll(async () => {
  await stopCanonicalServer(canonicalUrl)
})

async function openWaves(page: Page): Promise<void> {
  await page.goto(`${canonicalUrl}/`)
  await page.locator(`.card[data-slug="${PARENT}"] .card-title`).click()
  await expect(page.getByTestId('task-detail')).toBeVisible()
  await page.getByTestId('l1-tab-dev').click()
  await expect(page.getByTestId('wave').first()).toBeVisible()
}

function waveBatchBtn(page: Page) {
  return page.locator(`[data-testid="wave"][data-wave="${WAVE}"] [data-testid="wave-batch-btn"]`)
}

function msDispatchStatus(page: Page, milestoneId: string) {
  return page.locator(
    `[data-testid="milestone-card"][data-milestone-id="${milestoneId}"] [data-testid="ms-dispatch-status"]`,
  )
}

interface RecordedPosts {
  batch: unknown[]
  cockpitDevSlugs: string[]
  backlogDispatches: unknown[]
}

// Records every dispatch-shaped POST the page makes. `cockpitDevSlugs` and
// `backlogDispatches` exist to prove the NEGATIVE — that the deleted
// auto-submitting route is never called any more, and that the out-of-scope
// single-item route is only called by the single-item button.
function recordDispatchPosts(page: Page): RecordedPosts {
  const recorded: RecordedPosts = { batch: [], cockpitDevSlugs: [], backlogDispatches: [] }
  page.on('request', (req: Request) => {
    if (req.method() !== 'POST') return
    const url = req.url()
    if (url.includes('/batch-dispatch')) {
      recorded.batch.push(req.postDataJSON())
      return
    }
    const devMatch = url.match(/\/pipelinely-dev\/([^/?]+)/)
    if (devMatch) {
      recorded.cockpitDevSlugs.push(decodeURIComponent(devMatch[1]))
      return
    }
    if (url.includes('/backlog/dispatch')) recorded.backlogDispatches.push(req.postDataJSON())
  })
  return recorded
}

// Answers /batch-dispatch without ever reaching writeToOrchestrator, so this
// suite can assert the request shape and the rendered outcome for any server
// status without a real orchestrator session existing.
async function stubBatchDispatch(page: Page, status: number, body?: unknown): Promise<void> {
  await page.route('**/batch-dispatch', (route) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body ?? {}),
    }),
  )
}

test.describe('wave batch stages one combined command', () => {
  test('Run wave sends exactly one /batch-dispatch carrying every eligible milestone, and never /pipelinely-dev', async ({ page }) => {
    const posts = recordDispatchPosts(page)
    await stubBatchDispatch(page, 200)
    await openWaves(page)

    await waveBatchBtn(page).click()
    await expect.poll(() => posts.batch.length).toBe(1)

    // The whole point of the change: ONE request for the wave, not one per
    // milestone — and none of them to the auto-submitting route.
    expect(posts.batch[0]).toEqual({ kind: 'wave', slugs: WAVE_SLUGS })
    expect(posts.cockpitDevSlugs).toEqual([])
  })

  test('every milestone in the batch reports "staged", never "sent" — nothing has run yet', async ({ page }) => {
    await stubBatchDispatch(page, 200)
    await openWaves(page)

    await waveBatchBtn(page).click()

    for (const milestoneId of ['M1', 'M2']) {
      await expect(msDispatchStatus(page, milestoneId)).toHaveText('staged')
    }
  })

  test('a 503 from the server leaves the wave button usable again and says so on each card', async ({ page }) => {
    await stubBatchDispatch(page, 503, { error: 'Orchestrator not running — no ORCHESTRATOR_SESSION found' })
    await openWaves(page)

    await waveBatchBtn(page).click()

    await expect(msDispatchStatus(page, 'M1')).toHaveText('no orchestrator')
    // Re-enabled, not stranded disabled: a failed batch must be one click to
    // retry, matching the pre-existing per-item failure posture.
    await expect(waveBatchBtn(page)).toBeEnabled()
  })
})

test.describe('backlog batch stages one combined command', () => {
  // The fixture BACKLOG.md holds exactly four not-done items, in file order.
  // Checked by data-testid + index, never by their copy.
  async function openBacklogAndSelectAll(page: Page): Promise<void> {
    await gotoBoardTab(page, 'backlog', canonicalUrl)
    const checkboxes = page.getByTestId('backlog-select-checkbox')
    await expect(checkboxes.first()).toBeVisible()
    const count = await checkboxes.count()
    for (let i = 0; i < count; i++) await checkboxes.nth(i).check()
    await expect(page.getByTestId('backlog-batch-bar')).toHaveClass(/is-open/)
  }

  test('Run selected sends exactly one /batch-dispatch carrying every checked item', async ({ page }) => {
    const posts = recordDispatchPosts(page)
    await stubBatchDispatch(page, 200)
    await openBacklogAndSelectAll(page)

    await page.getByTestId('backlog-run-selected-btn').click()
    await expect.poll(() => posts.batch.length).toBe(1)

    const body = posts.batch[0] as { kind: string; items: { description: string }[] }
    expect(body.kind).toBe('backlog')
    expect(body.items.length).toBe(4)
    // Order is the backlog's own file order — the orchestrator numbers them in
    // the staged message, so a reordered batch would read wrong.
    // `backlog-row-title` is a testid this change adds to the existing
    // `.backlog-row-title` div (see tech-design.md's "Files touched") —
    // reading the rendered order from the DOM rather than hard-coding the
    // fixture's copy here.
    expect(body.items.map((i) => i.description)).toEqual(
      await page.getByTestId('backlog-row-title').allInnerTexts(),
    )
    // The single-item route belongs to the ▶ Play button alone now.
    expect(posts.backlogDispatches).toEqual([])
  })

  test('a failed batch keeps the selection intact so it is one click to retry', async ({ page }) => {
    await stubBatchDispatch(page, 503, { error: 'Orchestrator not running — no ORCHESTRATOR_SESSION found' })
    await openBacklogAndSelectAll(page)

    await page.getByTestId('backlog-run-selected-btn').click()

    await expect(page.getByTestId('backlog-batch-bar')).toHaveClass(/is-open/)
    await expect(page.getByTestId('backlog-selected-count')).toContainText('4')
    await expect(page.getByTestId('backlog-run-selected-btn')).toBeEnabled()
  })

  test('a successful batch clears the whole selection — the items went out together', async ({ page }) => {
    await stubBatchDispatch(page, 200)
    await openBacklogAndSelectAll(page)

    await page.getByTestId('backlog-run-selected-btn').click()

    await expect(page.getByTestId('backlog-batch-bar')).not.toHaveClass(/is-open/)
    await expect(page.locator('[data-testid="backlog-select-checkbox"]:checked')).toHaveCount(0)
  })
})

test.describe('the out-of-scope single-item path is untouched', () => {
  // Pinned deliberately: this task changes the BATCH paths only. A future
  // refactor that quietly routed the single ▶ Play button through
  // /batch-dispatch would change behaviour the task explicitly ring-fenced.
  test('the single-item Play button still posts to /backlog/dispatch, not /batch-dispatch', async ({ page }) => {
    const posts = recordDispatchPosts(page)
    await page.route('**/backlog/dispatch', (route) => route.fulfill({ status: 200, body: '' }))
    await gotoBoardTab(page, 'backlog', canonicalUrl)

    const playBtn = page.getByTestId('backlog-play-btn').first()
    await expect(playBtn).toBeVisible()
    await playBtn.click()

    await expect.poll(() => posts.backlogDispatches.length).toBe(1)
    expect(posts.batch).toEqual([])
  })
})
