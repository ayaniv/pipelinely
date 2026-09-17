import { test, expect } from '@playwright/test'
import { withRestoredFixtureFiles } from './fixtures/restoreFixtureFiles.js'
import { openTask } from './fixtures/taskDetail.js'

// Covers the Merge tab's three actions (Open PR, Merge, Mark done) and the
// qa-fixes/comment-fix Skip escape hatch — all four shell out to real
// git/gh (see gitOps.ts) against "<REPOS_DIR>/<task.repo>", which the
// fixture REPOS_DIR (see playwright.config.ts) deliberately has no real
// checkout for. That makes every git/gh call in this suite fail
// deterministically and offline — exactly what's being verified here is
// that a failure surfaces correctly end-to-end (route wiring, error text,
// button state), not that a merge/cleanup actually succeeds. The success
// path for the underlying git operations (removeWorktreeAndBranch) is
// covered for real against a throwaway git repo in src/gitOps.test.ts —
// this suite is the HTTP/UI layer on top of it. The merge gate's own
// blocked/green paths, against a fake gh, live in pipelinely-merge-gate.spec.ts.

// The card grid and the detail overlay both carry a mark-done-btn/
// open-pr-btn (the overlay stays mounted behind the grid, so both are in
// the DOM at once even though only one is visible) — card() scopes a
// locator to just the one card these tests care about, sidestepping the
// strict-mode "multiple elements" failure a bare getByTestId would hit
// once more than one card on the board has the same action available.
function card(page, slug: string) {
  return page.locator(`.card[data-slug="${slug}"]`)
}

// Open PR and Mark done both moved into the card's own 3-dot menu in the
// Pipelinely Pipeline redesign (see cardMenuItemsHtml in public/index.html)
// — every case that clicks one now opens that menu first.
async function openCardMenu(page, slug: string) {
  await card(page, slug).getByTestId('card-menu-btn').click()
}

test.describe('Open PR', () => {
  test('clicking it fails gracefully against a repo with no real checkout, rather than a silent no-op', async ({ page }) => {
    // merge-ready's TIMELINE has a 'dev' note "PR #42 open" — findPrNumber
    // resolves 42 from it, so the button renders (findPrNumber is covered
    // directly in src/taskParser.test.ts; this just needs it to be truthy
    // so the button exists to click). Uses the card's own copy of the
    // button — simpler than opening the detail view for a check that
    // doesn't depend on which one fired.
    await page.goto('/')
    await openCardMenu(page, 'merge-ready')
    const btn = card(page, 'merge-ready').getByTestId('open-pr-btn')
    await expect(btn).toBeVisible()
    await btn.click()
    await expect(btn).toHaveClass(/btn-err/)
  })

  test('still renders when the latest dev note is just a follow-up on the same PR', async ({ page }) => {
    // merge-ready-followup-dev-note's TIMELINE has an earlier 'dev' note
    // "PR #42 open" followed by a later 'dev' note "rebased on master,
    // pushed fixes" with no PR reference of its own — regression coverage
    // for findPrNumber's walk-backward fix (client-side copy in
    // public/index.html; server-side is covered directly in
    // src/taskParser.test.ts). Before the fix, the button would be absent
    // because the client mirror only checked the single latest dev note.
    await page.goto('/')
    await openCardMenu(page, 'merge-ready-followup-dev-note')
    const btn = card(page, 'merge-ready-followup-dev-note').getByTestId('open-pr-btn')
    await expect(btn).toBeVisible()
  })
})

