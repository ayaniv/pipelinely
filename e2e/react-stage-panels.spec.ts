import { test, expect, type Page } from '@playwright/test'
import { openTask } from './fixtures/taskDetail.js'

// The task-detail PANEL slot — the L1 tab bar (fan-out parents), the
// plan/plan-review tab, and every L2 stage panel body (dev, cr, cr-fixes, qa,
// qa-fixes, merge: header, status pill, stage-scope block, findings/QA
// checklists, footer CTAs) — is React (web/src/views/task-detail/panel). The
// GRAPH slot (stage chain, stepper, wave grid, milestone cards) is covered
// elsewhere.
//
// This spec covers what the other panel specs have no reason to check:
//   - the panel really is React (no data-action buttons; in-place
//     reconciliation keeps a node and its focus across an SSE push that
//     changes the panel's content);
//   - the L1 tab bar and round counters, triage checkbox persistence, the CR
//     read-only recap, the QA case list / parse-mismatch warning /
//     planned-case preview, and the flat-task dev dispatch block;
//   - observability (a failed stage CTA, mark done, triage POST, tech-design
//     fetch each log a prefixed console.error) and the async-resource rules
//     (a slow response for task A can never surface under task B; an SSE push
//     refreshes the plan without flashing back to "Loading…").
// The other panel specs (design-v2-task-detail, detail-stages-redesign,
// plan-summary, plannotator-button, pipelinely-merge-gate, merge-tab-actions,
// stage-scope-summary, task-detail-url, design-v2-milestone-view) are not
// re-proved here.

const FLAT_SLUG = 'dev-ready'
const FANOUT_SLUG = 'fanout-parent'
const CR_FIXES_SLUG = 'cr-fixes-ready'
const QA_FIXES_SLUG = 'qa-fixes-ready'

const panelSlot = (page: Page) => page.getByTestId('detail-panel-slot')

// The Dev tab's milestone overview (showing / gone), targeted through the
// graph's own stable testid.
const milestoneGraph = (page: Page) => page.getByTestId('detail-graph-slot').getByTestId('milestone-flow')

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()) })
  return errors
}

function collectPageErrors(page: Page): Error[] {
  const errors: Error[] = []
  page.on('pageerror', (err) => errors.push(err))
  return errors
}

async function openStage(page: Page, slug: string, stage: string): Promise<void> {
  await page.goto(`/task/${slug}?stage=${stage}`)
  await expect(page.getByTestId('task-detail')).toBeVisible()
  await expect(panelSlot(page).getByTestId('l2-panel')).toBeVisible()
}

// Feeds the page a real SSE message through the same `es.onmessage` the bridge
// exposes (see react-task-detail.spec.ts), with an edit applied to the live
// /api/tasks payload — the only way to change task content mid-test without
// mutating a fixture file on disk.
async function pushEditedSnapshot(page: Page, edit: (snapshot: { tasks: Array<Record<string, any>> }) => void, copies = 1): Promise<void> {
  const snapshot = await page.evaluate(() => fetch('/api/tasks').then((r) => r.json()))
  edit(snapshot)
  // `copies` land in one tick, like a burst of file-watcher broadcasts.
  await page.evaluate(({ payload, count }) => {
    for (let i = 0; i < count; i++) window.es!.onmessage!(new MessageEvent('message', { data: JSON.stringify(payload) }))
  }, { payload: snapshot, count: copies })
}

// Lets React commit and paint whatever a just-settled response caused, so an
// absence assertion afterwards is not vacuously true.
async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

