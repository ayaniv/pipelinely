import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withOrchestratorSessionLock } from '../fixtures/orchestratorSessionLock.js'

// Covers the "next step" pipeline CTA this task adds: a task's detail view
// shows a live, real button for whichever /cockpit-<stage> skill comes next
// (derived from STATUS's waitingReason, not the possibly-stale computed
// `stage` — see tech-design.md's "Why waitingReason, not task.stage"),
// clicking it POSTs /stage-skill/:slug and stages that exact command into
// the right session (the orchestrator's own tab for most stages; the task's
// own tab for qa-fixes/comment-fix, which take no slug argument at all).
//
// What this suite can and can't prove: no real iTerm2 session ever matches
// a fixture's fake session id, so `stageInSession` always reports
// "not found" here — that IS real, correct, already-precedented behavior
// (see /backlog/dispatch's identical 503 path), and it's what a stale
// ORCHESTRATOR_SESSION/ITERM_SESSION genuinely does in production. What
// this suite verifies end-to-end is that the CLIENT computes the right
// target stage and slug and the SERVER attempts to stage the right text
// against the right session — not that a real terminal pane received
// keystrokes, which no black-box HTTP/browser test can observe. The exact
// composed text (e.g. "/pipelinely-qa-fixes" with no slug) is asserted by a
// vitest unit test against `composeStageCommand` instead — see
// tech-design.md's Testing section for why the split lands there.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TASKS_DIR = path.join(__dirname, '..', 'fixtures', 'tasks')
const ORCHESTRATOR_SESSION_PATH = path.join(TASKS_DIR, 'ORCHESTRATOR_SESSION')

async function withOrchestratorSession(fakeId: string | null, fn: () => Promise<void>) {
  await withOrchestratorSessionLock(async () => {
    if (fakeId === null) {
      await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
    } else {
      await fs.writeFile(ORCHESTRATOR_SESSION_PATH, fakeId)
    }
    try {
      await fn()
    } finally {
      await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
    }
  })
}

async function openTask(page, slug: string) {
  await page.goto('/')
  await page.locator(`.card[data-slug="${slug}"] .card-title`).click()
  await expect(page.getByTestId('task-detail')).toBeVisible()
}

