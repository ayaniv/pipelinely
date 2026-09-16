import { test, expect } from '@playwright/test'

// Covers the shareable task-detail URL: clicking a card pushes /task/<slug>,
// loading that URL directly opens straight into the detail view, and
// back/forward move naturally between the detail view and the list. Fixture
// data lives in e2e/fixtures/tasks/demo-task (see playwright.config.ts).
//
// The 'stage query param' block below covers the same URL, extended:
// clicking a stage pill in a task's 8-stage chain (e.g. "Plan Review")
// used to be pure client state (detailL2Tab) with no URL/history sync at
// all, so a refresh silently reverted to whichever stage the task
// currently defaults to, discarding the developer's explicit navigation
// into a past stage's own artifact. ?stage=<id> makes that selection
// survive a refresh the same way /task/<slug> already makes the task
// itself survive one.

test.describe('task detail URL', () => {
  test('clicking a task card pushes /task/<slug> and opens the detail view', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('task-detail')).toBeHidden()

    // Click on the title text, not the outer card div, so this can never
    // accidentally land on one of the card's own action buttons — those
    // open the overlay via a different, button-guarded branch of the same
    // click handler.
    await page.locator('[data-testid="task-card"][data-slug="demo-task"] .card-title').click()

    await expect(page).toHaveURL('/task/demo-task')
    await expect(page.getByTestId('task-detail')).toBeVisible()
    await expect(page.locator('#detail-title')).toHaveText('Demo task')
  })

  test('loading /task/<slug> directly opens straight into that detail view', async ({ page }) => {
    await page.goto('/task/demo-task')

    await expect(page.getByTestId('task-detail')).toBeVisible()
    await expect(page.locator('#detail-title')).toHaveText('Demo task')
  })

  test('browser back/forward navigate between the detail view and the list view', async ({ page }) => {
    await page.goto('/')
    await page.locator('[data-testid="task-card"][data-slug="demo-task"] .card-title').click()
    await expect(page.getByTestId('task-detail')).toBeVisible()

    await page.goBack()
    await expect(page).toHaveURL('/')
    await expect(page.getByTestId('task-detail')).toBeHidden()

    await page.goForward()
    await expect(page).toHaveURL('/task/demo-task')
    await expect(page.getByTestId('task-detail')).toBeVisible()
  })

  // Failure path: a stale or mistyped link must not crash the page — it
  // should just fall back to showing the list, the same way any other
  // not-found slug degrades (see openTaskDetail's `if (!task) return`).
  test('loading an unknown task slug falls back to the list view without erroring', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await page.goto('/task/does-not-exist')

    await expect(page.getByTestId('task-card').first()).toBeVisible()
    await expect(page.getByTestId('task-detail')).toBeHidden()
    expect(pageErrors).toEqual([])
  })

  // Failure path: a malformed percent-encoded slug (e.g. "%ZZ") must not
  // throw an uncaught URIError out of decodeURIComponent. A real navigation
  // to a malformed path 400s at the Express route layer before ever
  // reaching the client — confirmed directly: `curl /task/%ZZ` returns 400
  // from Express's own `:slug` param decoding, never our index.html — so
  // the realistic way this reaches the client is a browser back/forward
  // through a history entry, which fires popstate without a network
  // round trip. This drives that path directly via the History API.
  test('a malformed percent-encoded slug from browser navigation does not throw and falls back to the list view', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await page.goto('/')
    await page.locator('[data-testid="task-card"][data-slug="demo-task"] .card-title').click()
    await expect(page.getByTestId('task-detail')).toBeVisible()

    await page.evaluate(() => {
      history.pushState({}, '', '/task/%ZZ')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    await expect(page.getByTestId('task-detail')).toBeHidden()
    expect(pageErrors).toEqual([])
  })

  // A cold load of a task mid-pipeline (status: waiting/needs-you, stage:
  // qa, waiting on "triage and dispatch qa-fixes" — the shape a "Fix N QA
  // Comments" CTA link actually points at) — distinct from demo-task's
  // working/no-history shape above, and the one the reported bug used.
  // defaultL2Tab lands this on the qa-fixes tab, not qa itself: it prefers
  // computeNextStageCta's target stage over the task's raw (laggy) `stage`
  // field — see defaultL2Tab's own comment.
  test('loading /task/<slug> directly for a waiting/needs-you task at the QA stage opens straight onto its qa-fixes tab', async ({ page }) => {
    await page.goto('/task/qa-fixes-ready')

    await expect(page.getByTestId('task-detail')).toBeVisible()
    await expect(page.locator('[data-endpoint="qa-triage"]')).toBeVisible()
    await expect(page.getByTestId('l2-cta')).toBeEnabled()
  })

  // Root cause: renderDashboard's "keep an open overlay live as SSE updates
  // arrive" reconciliation (see index.html) trusted a single currentTasks
  // snapshot missing the open task as proof it was gone, and closed the
  // panel via closeTaskDetail's default push:true — resetting the URL to
  // '/'. Task directories are never deleted by this app's own routes, so in
  // practice every real firing of that branch was actually just the /events
  // broadcast racing a refreshTasks() triggered by some OTHER task's file
  // write (this dashboard watches dozens of concurrently active tasks) —
  // the /api/tasks response and the next SSE broadcast can momentarily
  // disagree even though the task never stopped existing. A cold
  // `/task/<slug>` load is exactly when this bites: the very first
  // post-open broadcast is the one most likely to still be in flight from
  // before the task existed in this session's view of currentTasks.
  //
  // Reproducing the real race (an actual concurrent file write elsewhere in
  // TASKS_DIR landing mid-load) would be flaky by nature, so this fakes
  // EventSource to script the exact sequence deterministically: a normal
  // first broadcast (task present, matching the real /api/tasks payload),
  // then a second broadcast whose task list is missing the just-opened
  // slug — a stale snapshot, not a real deletion.
  test('a transient SSE snapshot missing the just-opened task does not close the panel or reset the URL', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await page.addInitScript((slug) => {
      class FakeEventSource extends EventTarget {
        constructor(url: string) {
          super()
          fetch('/api/tasks').then(res => res.json()).then((initial) => {
            setTimeout(() => {
              this.onopen?.(new Event('open'))
              this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(initial) }))
              setTimeout(() => {
                const withoutTask = { ...initial, tasks: initial.tasks.filter((t: { slug: string }) => t.slug !== slug) }
                this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(withoutTask) }))
              }, 50)
            }, 10)
          })
        }
        onopen: ((ev: Event) => void) | null = null
        onmessage: ((ev: MessageEvent) => void) | null = null
        onerror: ((ev: Event) => void) | null = null
        close() {}
      }
      // @ts-expect-error — test-only stand-in, not a full EventSource
      window.EventSource = FakeEventSource
    }, 'qa-fixes-ready')

    await page.goto('/task/qa-fixes-ready')
    await expect(page.getByTestId('task-detail')).toBeVisible()

    // Let the scripted no-task broadcast above arrive and (pre-fix) close
    // the panel.
    await page.waitForTimeout(200)

    await expect(page).toHaveURL('/task/qa-fixes-ready')
    await expect(page.getByTestId('task-detail')).toBeVisible()
    expect(pageErrors).toEqual([])
  })
})