test.describe('react stage panels: ownership', () => {
  test('no panel button is a data-action button — every one is a React handler', async ({ page }) => {
    const pageErrors = collectPageErrors(page)
    await openTask(page, FLAT_SLUG)

    await expect(panelSlot(page).getByTestId('l2-cta')).toBeVisible()
    await expect(panelSlot(page).locator('[data-action]')).toHaveCount(0)
    expect(pageErrors, pageErrors.map(String).join('\n')).toEqual([])

    // Same guarantee on a panel with a checklist and secondary buttons.
    await openStage(page, CR_FIXES_SLUG, 'cr-fixes')
    await expect(panelSlot(page).locator('[data-action]')).toHaveCount(0)
  })

  test('an SSE push that changes a finding updates the row in place, keeping the same checkbox node and its focus', async ({ page }) => {
    await openStage(page, CR_FIXES_SLUG, 'cr-fixes')
    const checkbox = panelSlot(page).getByTestId('triage-checkbox').first()
    await checkbox.focus()
    await checkbox.evaluate((el) => { (el as HTMLElement & { probe?: string }).probe = 'same-node' })

    await pushEditedSnapshot(page, (snapshot) => {
      const task = snapshot.tasks.find((t) => t.slug === CR_FIXES_SLUG)!
      task.findings[0].description = 'reworded by a later review pass'
    })

    await expect(panelSlot(page).getByTestId('finding-row').first()).toContainText('reworded by a later review pass')
    const survivor = panelSlot(page).getByTestId('triage-checkbox').first()
    expect(await survivor.evaluate((el) => (el as HTMLElement & { probe?: string }).probe)).toBe('same-node')
    await expect(survivor).toBeFocused()
  })
})

test.describe('react stage panels: L1 tabs (fan-out parent)', () => {
  test('a parent already in Dev opens on the Dev tab with round counters on Plan and Plan Review, and the wave grid in the graph slot', async ({ page }) => {
    await openTask(page, FANOUT_SLUG)

    await expect(page.getByTestId('l1-tabs')).toBeVisible()
    await expect(page.getByTestId('l1-tab-dev')).toHaveClass(/is-active/)
    await expect(page.getByTestId('l1-tab-plan')).not.toHaveClass(/is-active/)
    await expect(page.getByTestId('l1-round-plan')).toHaveText('×1')
    await expect(page.getByTestId('l1-round-plan-review')).toHaveText('×1')
    await expect(page.getByTestId('l1-round-dev')).toHaveCount(0)
    await expect(milestoneGraph(page)).toBeVisible()
  })

  test('Plan and Plan Review show the same single document under their own panel header; Dev brings the wave grid back', async ({ page }) => {
    await openTask(page, FANOUT_SLUG)

    await page.getByTestId('l1-tab-plan').click()
    await expect(page.getByTestId('l1-tab-plan')).toHaveClass(/is-active/)
    await expect(page.getByTestId('l1-tab-dev')).not.toHaveClass(/is-active/)
    await expect(panelSlot(page).getByTestId('l2-panel-title')).toHaveText('Planning')
    await expect(panelSlot(page).getByTestId('tech-design-body')).toBeVisible()
    await expect(milestoneGraph(page)).toHaveCount(0)

    await page.getByTestId('l1-tab-plan-review').click()
    await expect(panelSlot(page).getByTestId('l2-panel-title')).toHaveText('Plan Review')
    await expect(panelSlot(page).getByTestId('plan-review-cta')).toBeVisible()
    await expect(panelSlot(page).getByTestId('tech-design-body')).toBeVisible()

    await page.getByTestId('l1-tab-dev').click()
    await expect(milestoneGraph(page)).toBeVisible()
    await expect(panelSlot(page).getByTestId('tech-design-body')).toHaveCount(0)
  })

  test('switching L1 tab leaves a milestone drill-down, and coming back to Dev starts at the milestone list', async ({ page }) => {
    await openTask(page, FANOUT_SLUG)
    await page.locator('[data-testid="milestone-card"][data-milestone-id="M0"] .card-title').click()
    await expect(panelSlot(page).getByTestId('l2-panel')).toBeVisible()

    await page.getByTestId('l1-tab-plan').click()
    await page.getByTestId('l1-tab-dev').click()

    await expect(milestoneGraph(page)).toBeVisible()
    await expect(panelSlot(page).getByTestId('l2-panel')).toHaveCount(0)
  })

  test('an L1 tab is a real button: Enter on the focused tab activates it', async ({ page }) => {
    await openTask(page, FANOUT_SLUG)
    await page.getByTestId('l1-tab-plan-review').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('l1-tab-plan-review')).toHaveClass(/is-active/)
    await expect(panelSlot(page).getByTestId('l2-panel-title')).toHaveText('Plan Review')
  })
})