test.describe('next-step CTA per stage — happy path', () => {
  // Each chain node runs its own skill, shown on itself (see
  // PLAN_TAB_OWN_CTA in public/index.html): Plan Review's own skill is
  // /pipelinely-plan-review, so "Start Plan Review" lives on the Plan Review
  // tab — not on Planning, which has no skill of its own to dispatch (a
  // task's card only exists once planning has already started).
  test('planning done: the Plan Review tab shows a live, enabled "Start Plan Review" CTA', async ({ page }) => {
    await openTask(page, 'planning-ready')
    // Plan Review folds into the Planning node — planning-ready's next CTA
    // is already plan-review, so clicking the grouped node routes there.
    await page.getByTestId('stage-chain-planning').click()
    const cta = page.getByTestId('plan-review-cta')
    await expect(cta).toBeVisible()
    await expect(cta).toBeEnabled()
  })

  // Planning itself is the one chain node with no CTA at all — nothing to
  // dispatch for a stage that's already running by the time a card exists.
  // Plan Review folds into the same Planning node in the stepper now, so
  // reaching the Planning sub-tab specifically (rather than the Plan Review
  // sub-tab the folded node's own click already routes to, above) goes
  // through the URL param — still a real, supported route (matchStageParam
  // is untouched), just no longer its own separate node to click.
  test('planning done: the Planning tab shows the plan but no CTA', async ({ page }) => {
    await page.goto('/task/planning-ready?stage=planning')
    await expect(page.getByTestId('tech-design-body')).toBeVisible()
    await expect(page.getByTestId('plan-review-cta')).toHaveCount(0)
  })

  // Regression test for the default-tab bug: opening a task's detail view
  // used to always land on the Dev tab (see renderL2Panel's old hardcoded
  // `detailL2Tab || 'dev'`), regardless of which stage the task was
  // actually at — so a task whose plan was ready for review opened onto an
  // empty/irrelevant Dev tab instead of the plan itself. No click here at
  // all, unlike the test above (which explicitly clicks a chain node and
  // would pass whether or not this default were fixed). Lands on the Plan
  // Review tab specifically, since that's where the live CTA now is.
  test('planning done: opening the task directly shows the plan and its CTA, with no click needed', async ({ page }) => {
    await openTask(page, 'planning-ready')
    await expect(page.getByTestId('tech-design-body')).toBeVisible()
    const cta = page.getByTestId('plan-review-cta')
    await expect(cta).toBeVisible()
    await expect(cta).toBeEnabled()
  })

  test('plan review done (flat task): the Dev tab shows a live, enabled "Start Dev" CTA', async ({ page }) => {
    await openTask(page, 'dev-ready')
    // detailL2Tab defaults to 'dev' on a fresh open — no extra click needed.
    const cta = page.getByTestId('l2-cta')
    await expect(cta).toBeVisible()
    await expect(cta).toBeEnabled()
  })

  // Plan Review's own CTA only lights up while the task is actually
  // waiting to enter plan-review (STATUS's "plan ready for review"). Once
  // plan-review has already happened and STATUS has moved on to "ready for
  // dev", clicking back into the Plan Review tab shows the same button
  // disabled, not a live "Start Dev" copy — that lives only on the Dev tab.
  test('plan review already done: the Plan Review tab shows a disabled "Start Plan Review" CTA, not a live "Start Dev"', async ({ page }) => {
    await openTask(page, 'dev-ready')
    await page.getByTestId('stage-chain-planning').click()
    const cta = page.getByTestId('plan-review-cta')
    await expect(cta).toBeVisible()
    await expect(cta).toBeDisabled()
    await expect(page.getByTestId('dev-cta')).toHaveCount(0)
  })

  test('dev done, PR open: the CR tab shows a live, enabled CTA', async ({ page }) => {
    await openTask(page, 'cr-ready')
    await page.getByTestId('stage-chain-cr').click()
    const cta = page.getByTestId('l2-cta')
    await expect(cta).toBeVisible()
    await expect(cta).toBeEnabled()
  })

  test('CR requested changes: the CR fixes tab shows a live "Fix 1 selected item" CTA', async ({ page }) => {
    await openTask(page, 'cr-fixes-ready')
    await page.getByTestId('stage-chain-cr').click()
    const cta = page.getByTestId('l2-cta')
    await expect(cta).toBeVisible()
    await expect(cta).toBeEnabled()
    await expect(cta).toContainText('1')
  })

  test('CR approved: the QA tab shows a live, enabled CTA', async ({ page }) => {
    await openTask(page, 'qa-ready')
    await page.getByTestId('stage-chain-qa').click()
    const cta = page.getByTestId('l2-cta')
    await expect(cta).toBeVisible()
    await expect(cta).toBeEnabled()
  })

  test('QA failed: the QA fixes tab shows a live "Fix 2 selected items" CTA', async ({ page }) => {
    await openTask(page, 'qa-fixes-ready')
    await page.getByTestId('stage-chain-qa').click()
    const cta = page.getByTestId('l2-cta')
    await expect(cta).toBeVisible()
    await expect(cta).toBeEnabled()
    await expect(cta).toContainText('2')
  })
})

test.describe('next-step CTA — must not misfire mid-stage', () => {
  // Regression case: dev asking an unrelated clarifying question mid-
  // implementation leaves STATUS at "waiting: <reason>" while TIMELINE's
  // last entry is still 'plan-review' (dev only appends its own TIMELINE
  // line once the PR opens — see computeStage's staleness note). A CTA
  // keyed off task.stage alone would misread this as "plan review just
  // finished, ready for dev" and re-offer a CTA that would double-dispatch
  // a dev session that's already running.
  test('dev mid-implementation, waiting on an unrelated question: the Dev tab CTA stays disabled', async ({ page }) => {
    await openTask(page, 'dev-not-ready')
    const cta = page.getByTestId('l2-cta')
    await expect(cta).toBeVisible()
    await expect(cta).toBeDisabled()
  })
})