test.describe('Merge', () => {
  test('is not offered when no PR number can be found', async ({ page }) => {
    // planning-ready has no 'dev' TIMELINE entry yet (dev hasn't run) and
    // no reviewRef — findPrNumber is null, so Merge (detail-view only,
    // unlike Open PR/Mark done which also have a card copy) never renders.
    await openTask(page, 'planning-ready')
    await page.getByTestId('stage-chain-merge').click()
    await expect(page.getByTestId('task-detail').getByTestId('merge-pr-btn')).toHaveCount(0)
  })

  test('clicking it fails gracefully and surfaces gh\'s own error text', async ({ page }) => {
    // merge-ready's STATUS ("QA passed, ready to merge") has no
    // NEXT_STAGE_BY_WAITING_REASON entry (merge is never staged — see that
    // table's own comment), so defaultL2Tab falls back to 'dev';
    // Merge only renders on the 'merge' chain node, reached here by
    // explicitly clicking it — same as the existing "QA passed, ready to
    // merge" CTA test in pipeline-stage-cta.spec.ts.
    await openTask(page, 'merge-ready')
    await page.getByTestId('stage-chain-merge').click()
    const btn = page.getByTestId('task-detail').getByTestId('merge-pr-btn')
    await expect(btn).toBeVisible()
    await expect(btn).toBeEnabled()

    // Merge always confirms first (it merges to a shared remote and marks
    // the task done) — accept it so the request actually fires.
    page.once('dialog', (d) => d.accept())
    const [response] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/merge-pr/merge-ready') && res.request().method() === 'POST'),
      btn.click(),
    ])
    // The preflight gate's `gh pr view` can't even start — merge-ready's
    // repo has no checkout under the fixture REPOS_DIR — so the gate reports
    // itself unavailable rather than guessing the PR is safe. A persistent
    // banner is the failure surface now (see pipelinely-merge-gate.spec.ts's
    // own mergeBanner helper) — there's no more btn-err flash to assert.
    expect(response.status()).toBe(503)
    const banner = page.getByTestId('task-detail').getByTestId('merge-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toHaveAttribute('data-tone', 'error')
    await expect(btn).toBeEnabled() // re-enabled, not stranded disabled
  })
})