test.describe('react stage panels: flat-task stage bodies', () => {
  test('the Dev tab of a flat task shows a dispatch block with only a verifier row (no milestone-only "needs" row)', async ({ page }) => {
    await openStage(page, FLAT_SLUG, 'dev')
    const block = panelSlot(page).getByTestId('milestone-dispatch')
    await expect(block).toBeVisible()
    await expect(block.getByTestId('milestone-dispatch-row')).toHaveCount(1)
  })

  test('the CR tab lists findings read-only, and "Select findings to fix" moves to the CR-fixes tab and into the URL', async ({ page }) => {
    await openStage(page, CR_FIXES_SLUG, 'cr')

    await expect(panelSlot(page).getByTestId('finding-row')).toHaveCount(1)
    await expect(panelSlot(page).getByTestId('triage-checkbox')).toHaveCount(0)

    await panelSlot(page).getByTestId('select-findings-btn').click()

    await expect(panelSlot(page).getByTestId('triage-checklist')).toBeVisible()
    await expect(panelSlot(page).getByTestId('l2-panel-title')).toHaveText('CR fixes')
    await expect(page).toHaveURL(/[?&]stage=cr-fixes\b/)
  })

  test('the QA tab lists every recorded case with its pass/fail state and a passing-count pill', async ({ page }) => {
    await openStage(page, 'qa-with-failures', 'qa')

    const rows = panelSlot(page).getByTestId('qa-case-row')
    const total = await rows.count()
    expect(total).toBeGreaterThan(1)
    const passed = await panelSlot(page).locator('[data-testid="qa-case-row"][data-passed="true"]').count()
    expect(passed).toBeLessThan(total)
    await expect(panelSlot(page).getByTestId('l2-panel-pill')).toHaveText(`${passed} of ${total} passing`)
  })

  test('a QA report whose declared count disagrees with its parsed bullets shows the parse-mismatch warning', async ({ page }) => {
    await openStage(page, 'qa-parse-mismatch', 'qa')
    await expect(panelSlot(page).getByTestId('qa-parse-mismatch-warning')).toBeVisible()
  })

  test('with no QA report yet, the QA tab previews the planned cases parsed from the declared spec, marked not-yet-run', async ({ page }) => {
    const specRequests: string[] = []
    page.on('request', (r) => { if (r.url().includes('/qa-spec/')) specRequests.push(r.url()) })

    await openStage(page, 'qa-spec-preview', 'qa')

    await expect(panelSlot(page).getByTestId('planned-qa-case-list')).toBeVisible()
    expect(await panelSlot(page).getByTestId('planned-qa-case-row').count()).toBeGreaterThan(0)
    await expect(panelSlot(page).getByTestId('qa-case-row')).toHaveCount(0)
    expect(specRequests).toHaveLength(1)
  })
})

