import { test, expect } from '@playwright/test'

// Two task-detail-view bugs, both reported from the same page
// (/task/<slug>): the side nav (tab-bar) going dead once a task's detail
// view is open, and a milestone child's detail view having no way back to
// its parent. Fixture data: e2e/fixtures/tasks/demo-task (flat, no parent)
// and fanout-parent/fanout-parent-m0 (parent + milestone child).

test.describe('side nav from the task detail view', () => {
  // Root cause: body.detail-open hides #board (and every .tab-panel inside
  // it) outright — switchTab only flips which panel *would* show once that
  // class comes off, so from an open detail view a side-nav click updated
  // internal state but never became visible. Fix: closing the detail view
  // is now part of the tab-bar's own click handler.
  test('clicking a side-nav tab while a task detail view is open closes it and switches to that tab', async ({ page }) => {
    await page.goto('/task/demo-task')
    await expect(page.getByTestId('task-detail')).toBeVisible()

    await page.getByTestId('tab-btn-backlog').click()

    // Non-default tabs get their own URL (tabUrl/matchTabFromPath, added by
    // the orchestrator-auto-mode merge — '/' is reserved for DEFAULT_TAB),
    // so a Backlog click lands on /backlog, not back at '/'.
    await expect(page).toHaveURL('/backlog')
    await expect(page.getByTestId('task-detail')).toBeHidden()
    await expect(page.getByTestId('tab-btn-backlog')).toHaveClass(/is-active/)
    await expect(page.getByTestId('backlog-section')).toHaveClass(/is-active/)
  })

  // Failure-path/regression guard: the fix branches on body.detail-open, so
  // this confirms the ordinary case (no detail view open) still switches
  // tabs the same way it always has.
  test('clicking a side-nav tab from the board view (no detail open) still just switches tabs', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('task-detail')).toBeHidden()

    await page.getByTestId('tab-btn-done').click()

    // Same per-tab URL routing as above — Done is a non-default tab too.
    await expect(page).toHaveURL('/done')
    await expect(page.getByTestId('tab-btn-done')).toHaveClass(/is-active/)
    await expect(page.getByTestId('done-section')).toHaveClass(/is-active/)
  })
})

test.describe('parent link on a milestone child\'s detail view', () => {
  // Reuses task.projectTitle/task.projectBase — the same fields the board's
  // own card-parent-chip reads (see index.html) — rather than deriving the
  // parent relationship a second way.
  test('a milestone child\'s detail view links back to its parent, and clicking it opens the parent', async ({ page }) => {
    await page.goto('/task/fanout-parent-m0')
    await expect(page.getByTestId('task-detail')).toBeVisible()

    const parentLink = page.getByTestId('detail-parent-link')
    await expect(parentLink).toBeVisible()
    await expect(parentLink).toHaveText(/Fanout parent fixture/)

    await parentLink.click()

    await expect(page).toHaveURL('/task/fanout-parent')
    await expect(page.locator('#detail-title')).toHaveText('Fanout parent fixture')
  })

  // Failure path: a flat task (no parent relationship at all) must not
  // render the link.
  test('a flat task\'s detail view has no parent link', async ({ page }) => {
    await page.goto('/task/demo-task')
    await expect(page.getByTestId('task-detail')).toBeVisible()

    await expect(page.getByTestId('detail-parent-link')).toHaveCount(0)
  })
})