test.describe('stage query param', () => {
  // dev-ready (see pipeline-stage-cta.spec.ts's own fixtures) is a flat
  // task whose 5-node folded chain defaults to the Dev tab — clicking back
  // into the Planning node (which folds in Plan Review, its own most
  // recently reached sub-stage) is exactly the reported scenario: it shows
  // tech-design.md, not the tab a fresh open would land on.
  test('clicking a stage pill updates the URL, and reloading it stays on that stage', async ({ page }) => {
    await page.goto('/task/dev-ready')
    await expect(page).toHaveURL('/task/dev-ready') // no ?stage= yet — default tab

    await page.getByTestId('stage-chain-planning').click()
    await expect(page).toHaveURL('/task/dev-ready?stage=plan-review')
    await expect(page.getByTestId('tech-design-body')).toBeVisible()

    await page.reload()
    await expect(page).toHaveURL('/task/dev-ready?stage=plan-review')
    await expect(page.getByTestId('tech-design-body')).toBeVisible()
  })

  test('loading a /task/<slug>?stage=<id> URL directly opens straight onto that stage', async ({ page }) => {
    await page.goto('/task/dev-ready?stage=plan-review')
    await expect(page.getByTestId('tech-design-body')).toBeVisible()
    // The live "Start Dev" CTA (dev-ready's actual current stage) lives on
    // a different tab entirely — confirms this landed on Plan Review, not
    // the default.
    await expect(page.getByTestId('l2-cta')).toHaveCount(0)
  })

  // Failure path: a stale/hand-edited stage id must not crash the page —
  // matchStageParam validates against KNOWN_L2_TAB_IDS and falls back to
  // null (the existing "no stage picked yet" default) rather than handing
  // detailL2Tab a value none of renderL2Panel's branches recognize.
  test('an unknown ?stage= value does not throw and falls back to the default tab', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await page.goto('/task/dev-ready?stage=not-a-real-stage')

    await expect(page.getByTestId('task-detail')).toBeVisible()
    await expect(page.getByTestId('l2-cta')).toBeVisible() // back to the Dev-tab default
    expect(pageErrors).toEqual([])
  })

  test('drilling into a different milestone clears a stale stage param', async ({ page }) => {
    await page.goto('/task/fanout-parent?stage=qa')
    await page.getByTestId('l1-tab-dev').click()
    await page.locator('[data-testid="milestone-card"][data-milestone-id="M1"]').click()

    await expect(page).toHaveURL('/task/fanout-parent')
  })
})