test.describe('react stage panels: triage checklists persist their selection', () => {
  // cr-fixes-ready ships one finding, pre-selected in TRIAGE.json.
  test('unchecking and re-checking a CR finding POSTs the new selection to /triage and keeps the count and the Fix CTA in step', async ({ page }) => {
    const bodies: unknown[] = []
    await page.route('**/triage/**', async (route) => {
      bodies.push(route.request().postDataJSON())
      await route.fulfill({ status: 200, json: { ok: true } })
    })
    await openStage(page, CR_FIXES_SLUG, 'cr-fixes')
    const checkbox = panelSlot(page).getByTestId('triage-checkbox').first()
    const count = panelSlot(page).getByTestId('checklist-selected-count')
    const cta = panelSlot(page).getByTestId('l2-cta')

    await expect(checkbox).toBeChecked()
    await expect(count).toHaveText('1')
    await expect(cta).toHaveText(/Fix 1 CR Comment\b/)

    await checkbox.uncheck()
    await expect(count).toHaveText('0')
    await expect(cta).toBeDisabled()
    // Skip's whole point is being usable when nothing is selected.
    await expect(panelSlot(page).getByTestId('skip-cta')).toBeEnabled()
    await expect.poll(() => bodies.length).toBe(1)
    expect(bodies[0]).toEqual({ selected: [] })

    await checkbox.check()
    await expect(count).toHaveText('1')
    await expect.poll(() => bodies.length).toBe(2)
    expect(bodies[1]).toEqual({ selected: [0] })
  })

  // qa-fixes-ready ships two failing cases, both pre-selected in QA_TRIAGE.json.
  test('a QA failure checklist posts to /qa-triage, not /triage', async ({ page }) => {
    const requests: Array<{ url: string; body: unknown }> = []
    await page.route(/\/(qa-)?triage\//, async (route) => {
      requests.push({ url: route.request().url(), body: route.request().postDataJSON() })
      await route.fulfill({ status: 200, json: { ok: true } })
    })
    await openStage(page, QA_FIXES_SLUG, 'qa-fixes')
    await expect(panelSlot(page).getByTestId('triage-checklist')).toHaveAttribute('data-endpoint', 'qa-triage')

    await panelSlot(page).getByTestId('triage-checkbox').nth(1).uncheck()

    await expect.poll(() => requests.length).toBe(1)
    expect(requests[0].url).toContain(`/qa-triage/${QA_FIXES_SLUG}`)
    expect(requests[0].body).toEqual({ selected: [0] })
    await expect(panelSlot(page).getByTestId('checklist-selected-count')).toHaveText('1')
  })

  test('a failed triage POST is logged, and the checkbox falls back to the last selection the server confirmed', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page)
    await page.route('**/triage/**', (route) => route.abort('failed'))
    await openStage(page, CR_FIXES_SLUG, 'cr-fixes')
    const checkbox = panelSlot(page).getByTestId('triage-checkbox').first()
    await expect(checkbox).toBeChecked()

    // click(), not uncheck(): Playwright's uncheck asserts the state stuck,
    // and this box is meant to snap back.
    await checkbox.click()

    await expect.poll(() => consoleErrors.some((line) => line.startsWith('[triage]'))).toBe(true)
    await expect(checkbox).toBeChecked()
    await expect(panelSlot(page).getByTestId('checklist-selected-count')).toHaveText('1')
  })
})

test.describe('react stage panels: stage CTA', () => {
  test('the dev CTA POSTs the stage with the autoSubmit flag and is disabled while the request is in flight', async ({ page }) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const bodies: unknown[] = []
    await page.route(`**/stage-skill/${FLAT_SLUG}`, async (route) => {
      bodies.push(route.request().postDataJSON())
      await gate
      await route.fulfill({ status: 200, json: { submitted: false } })
    })
    await openTask(page, FLAT_SLUG)
    const cta = panelSlot(page).getByTestId('l2-cta')

    await cta.click()
    await expect(cta).toBeDisabled()
    await expect.poll(() => bodies.length).toBe(1)
    expect(bodies[0]).toEqual({ stage: 'dev', autoSubmit: false })

    release()
    await expect(cta).toBeEnabled()
    await expect(cta).toHaveClass(/btn-ok/)
    expect(bodies).toHaveLength(1)
  })

  test('a rejected stage CTA flashes the server\'s own message on the button and logs an [action] error', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page)
    await page.route(`**/stage-skill/${FLAT_SLUG}`, (route) => route.fulfill({ status: 503, json: { error: 'no session found' } }))
    await openTask(page, FLAT_SLUG)
    const cta = panelSlot(page).getByTestId('l2-cta')

    await cta.click()

    await expect(cta).toHaveClass(/btn-err/)
    await expect(cta).toContainText('no session found')
    await expect.poll(() => consoleErrors.some((line) => line.startsWith('[action]'))).toBe(true)
  })

  test('from a remote context with the toggle on, the panel CTA posts autoSubmit true', async ({ page }) => {
    await page.route('**/api/access', (route) => route.fulfill({ json: { isRemoteAccess: true } }))
    const bodies: Array<Record<string, unknown>> = []
    await page.route(`**/stage-skill/${FLAT_SLUG}`, async (route) => {
      bodies.push(route.request().postDataJSON())
      await route.fulfill({ status: 200, json: { submitted: true } })
    })
    await page.goto('/')
    const toggle = page.getByTestId('auto-submit-toggle')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await page.locator(`.card[data-slug="${FLAT_SLUG}"] .card-title`).click()

    await panelSlot(page).getByTestId('l2-cta').click()

    await expect.poll(() => bodies.length).toBe(1)
    expect(bodies[0]).toEqual({ stage: 'dev', autoSubmit: true })
  })

  test('a not-yet-ready stage renders its CTA disabled, and a click sends nothing', async ({ page }) => {
    const requests: string[] = []
    page.on('request', (r) => { if (r.url().includes('/stage-skill/')) requests.push(r.url()) })
    await openStage(page, 'planning-ready', 'plan-review')
    // planning-ready waits on "plan ready for review", so Plan Review is the
    // live one and Dev is not.
    await expect(panelSlot(page).getByTestId('plan-review-cta')).toBeEnabled()

    await page.goto('/task/planning-ready?stage=dev')
    const devCta = panelSlot(page).getByTestId('l2-cta')
    await expect(devCta).toBeDisabled()
    await devCta.click({ force: true })

    expect(requests).toEqual([])
  })
})

