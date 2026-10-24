import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { clearDeleteRefCalls, clearMergeCalls, readMergeCalls } from './fixtures/fakeGh.js'
import { withRestoredFixtureFiles } from './fixtures/restoreFixtureFiles.js'
import { readTaskFile } from './fixtures/taskFiles.js'
import { expectSkillPackaged } from './fixtures/skillPackaging.js'
import { REPO_ROOT } from './fixtures/ossSource.js'

// ds-pipeline-kind M2: the ends of the ds pipeline. Merging a ds task does
// not finish it: it hands off to adopt, which queues one follow-up per
// affected app (listed in the plan's "## Affected apps" section). Design
// intake runs inside the planning session, so its only new surface is a skill
// that has to ship.

// The merge case mutates a fixture's STATUS/TIMELINE. A dev task merging to
// done is already pinned by pipelinely-merge-gate.spec.ts.
test.describe.configure({ mode: 'serial' })

const panelSlot = (page: Page) => page.getByTestId('detail-panel-slot')

async function readStatus(slug: string): Promise<string> {
  return ((await readTaskFile(slug, 'STATUS')) ?? '').trim()
}

test.describe('ds pipeline — merge hands off to adopt', () => {
  const SLUG = 'ds-merge-gate-green'
  const PR = 950

  test.beforeEach(async () => {
    await clearMergeCalls(PR)
    await clearDeleteRefCalls(`claude/${SLUG}`)
  })

  test.afterEach(async () => {
    await clearMergeCalls(PR)
    await clearDeleteRefCalls(`claude/${SLUG}`)
  })

  test('merging an approved ds task leaves it waiting for adopt instead of done', async ({ request }) => {
    await withRestoredFixtureFiles(SLUG, ['STATUS', 'TIMELINE'], async () => {
      const response = await request.post(`/merge-pr/${SLUG}`)

      expect(response.status()).toBe(200)
      expect(await response.json()).toMatchObject({ merged: true, prNumber: String(PR) })
      expect(await readMergeCalls(PR)).not.toBeNull()
      expect(await readStatus(SLUG)).toBe('waiting: merged, ready for adopt')
      expect(await readTaskFile(SLUG, 'TIMELINE')).toMatch(new RegExp(`Z merge merged PR #${PR}\\n$`))
    })
  })
})

test.describe('ds pipeline — adopt', () => {
  test("a merged ds task's card offers adopt", async ({ page }) => {
    const bodies: unknown[] = []
    await page.route('**/stage-skill/ds-merged', async (route) => {
      bodies.push(route.request().postDataJSON())
      await route.fulfill({ status: 200, json: { submitted: false } })
    })
    await page.goto('/')

    await page.locator('.card[data-slug="ds-merged"]').getByTestId('card-cta-btn').click()

    await expect.poll(() => bodies.length).toBe(1)
    expect(bodies[0]).toMatchObject({ stage: 'adopt' })
  })

  test("the adopt panel lists the plan's affected apps", async ({ page }) => {
    await page.goto('/task/ds-merged?stage=adopt')
    await expect(page.getByTestId('task-detail')).toBeVisible()

    const apps = panelSlot(page).getByTestId('adopt-app')
    await expect(apps).toHaveCount(2)
    expect(await apps.evaluateAll((els) => els.map((el) => el.getAttribute('data-app')))).toEqual(['web-app', 'admin-portal'])
  })

  test('a ds plan with no affected-apps section says so instead of listing nothing', async ({ page }) => {
    await page.goto('/task/ds-intake?stage=adopt')
    await expect(page.getByTestId('task-detail')).toBeVisible()

    await expect(panelSlot(page).getByTestId('adopt-no-apps')).toBeVisible()
    await expect(panelSlot(page).getByTestId('adopt-app')).toHaveCount(0)
  })
})

test.describe('ds pipeline — M2 skills ship with a fresh install', () => {
  test('pipelinely-design-intake and pipelinely-adopt are packaged and renamed for the public repo', async () => {
    await expectSkillPackaged('pipelinely-design-intake')
    await expectSkillPackaged('pipelinely-adopt')
  })
})

test.describe('ds pipeline — the dispatched adopt session can start', () => {
  // dispatch-tab.sh overwrites STATUS with `working` before the tab opens, so
  // a gate on the merge's `waiting: merged, ready for adopt` would never pass.
  test('pipelinely-adopt gates on KIND and the merge TIMELINE line, not STATUS', async () => {
    const skill = await fs.readFile(path.join(REPO_ROOT, '.claude', 'skills', 'pipelinely-adopt', 'SKILL.md'), 'utf-8')
    const gate = skill.slice(skill.indexOf('## Step 1'), skill.indexOf('## Step 2'))
    expect(gate).toContain('merge merged PR #<n>')
    expect(gate).toContain('Do not gate on `STATUS`')
  })
})