test.describe('Mark done', () => {
  test('a task with no worktree marks done with no confirm prompt', async ({ page }) => {
    await withRestoredFixtureFiles('mark-done-no-worktree', ['STATUS'], async () => {
      await page.goto('/')
      await openCardMenu(page, 'mark-done-no-worktree')
      const btn = card(page, 'mark-done-no-worktree').getByTestId('mark-done-btn')

      let dialogFired = false
      page.once('dialog', (d) => { dialogFired = true; d.dismiss() })

      const [response] = await Promise.all([
        page.waitForResponse((res) => res.url().includes('/mark-done/mark-done-no-worktree') && res.request().method() === 'POST'),
        btn.click(),
      ])
      expect(response.status()).toBe(200)
      expect(dialogFired).toBe(false)

      const { tasks } = await (await page.request.get('/api/tasks')).json()
      const task = tasks.find((t: { slug: string }) => t.slug === 'mark-done-no-worktree')
      expect(task.status).toBe('done')
    })
  })

  test('a task WITH a worktree confirms first — dismissing leaves it untouched', async ({ page }) => {
    // Its own fixture slug, distinct from the "confirmed" case below —
    // fullyParallel runs both tests concurrently, and the two previously
    // shared 'mark-done-with-worktree', racing on the same STATUS file this
    // helper reads/restores (masked until now because every fetch in this
    // file hit the wrong hardcoded port and failed before reaching the race).
    await withRestoredFixtureFiles('mark-done-with-worktree-dismiss', ['STATUS'], async () => {
      await page.goto('/')
      await openCardMenu(page, 'mark-done-with-worktree-dismiss')
      const btn = card(page, 'mark-done-with-worktree-dismiss').getByTestId('mark-done-btn')

      page.once('dialog', (d) => d.dismiss())
      await btn.click()

      // Dismissed — no request should have fired, task still active.
      await page.waitForTimeout(300)
      const status = await (await page.request.get('/api/tasks')).json()
      const task = status.tasks.find((t: { slug: string }) => t.slug === 'mark-done-with-worktree-dismiss')
      expect(task.status).not.toBe('done')
    })
  })

  test('a task WITH a worktree, confirmed: marks done and surfaces the cleanup failure without blocking it', async ({ page }) => {
    await withRestoredFixtureFiles('mark-done-with-worktree', ['STATUS'], async () => {
      await page.goto('/')
      await openCardMenu(page, 'mark-done-with-worktree')
      const btn = card(page, 'mark-done-with-worktree').getByTestId('mark-done-btn')

      let dialogMessage = ''
      page.once('dialog', (d) => { dialogMessage = d.message(); d.accept() })

      const [response] = await Promise.all([
        page.waitForResponse((res) => res.url().includes('/mark-done/mark-done-with-worktree') && res.request().method() === 'POST'),
        btn.click(),
      ])

      expect(dialogMessage).toContain('claude/mark-done-with-worktree')
      expect(response.status()).toBe(200)
      const body = await response.json()
      // The fixture's repo has no real checkout under REPOS_DIR, so
      // cleanup deterministically fails — but STATUS is still written
      // before cleanup is even attempted (see /mark-done's own comment).
      expect(body.cleaned).toBe(false)
      expect(body.cleanupError).toMatch(/couldn't remove worktree/)

      const tasksRes = await page.request.get('/api/tasks')
      const { tasks } = await tasksRes.json()
      const task = tasks.find((t: { slug: string }) => t.slug === 'mark-done-with-worktree')
      expect(task.status).toBe('done')
    })
  })
})

test.describe('Skip (qa-fixes / comment-fix)', () => {
  test('qa-fixes: skipping advances the task to merge without dispatching a fixer', async ({ page }) => {
    await withRestoredFixtureFiles('qa-fixes-skip-target', ['STATUS', 'TIMELINE'], async () => {
      await openTask(page, 'qa-fixes-skip-target')
      await page.getByTestId('stage-chain-qa').click()
      const btn = page.getByTestId('skip-cta')
      await expect(btn).toBeVisible()
      await expect(btn).toBeEnabled()

      const [response] = await Promise.all([
        page.waitForResponse((res) => res.url().includes('/skip-stage/qa-fixes-skip-target') && res.request().method() === 'POST'),
        btn.click(),
      ])
      expect(response.status()).toBe(200)
      expect(response.request().postDataJSON()).toEqual({ stage: 'qa-fixes' })

      const tasksRes = await page.request.get('/api/tasks')
      const { tasks } = await tasksRes.json()
      const task = tasks.find((t: { slug: string }) => t.slug === 'qa-fixes-skip-target')
      expect(task.stage).toBe('qa-fixes') // TIMELINE's newest entry — see SKIP_STAGE's own comment
      expect(task.waitingReason).toBe('QA passed, ready to merge')
    })
  })

  test('comment-fix: skipping advances the task to QA without dispatching a fixer', async ({ page }) => {
    await withRestoredFixtureFiles('cr-fixes-skip-target', ['STATUS', 'TIMELINE'], async () => {
      await openTask(page, 'cr-fixes-skip-target')
      await page.getByTestId('stage-chain-cr').click()
      const btn = page.getByTestId('skip-cta')
      await expect(btn).toBeVisible()
      await expect(btn).toBeEnabled()

      const [response] = await Promise.all([
        page.waitForResponse((res) => res.url().includes('/skip-stage/cr-fixes-skip-target') && res.request().method() === 'POST'),
        btn.click(),
      ])
      expect(response.status()).toBe(200)
      expect(response.request().postDataJSON()).toEqual({ stage: 'comment-fix' })

      const tasksRes = await page.request.get('/api/tasks')
      const { tasks } = await tasksRes.json()
      const task = tasks.find((t: { slug: string }) => t.slug === 'cr-fixes-skip-target')
      expect(task.stage).toBe('comment-fix')
      expect(task.waitingReason).toBe('comments addressed, ready for QA')
    })
  })

  test('the Fix CTA staying disabled with nothing selected does not block Skip', async ({ page }) => {
    // qa-fixes-none-selected already exists for this exact "nothing
    // checked" shape (see pipeline-stage-cta.spec.ts) — Skip must be live
    // there precisely because the Fix CTA never can be.
    await openTask(page, 'qa-fixes-none-selected')
    await page.getByTestId('stage-chain-qa').click()
    await expect(page.getByTestId('l2-cta')).toBeDisabled()
    await expect(page.getByTestId('skip-cta')).toBeEnabled()
  })
})