test.describe('react stage panels: merge tab actions', () => {
  const MERGE_SLUG = 'merge-ready'

  test('a second click on Merge while the request is still in flight sends no second request', async ({ page }) => {
    page.on('dialog', (d) => d.accept())
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const requests: string[] = []
    await page.route(`**/merge-pr/${MERGE_SLUG}`, async (route) => {
      requests.push(route.request().url())
      await gate
      await route.fulfill({ status: 409, json: { error: 'checks pending' } })
    })
    await openStage(page, MERGE_SLUG, 'merge')
    const btn = panelSlot(page).getByTestId('merge-pr-btn')

    await btn.click()
    await expect(btn).toBeDisabled()
    await btn.click({ force: true })
    release()

    await expect(panelSlot(page).getByTestId('merge-banner')).toBeVisible()
    expect(requests).toHaveLength(1)
  })

  test('Mark done from the Merge tab closes the detail view once the task is done', async ({ page }) => {
    page.on('dialog', (d) => d.accept())
    await page.route(`**/mark-done/${MERGE_SLUG}`, (route) => route.fulfill({ status: 200, json: {} }))
    await openStage(page, MERGE_SLUG, 'merge')

    await panelSlot(page).getByTestId('mark-done-btn').click()

    await expect(page.getByTestId('task-detail')).toHaveCount(0)
    await expect(page).toHaveURL(/\/$/)
  })

  test('a failed Mark done keeps the detail view open, flashes the failure on the button and logs an [action] error', async ({ page }) => {
    page.on('dialog', (d) => d.accept())
    const consoleErrors = collectConsoleErrors(page)
    await page.route(`**/mark-done/${MERGE_SLUG}`, (route) => route.abort('failed'))
    await openStage(page, MERGE_SLUG, 'merge')
    const btn = panelSlot(page).getByTestId('mark-done-btn')

    await btn.click()

    await expect(btn).toContainText('no server')
    await expect(page.getByTestId('task-detail')).toBeVisible()
    await expect.poll(() => consoleErrors.some((line) => line.startsWith('[action]'))).toBe(true)
  })
})