test.describe('next-step CTA — nothing left to stage once QA passes', () => {
  test('QA passed, ready to merge: the QA tab CTA is disabled (merge is never staged)', async ({ page }) => {
    await openTask(page, 'merge-ready')
    await page.getByTestId('stage-chain-qa').click()
    const cta = page.getByTestId('l2-cta')
    await expect(cta).toBeVisible()
    await expect(cta).toBeDisabled()
  })
})

test.describe('next-step CTA — nothing selected to fix', () => {
  test('QA failed but nothing checked: the Fix CTA renders disabled rather than staging an empty fix', async ({ page }) => {
    await openTask(page, 'qa-fixes-none-selected')
    await page.getByTestId('stage-chain-qa').click()
    const cta = page.getByTestId('l2-cta')
    await expect(cta).toBeVisible()
    await expect(cta).toBeDisabled()
  })
})

test.describe('clicking the CTA stages the right stage + slug', () => {
  test('a flat task stages against its own slug, targeting the orchestrator', async ({ page }) => {
    await withOrchestratorSession('fake-orchestrator-session', async () => {
      await openTask(page, 'dev-ready')
      const cta = page.getByTestId('l2-cta')

      const [request] = await Promise.all([
        page.waitForRequest((req) => req.url().includes('/stage-skill/dev-ready') && req.method() === 'POST'),
        cta.click(),
      ])
      expect(request.postDataJSON()).toEqual({ stage: 'dev' })

      // The fixture's ORCHESTRATOR_SESSION id never matches a real iTerm2
      // session, so staging genuinely fails — the button must show that
      // honestly (see the file header) rather than a false "✓ sent".
      await expect(cta).toHaveClass(/btn-err/)
    })
  })

  test('a milestone child stages against "<parent>-m<N>", not the parent\'s own slug', async ({ page }) => {
    await withOrchestratorSession('fake-orchestrator-session', async () => {
      await openTask(page, 'fanout-parent')
      await page.getByTestId('l1-tab-dev').click()
      await page.locator('[data-testid="milestone-card"][data-milestone-id="M1"]').click()

      const cta = page.getByTestId('l2-cta')
      await expect(cta).toBeEnabled()

      const [request] = await Promise.all([
        page.waitForRequest((req) => req.url().includes('/stage-skill/fanout-parent-m1') && req.method() === 'POST'),
        cta.click(),
      ])
      expect(request.postDataJSON()).toEqual({ stage: 'dev' })
    })
  })

  test('qa-fixes stages into the task\'s own tab, with no slug argument, not the orchestrator', async ({ page }) => {
    // Deliberately no ORCHESTRATOR_SESSION for this one — qa-fixes must
    // never read it at all, since its target is this task's own
    // ITERM_SESSION (set in the fixture to a fake id).
    await openTask(page, 'qa-fixes-ready')
    await page.getByTestId('stage-chain-qa').click()
    const cta = page.getByTestId('l2-cta')

    const [request] = await Promise.all([
      page.waitForRequest((req) => req.url().includes('/stage-skill/qa-fixes-ready') && req.method() === 'POST'),
      cta.click(),
    ])
    expect(request.postDataJSON()).toEqual({ stage: 'qa-fixes' })
    await expect(cta).toHaveClass(/btn-err/)
  })
})

test.describe('milestone dependency gating', () => {
  test('a milestone already dispatched shows a disabled Start Dev, not a live one', async ({ page }) => {
    await openTask(page, 'fanout-parent')
    await page.getByTestId('l1-tab-dev').click()
    await page.locator('[data-testid="milestone-card"][data-milestone-id="M0"]').click()
    const cta = page.getByTestId('l2-cta')
    await expect(cta).toBeVisible()
    await expect(cta).toBeDisabled()
  })

  test('a milestone whose dependency is not yet done shows a disabled Start Dev', async ({ page }) => {
    await openTask(page, 'fanout-parent')
    await page.getByTestId('l1-tab-dev').click()
    await page.locator('[data-testid="milestone-card"][data-milestone-id="M2"]').click()
    const cta = page.getByTestId('l2-cta')
    await expect(cta).toBeVisible()
    await expect(cta).toBeDisabled()
  })
})

