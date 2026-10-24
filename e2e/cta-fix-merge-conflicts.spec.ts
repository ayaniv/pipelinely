import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { freezeLiveFeed, pushSnapshot } from './fixtures/liveBoard.js'
import { withRestoredFixtureFiles } from './fixtures/restoreFixtureFiles.js'
import { readTaskFile, writeTaskFile } from './fixtures/taskFiles.js'
import { openTask } from './fixtures/taskDetail.js'

// A PR that conflicts with master puts the conflict fix first: the card's one
// stage button is Fix conflicts, never Start QA, and the inner page offers it
// where Merge would be. The fixture task's STATUS says QA is next ("fixes
// pushed, ready to re-run QA") — exactly the live bug (PR #149) — while its
// canned PR #913 (e2e/fixtures/gh/prs/913.json, served by the fake gh) is
// CONFLICTING. The merge state is derived, never stored, so flipping the
// canned PR to MERGEABLE brings Start QA back on its own, without a reload.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SLUG = 'cta-conflicting-pr'
const PR_FIXTURE = path.join(__dirname, 'fixtures', 'gh', 'prs', '913.json')
// A milestone parent whose one dispatched child (-m0) has a CONFLICTING PR
// (e2e/fixtures/gh/prs/914.json).
const MILESTONE_PARENT = 'cta-conflict-project'
// Same key design-v3-table-view.spec.ts opens the table with.
const VIEW_STORAGE_KEY = 'cockpit-active-view'

// Every test reads or flips the one canned PR, so they must not interleave.
test.describe.configure({ mode: 'serial' })

function card(page: Page) {
  return page.locator(`.card[data-slug="${SLUG}"]`)
}

function stageButton(page: Page, stage: string) {
  return card(page).locator(`[data-testid="card-cta-btn"][data-stage="${stage}"]`)
}

function tableRow(page: Page) {
  return page.locator(`[data-testid="table-row"][data-slug="${SLUG}"]`)
}

function railNode(page: Page, stage: string) {
  return card(page).locator(`[data-testid="mini-stage-node"][data-stage="${stage}"]`)
}

async function setCannedMergeable(mergeable: 'MERGEABLE' | 'CONFLICTING'): Promise<void> {
  const view = JSON.parse(await fs.readFile(PR_FIXTURE, 'utf-8'))
  view.mergeable = mergeable
  view.mergeStateStatus = mergeable === 'MERGEABLE' ? 'CLEAN' : 'DIRTY'
  await fs.writeFile(PR_FIXTURE, JSON.stringify(view))
}

// The server re-reads a PR's merge state on its normal snapshot cycle (a task
// file write, or the timer), once the short cache TTL (shortened for e2e in
// fakeGhEnv) has passed. Rewriting STATUS unchanged is that write.
async function nudgeRefresh(): Promise<void> {
  await writeTaskFile(SLUG, 'STATUS', (await readTaskFile(SLUG, 'STATUS')) ?? '')
}

async function withCannedPrRestored(fn: () => Promise<void>): Promise<void> {
  const original = await fs.readFile(PR_FIXTURE, 'utf-8')
  try {
    await withRestoredFixtureFiles(SLUG, ['STATUS', 'TIMELINE'], fn)
  } finally {
    await fs.writeFile(PR_FIXTURE, original)
  }
}