test.describe('react stage panels: async resources', () => {
  test('a tech-design fetch that fails is logged, and the Plan tab says there is no plan and disables Plannotator', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page)
    await page.route('**/tech-design/**', (route) => route.fulfill({ status: 500, body: 'boom' }))
    await openStage(page, FLAT_SLUG, 'planning')

    await expect(panelSlot(page).getByTestId('tech-design-empty')).toBeVisible()
    await expect(panelSlot(page).getByTestId('plannotator-btn')).toBeDisabled()
    await expect.poll(() => consoleErrors.some((line) => line.startsWith('[tech-design]'))).toBe(true)
  })

  // The acceptance rule from the plan: "a delayed response for task A cannot
  // appear under task B".
  test('a slow tech-design response for one task never surfaces under the next task opened', async ({ page }) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let staleRequested = false
    let markStaleHandled!: () => void
    const staleHandled = new Promise<void>((resolve) => { markStaleHandled = resolve })
    await page.route('**/tech-design/dev-ready', async (route) => {
      staleRequested = true
      await gate
      // fulfill rejects when the client already aborted the request, which
      // is the other acceptable outcome — either way the handler is done.
      await route.fulfill({
        status: 200,
        json: { html: '<h1 data-testid="stale-marker">from the slow task</h1>', summaryHtml: '', testGroups: [] },
      }).catch(() => {})
      markStaleHandled()
    })
    await openStage(page, FLAT_SLUG, 'planning')
    await expect(panelSlot(page).getByTestId('tech-design-loading')).toBeVisible()
    // The stale request was really sent and is being held, so the absence
    // check below cannot pass just because nothing was ever requested.
    expect(staleRequested).toBe(true)

    await page.getByTestId('detail-close').click()
    await page.locator('.card[data-slug="planning-ready"] .card-title').click()
    await page.getByTestId('stage-chain-planning').click()
    await expect(panelSlot(page).getByTestId('tech-design-body')).toBeVisible()

    release()
    await staleHandled
    await nextFrames(page)
    await expect(page.getByTestId('stale-marker')).toHaveCount(0)
    await expect(panelSlot(page).getByTestId('tech-design-body')).toBeVisible()
  })

  test('an SSE push refreshes the open plan once — coalescing a burst — without ever flashing back to "Loading…"', async ({ page }) => {
    const techDesignRequests: string[] = []
    page.on('request', (r) => { if (r.url().includes(`/tech-design/${FLAT_SLUG}`)) techDesignRequests.push(r.url()) })
    await openStage(page, FLAT_SLUG, 'planning')
    await expect(panelSlot(page).getByTestId('tech-design-body')).toBeVisible()
    const before = techDesignRequests.length

    await page.evaluate(() => {
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="tech-design-loading"]')) (window as unknown as { sawLoading?: boolean }).sawLoading = true
      }).observe(document.body, { childList: true, subtree: true })
    })
    await pushEditedSnapshot(page, () => {}, 3)

    await expect.poll(() => techDesignRequests.length).toBe(before + 1)
    await nextFrames(page)
    expect(techDesignRequests.length).toBe(before + 1)
    expect(await page.evaluate(() => (window as unknown as { sawLoading?: boolean }).sawLoading ?? false)).toBe(false)
    await expect(panelSlot(page).getByTestId('tech-design-body')).toBeVisible()
  })
})

test.describe('react stage panels: milestone drill-down panel', () => {
  // fanout-parent declares M0 (done, dispatched), M1 (needs M0), M2 (needs M1).
  // M1 has no child task yet.
  test('an undispatched milestone offers Start dev, and its later stages say it is not dispatched yet with no CTA', async ({ page }) => {
    const bodies: unknown[] = []
    await page.route('**/stage-skill/**', async (route) => {
      bodies.push({ url: route.request().url(), body: route.request().postDataJSON() })
      await route.fulfill({ status: 200, json: { submitted: false } })
    })
    await openTask(page, FANOUT_SLUG)
    await page.locator('[data-testid="milestone-card"][data-milestone-id="M1"]').click()

    const cta = panelSlot(page).getByTestId('l2-cta')
    await expect(cta).toBeEnabled()
    await expect(panelSlot(page).getByTestId('milestone-dispatch-row')).toHaveCount(2)
    await cta.click()
    await expect.poll(() => bodies.length).toBe(1)
    expect(bodies[0]).toEqual({ url: expect.stringContaining('/stage-skill/fanout-parent-m1'), body: { stage: 'dev', autoSubmit: false } })

    await page.getByTestId('stage-chain-cr').click()
    await expect(panelSlot(page).getByTestId('not-dispatched-note')).toBeVisible()
    await expect(panelSlot(page).getByTestId('detail-panel-footer')).toHaveCount(0)
  })
})