test.describe('failure path — no orchestrator session registered', () => {
  test('ORCHESTRATOR_SESSION missing entirely: the CTA click fails gracefully, never a false success', async ({ page }) => {
    // withOrchestratorSession(null, ...) guarantees the file is absent —
    // matches a machine where /pipelinely was never started.
    await withOrchestratorSession(null, async () => {
      await openTask(page, 'dev-ready')
      const cta = page.getByTestId('l2-cta')
      await expect(cta).toBeEnabled() // never proactively greyed out — see tech-design.md's Conventions note

      const res = await page.request.post('/stage-skill/dev-ready', { data: { stage: 'dev' } })
      expect(res.status()).toBe(503)
      const { error } = await res.json()

      await cta.click()
      await expect(cta).toHaveClass(/btn-err/)
      await expect(cta).not.toHaveClass(/btn-ok/)
      // The button surfaces the server's own computed message (e.g.
      // "Orchestrator not running — no ORCHESTRATOR_SESSION found") rather
      // than a generic "not found" — see stageSkill() in index.html.
      await expect(cta).toHaveText(error)
      // Re-enabled once the response lands, not left stranded disabled —
      // this CTA never leaves the DOM on failure, unlike a dispatched
      // backlog item.
      await expect(cta).toBeEnabled()
    })
  })

  test('own-session target with no recorded ITERM_SESSION also fails gracefully', async ({ page }) => {
    await openTask(page, 'cr-fixes-ready')
    await page.getByTestId('stage-chain-cr').click()
    const cta = page.getByTestId('l2-cta')
    await expect(cta).toBeEnabled()

    const res = await page.request.post('/stage-skill/cr-fixes-ready', { data: { stage: 'comment-fix' } })
    expect(res.status()).toBe(503)
    const { error } = await res.json()

    await cta.click()
    await expect(cta).toHaveClass(/btn-err/)
    await expect(cta).toHaveText(error)
    await expect(cta).toBeEnabled()
  })
})