test.describe('Fix conflicts comes first on a conflicting PR', () => {
  test('the card offers Fix conflicts and no Start QA, Merge or other stage', async ({ page }) => {
    await page.goto('/')

    await expect(stageButton(page, 'merge-conflicts')).toBeVisible()
    await expect(card(page).getByTestId('card-cta-btn')).toHaveCount(1)
    await expect(stageButton(page, 'qa')).toHaveCount(0)
    await expect(card(page).getByTestId('card-merge-pr-btn')).toHaveCount(0)
  })

  test('the table row offers Fix conflicts and no Start QA or Merge', async ({ page }) => {
    await page.addInitScript((key) => localStorage.setItem(key, 'table'), VIEW_STORAGE_KEY)
    await page.goto('/')
    await expect(page.getByTestId('table-row').first()).toBeVisible()
    // Only this task, so the virtualized table is sure to render its row.
    await freezeLiveFeed(page)
    await pushSnapshot(page, { onlySlugs: [SLUG] })

    const row = tableRow(page)
    await expect(row.locator('[data-testid="row-cta-btn"][data-stage="merge-conflicts"]')).toBeVisible()
    await expect(row.getByTestId('row-cta-btn')).toHaveCount(1)
    await expect(row.locator('[data-stage="qa"]')).toHaveCount(0)
    await expect(row.locator('[data-action="merge-pr"]')).toHaveCount(0)
  })

  test('the API carries the merge state as a small string union', async ({ page }) => {
    const { tasks } = await (await page.request.get('/api/tasks')).json()
    const task = tasks.find((t: { slug: string }) => t.slug === SLUG)

    expect(task.prNumber).toBe('913')
    expect(task.prMergeState).toBe('conflicting')
  })

  test('the inner task page offers Fix conflicts where Merge would be, and no Merge', async ({ page }) => {
    await openTask(page, SLUG)
    const detail = page.getByTestId('task-detail')

    await expect(detail.getByTestId('fix-conflicts-cta')).toBeEnabled()
    await expect(detail.getByTestId('merge-pr-btn')).toHaveCount(0)
  })

  test('once the PR is mergeable again, Start QA comes back without a reload', async ({ page }) => {
    await withCannedPrRestored(async () => {
      await page.goto('/')
      await expect(stageButton(page, 'merge-conflicts')).toBeVisible()

      await setCannedMergeable('MERGEABLE')
      await expect(async () => {
        await nudgeRefresh()
        await expect(stageButton(page, 'qa')).toBeVisible({ timeout: 2_000 })
      }).toPass({ timeout: 20_000 })
      await expect(stageButton(page, 'merge-conflicts')).toHaveCount(0)

      // And back: a new conflict hides Start QA again, the same way.
      await setCannedMergeable('CONFLICTING')
      await expect(async () => {
        await nudgeRefresh()
        await expect(stageButton(page, 'merge-conflicts')).toBeVisible({ timeout: 2_000 })
      }).toPass({ timeout: 20_000 })
      await expect(stageButton(page, 'qa')).toHaveCount(0)
    })
  })

  // The conflict fix's own TIMELINE line records that it ran, not that the
  // task moved: once it hands back (STATUS restored, PR mergeable), the card
  // reads where the task really stands — QA next, not Merge.
  test('after a conflict fix lands, the card is back at QA, not at Merge', async ({ page }) => {
    await withCannedPrRestored(async () => {
      await setCannedMergeable('MERGEABLE')
      const timeline = (await readTaskFile(SLUG, 'TIMELINE')) ?? ''
      await writeTaskFile(SLUG, 'TIMELINE', `${timeline}2026-10-01T16:00:00Z merge-conflicts resolved PR #913 against origin/master (web/src/stageView.ts)\n`)

      await page.goto('/')
      await expect(async () => {
        await nudgeRefresh()
        await expect(stageButton(page, 'qa')).toBeVisible({ timeout: 2_000 })
      }).toPass({ timeout: 20_000 })

      await expect(card(page)).toHaveAttribute('data-stage', 'qa-fixes')
      await expect(railNode(page, 'qa')).toHaveAttribute('data-state', 'current')
      await expect(railNode(page, 'merge')).toHaveAttribute('data-state', 'todo')
    })
  })

  // A dispatched milestone opens its own task page from the wave graph, whose
  // Merge panel must read the resolved child task, merge state included.
  test("a milestone whose PR conflicts offers Fix conflicts in its Merge panel", async ({ page }) => {
    await page.goto(`/task/${MILESTONE_PARENT}`)

    await page.getByTestId('wave-task-M0').click()
    await page.getByTestId('stage-chain-merge').click()
    await expect(page.getByTestId('fix-conflicts-cta')).toBeEnabled()
    await expect(page.getByTestId('merge-pr-btn')).toHaveCount(0)
  })
})