test.describe('react stage panels: skip', () => {
  const cases = [
    { slug: CR_FIXES_SLUG, tab: 'cr-fixes', stage: 'comment-fix' },
    { slug: QA_FIXES_SLUG, tab: 'qa-fixes', stage: 'qa-fixes' },
  ]

  for (const { slug, tab, stage } of cases) {
    test(`${tab}: Skip POSTs the stage to /skip-stage and flashes success`, async ({ page }) => {
      const bodies: unknown[] = []
      await page.route(`**/skip-stage/${slug}`, async (route) => {
        bodies.push(route.request().postDataJSON())
        await route.fulfill({ status: 200, json: {} })
      })
      await openStage(page, slug, tab)
      const skip = panelSlot(page).getByTestId('skip-cta')

      await skip.click()

      await expect(skip).toHaveClass(/btn-ok/)
      expect(bodies).toEqual([{ stage }])
    })

    test(`${tab}: a failed Skip flashes the failure on the button and logs an [action] error`, async ({ page }) => {
      const consoleErrors = collectConsoleErrors(page)
      await page.route(`**/skip-stage/${slug}`, (route) => route.fulfill({ status: 500, json: { error: 'boom' } }))
      await openStage(page, slug, tab)
      const skip = panelSlot(page).getByTestId('skip-cta')

      await skip.click()

      await expect(skip).toHaveClass(/btn-err/)
      await expect.poll(() => consoleErrors.some((line) => line.startsWith('[action]'))).toBe(true)
    })
  }
})

test.describe('react stage panels: fix CTAs', () => {
  test('the Fix N CR Comments CTA POSTs the comment-fix stage for the task', async ({ page }) => {
    const bodies: unknown[] = []
    await page.route(`**/stage-skill/${CR_FIXES_SLUG}`, async (route) => {
      bodies.push(route.request().postDataJSON())
      await route.fulfill({ status: 200, json: { submitted: false } })
    })
    await openStage(page, CR_FIXES_SLUG, 'cr-fixes')
    const cta = panelSlot(page).getByTestId('l2-cta')
    await expect(cta).toBeEnabled()

    await cta.click()

    await expect(cta).toHaveClass(/btn-ok/)
    expect(bodies).toEqual([{ stage: 'comment-fix', autoSubmit: false }])
  })

  test('the Fix N QA Comments CTA POSTs the qa-fixes stage for the task', async ({ page }) => {
    const bodies: unknown[] = []
    await page.route(`**/stage-skill/${QA_FIXES_SLUG}`, async (route) => {
      bodies.push(route.request().postDataJSON())
      await route.fulfill({ status: 200, json: { submitted: false } })
    })
    await openStage(page, QA_FIXES_SLUG, 'qa-fixes')
    const cta = panelSlot(page).getByTestId('l2-cta')
    await expect(cta).toBeEnabled()

    await cta.click()

    await expect(cta).toHaveClass(/btn-ok/)
    expect(bodies).toEqual([{ stage: 'qa-fixes', autoSubmit: false }])
  })
})