// Covers the plan-review VERDICT — the stage chain's "selected note" row
// (see renderStageChain in public/index.html), which is the one place a
// plan-review round's TIMELINE note (its actual finding/outcome, e.g. "round
// 1: looks good") surfaces on the card. Distinct from the CTA suite above:
// this is about whether the review's own result is visible at all, not
// about which button comes next.
test.describe('plan-review verdict — the stage chain note', () => {
  test('happy path: clicking the Plan Review node shows its TIMELINE note as the selected note', async ({ page }) => {
    // dev-ready's TIMELINE ends with a plan-review round note, but its
    // STATUS ("plan reviewed, ready for dev") means the chain's highlighted
    // node — and the selected note — now default to Dev (the next
    // actionable stage, matching the panel below it) rather than raw
    // TIMELINE's last entry. Clicking Plan Review explicitly is what
    // surfaces its own note, same as it drives the panel's own content.
    await openTask(page, 'dev-ready')
    await page.getByTestId('stage-chain-planning').click()
    const note = page.getByTestId('stage-chain-selected-note')
    await expect(note).toBeVisible()
    await expect(note).toContainText('round 1: looks good')
  })

  // Regression test for the developer-reported confusion this fix
  // addresses: the chain used to highlight "Plan Review" as current (blue
  // outline, via raw child.stage) while the panel below defaulted to Dev's
  // content — it looked like Plan Review was selected without showing the
  // plan. Now the highlighted node and the selected note both follow the
  // exact same tab the panel actually renders.
  test('the highlighted node and the panel content agree on a fresh open', async ({ page }) => {
    await openTask(page, 'dev-ready')
    await expect(page.getByTestId('stage-chain-dev')).toHaveAttribute('aria-current', 'step')
    await expect(page.getByTestId('stage-chain-planning')).toHaveAttribute('aria-current', 'false')
    await expect(page.getByTestId('stage-chain-selected-note')).toContainText('Dev')
    await expect(page.getByTestId('l2-cta')).toBeVisible() // the Dev tab's own "Start Dev" CTA
  })

  test('failure path: a task with no TIMELINE at all renders the no-data note instead of crashing', async ({ page }) => {
    const errors: Error[] = []
    page.on('pageerror', (err) => errors.push(err))

    // demo-task has no TIMELINE file — computeStage falls back to its
    // mode/status-based default, and the chain has nothing recorded to pick
    // a selected node from.
    await openTask(page, 'demo-task')
    await expect(page.getByTestId('stage-chain-no-data')).toBeVisible()
    await expect(page.getByTestId('stage-chain')).toBeVisible()
    expect(errors).toEqual([])
  })

  test('failure path: a malformed plan-review TIMELINE line is dropped, not crashed on', async ({ page }) => {
    const errors: Error[] = []
    page.on('pageerror', (err) => errors.push(err))

    // dev-ready-malformed-timeline's plan-review line has an unparseable
    // timestamp — parseTimelineContent (src/taskParser.ts) skips it
    // entirely, so task.stage falls back to 'planning' (the last line that
    // did parse). The Dev CTA still has to come up live regardless, since
    // computeNextStageCta reads STATUS's waitingReason, never TIMELINE.
    await openTask(page, 'dev-ready-malformed-timeline')
    await expect(page.getByTestId('stage-chain')).toBeVisible()
    const cta = page.getByTestId('l2-cta')
    await expect(cta).toBeVisible()
    await expect(cta).toBeEnabled()
    expect(errors).toEqual([])
  })
})

test.describe('anti-double-dispatch: CTA disables for the duration of its POST', () => {
  // Regression test for the QA card's "Start QA" button (and every
  // other pipeline-stage CTA, since they all share stageSkill()) never
  // disabling while its request was in flight — a fast double-click could
  // fire two concurrent /stage-skill/:slug requests, each staging the
  // command a second time. Matches dispatchBacklogItem's protection for the
  // near-identical /backlog/dispatch button.
  test('the CTA disables mid-request and re-enables once the response lands', async ({ page }) => {
    await withOrchestratorSession('fake-orchestrator-session', async () => {
      await openTask(page, 'dev-ready')
      const cta = page.getByTestId('l2-cta')

      let releaseResponse: () => void
      const gate = new Promise<void>((resolve) => { releaseResponse = resolve })
      await page.route('**/stage-skill/dev-ready', async (route) => {
        await gate
        await route.continue()
      })

      await cta.click()
      await expect(cta).toBeDisabled()

      releaseResponse!()
      await expect(cta).toBeEnabled()
      await expect(cta).toHaveClass(/btn-err/) // fixture's fake session id never resolves — see file header
    })
  })

  test('a rapid double-click only fires a single /stage-skill request', async ({ page }) => {
    await withOrchestratorSession('fake-orchestrator-session', async () => {
      await openTask(page, 'dev-ready')

      const requestUrls: string[] = []
      page.on('request', (req) => {
        if (req.method() === 'POST' && req.url().includes('/stage-skill/dev-ready')) requestUrls.push(req.url())
      })

      // Two native .click() calls issued back-to-back within one JS tick,
      // bypassing Playwright's own actionability wait (which would just
      // patiently wait for the button to re-enable between clicks and defeat
      // the point of this test) — this is what a genuinely fast double-click
      // looks like from the button's own perspective.
      await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="l2-cta"]') as HTMLButtonElement
        btn.click()
        btn.click()
      })

      await expect(page.getByTestId('l2-cta')).toHaveClass(/btn-(ok|err)/)
      expect(requestUrls).toHaveLength(1)
    })
  })
})