test.describe('react stage panels: secondary action failures', () => {
  test('a failed VS Code / Browse App click flashes the failure on that button and logs an [action] error', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page)
    await page.route(`**/vscode/${FLAT_SLUG}`, (route) => route.fulfill({ status: 500, json: {} }))
    await page.route(`**/browse/${FLAT_SLUG}`, (route) => route.abort('failed'))
    await openStage(page, FLAT_SLUG, 'dev')
    // The fixture has no worktree or dev URL, so give it both the way a live
    // task would arrive: through a snapshot.
    await pushEditedSnapshot(page, (snapshot) => {
      const task = snapshot.tasks.find((t) => t.slug === FLAT_SLUG)!
      task.worktree = '/tmp/fixture-worktree'
      task.devUrl = 'http://localhost:1'
    })
    const vscode = panelSlot(page).getByTestId('vscode-btn')
    const browse = panelSlot(page).getByTestId('browse-btn')

    await vscode.click()
    await expect(vscode).toHaveClass(/btn-err/)
    await expect(vscode).toContainText('failed')

    await browse.click()
    await expect(browse).toHaveClass(/btn-err/)
    await expect(browse).toContainText('no server')
    await expect.poll(() => consoleErrors.filter((line) => line.startsWith('[action]')).length).toBeGreaterThanOrEqual(2)
  })

  test('a failed Open PR click on the Merge tab flashes the failure and logs an [action] error', async ({ page }) => {
    const consoleErrors = collectConsoleErrors(page)
    await page.route('**/open-pr/merge-ready', (route) => route.fulfill({ status: 404, json: {} }))
    await openStage(page, 'merge-ready', 'merge')
    const btn = panelSlot(page).getByTestId('open-pr-btn')

    await btn.click()

    await expect(btn).toHaveClass(/btn-err/)
    await expect(btn).toContainText('not found')
    await expect.poll(() => consoleErrors.some((line) => line.startsWith('[action]'))).toBe(true)
  })
})

test.describe('react stage panels: successful merge', () => {
  const MERGE_SLUG = 'merge-ready'

  test('a clean merge closes the detail view', async ({ page }) => {
    page.on('dialog', (d) => d.accept())
    await page.route(`**/merge-pr/${MERGE_SLUG}`, (route) => route.fulfill({ status: 200, json: { prNumber: '7' } }))
    await openStage(page, MERGE_SLUG, 'merge')

    await panelSlot(page).getByTestId('merge-pr-btn').click()

    await expect(page.getByTestId('task-detail')).toHaveCount(0)
    await expect(page).toHaveURL(/\/$/)
  })

  test('a merge whose cleanup failed stays open with a warning banner listing each cleanup problem', async ({ page }) => {
    page.on('dialog', (d) => d.accept())
    await page.route(`**/merge-pr/${MERGE_SLUG}`, (route) => route.fulfill({
      status: 200,
      json: { prNumber: '7', cleanupError: "couldn't remove worktree; couldn't delete branch" },
    }))
    await openStage(page, MERGE_SLUG, 'merge')

    await panelSlot(page).getByTestId('merge-pr-btn').click()

    const banner = panelSlot(page).getByTestId('merge-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toHaveAttribute('data-tone', 'warning')
    await expect(banner.getByTestId('merge-banner-line')).toHaveCount(3)
    await expect(page.getByTestId('task-detail')).toBeVisible()
  })
})

test.describe('react stage panels: parse mismatch and stale stage', () => {
  test('a CR report whose declared counts disagree with its parsed bullets shows the parse-mismatch warning', async ({ page }) => {
    await openStage(page, CR_FIXES_SLUG, 'cr')
    await expect(panelSlot(page).getByTestId('cr-parse-mismatch-warning')).toHaveCount(0)

    await pushEditedSnapshot(page, (snapshot) => {
      snapshot.tasks.find((t) => t.slug === CR_FIXES_SLUG)!.findingsParseMismatch = ['Must Fix declared 3, parsed 1']
    })

    await expect(panelSlot(page).getByTestId('cr-parse-mismatch-warning')).toBeVisible()
  })

  // A milestone chain has no plan nodes, so a plan-stage ?stage= (stale or
  // hand-edited) must fall back to a milestone tab instead of the plan view.
  test('a stale plan ?stage= on a milestone child falls back to a milestone panel, not the plan', async ({ page }) => {
    const pageErrors = collectPageErrors(page)
    await page.goto('/task/fanout-parent-m0?stage=plan-review')

    await expect(panelSlot(page).getByTestId('l2-panel')).toBeVisible()
    await expect(panelSlot(page).getByTestId('tech-design-body')).toHaveCount(0)
    await expect(panelSlot(page).getByTestId('plan-review-cta')).toHaveCount(0)
    expect(pageErrors, pageErrors.map(String).join('\n')).toEqual([])
  })
})
