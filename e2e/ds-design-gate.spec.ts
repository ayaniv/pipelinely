import { test, expect, type Page } from '@playwright/test'
import { clearMergeCalls, readMergeCalls } from './fixtures/fakeGh.js'
import { withRestoredFixtureFiles } from './fixtures/restoreFixtureFiles.js'
import { readTaskFile, removeTaskFile } from './fixtures/taskFiles.js'
import { expectSkillPackaged } from './fixtures/skillPackaging.js'

// ds-pipeline-kind M1: for a ds task, a passed QA hands off to design QA (a
// fresh session that compares Storybook stories with Figma), and design QA
// hands off to the designer's approval gate. Merge is refused until the
// designer approves. A dev task with the same STATUS still goes straight to
// merge, exactly as before.

// Several cases mutate the same fixture task's STATUS/TIMELINE.
test.describe.configure({ mode: 'serial' })

// The dev path (same STATUS → Merge) is already pinned by
// card-merge-cta.spec.ts and pipelinely-merge-gate.spec.ts, which VERIFY runs;
// it is not repeated here because those fixtures are mutated by those specs.

const panelSlot = (page: Page) => page.getByTestId('detail-panel-slot')
const card = (page: Page, slug: string) => page.locator(`.card[data-slug="${slug}"]`)

async function readStatus(slug: string): Promise<string> {
  return ((await readTaskFile(slug, 'STATUS')) ?? '').trim()
}

async function openDesignApproval(page: Page, slug: string): Promise<void> {
  await page.goto(`/task/${slug}?stage=design-approval`)
  await expect(page.getByTestId('task-detail')).toBeVisible()
  await expect(panelSlot(page).getByTestId('l2-panel')).toBeVisible()
}

test.describe('ds pipeline — QA hands off to design QA, not merge', () => {
  test("a ds task whose QA passed offers design QA on its card, and no Merge", async ({ page }) => {
    const bodies: unknown[] = []
    await page.route('**/stage-skill/ds-qa-passed', async (route) => {
      bodies.push(route.request().postDataJSON())
      await route.fulfill({ status: 200, json: { submitted: false } })
    })
    await page.goto('/')

    await expect(card(page, 'ds-qa-passed').getByTestId('card-merge-pr-btn')).toHaveCount(0)
    await card(page, 'ds-qa-passed').getByTestId('card-cta-btn').click()

    await expect.poll(() => bodies.length).toBe(1)
    expect(bodies[0]).toMatchObject({ stage: 'design-qa' })
  })

  test('a design-approved ds task offers Merge on its card', async ({ page }) => {
    await page.goto('/')
    await expect(card(page, 'ds-approved').getByTestId('card-merge-pr-btn')).toBeVisible()
  })
})

test.describe('ds pipeline — merge is refused until the designer approves', () => {
  test('POST /merge-pr on an unapproved ds task is a 409 naming design approval, and nothing is merged', async ({ request }) => {
    await clearMergeCalls(951)
    try {
      await withRestoredFixtureFiles('ds-qa-passed', ['STATUS', 'TIMELINE'], async () => {
        const response = await request.post('/merge-pr/ds-qa-passed')

        expect(response.status()).toBe(409)
        const body = await response.json()
        expect(body.blockers.map((b: { kind: string }) => b.kind)).toContain('design-approval-required')
        expect(await readMergeCalls(951)).toBeNull()
        expect(await readStatus('ds-qa-passed')).toBe('waiting: QA passed, ready to merge')
      })
    } finally {
      await clearMergeCalls(951)
    }
  })
})

test.describe('ds pipeline — the designer approval gate', () => {
  test("the approval panel shows design QA's report and its Storybook screenshot", async ({ page }) => {
    await openDesignApproval(page, 'ds-awaiting-approval')

    await expect(panelSlot(page).getByTestId('design-qa-report')).toContainText('border radius 6px vs 8px')
    const image = panelSlot(page).getByTestId('design-qa-image').first()
    await expect(image).toBeVisible()
    expect(await image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
  })

  test('Approve records the approval and hands the task to merge', async ({ page }) => {
    await withRestoredFixtureFiles('ds-awaiting-approval', ['STATUS', 'TIMELINE'], async () => {
      await openDesignApproval(page, 'ds-awaiting-approval')

      await panelSlot(page).getByTestId('design-approve-btn').click()

      await expect.poll(() => readStatus('ds-awaiting-approval')).toBe('waiting: design approved, ready to merge')
      expect(await readTaskFile('ds-awaiting-approval', 'TIMELINE')).toMatch(/Z design-approval approved\n$/)
    })
  })

  test('Request changes needs notes, then records them and hands off to design fixes', async ({ page }) => {
    try {
      await withRestoredFixtureFiles('ds-awaiting-approval', ['STATUS', 'TIMELINE'], async () => {
        await openDesignApproval(page, 'ds-awaiting-approval')
        const requestChanges = panelSlot(page).getByTestId('design-request-changes-btn')

        await expect(requestChanges).toBeDisabled()
        await panelSlot(page).getByTestId('design-changes-notes').fill('Dark border radius should be 8px')
        await requestChanges.click()

        await expect.poll(() => readStatus('ds-awaiting-approval')).toContain('triage and dispatch design-fixes')
        expect(await readTaskFile('ds-awaiting-approval', 'DESIGN_FEEDBACK.md')).toContain('Dark border radius should be 8px')
        expect(await readTaskFile('ds-awaiting-approval', 'TIMELINE')).toMatch(/Z design-approval changes requested/)
      })
    } finally {
      await removeTaskFile('ds-awaiting-approval', 'DESIGN_FEEDBACK.md')
    }
  })

  test('the approval route refuses a task that is not waiting at the gate, and empty change notes', async ({ request }) => {
    await withRestoredFixtureFiles('ds-qa-passed', ['STATUS', 'TIMELINE'], async () => {
      const notAtGate = await request.post('/design-approval/ds-qa-passed', { data: { decision: 'approve' } })
      expect(notAtGate.status()).toBe(409)
      expect(await readStatus('ds-qa-passed')).toBe('waiting: QA passed, ready to merge')
    })

    await withRestoredFixtureFiles('ds-awaiting-approval', ['STATUS', 'TIMELINE'], async () => {
      const emptyNotes = await request.post('/design-approval/ds-awaiting-approval', { data: { decision: 'request-changes', notes: '   ' } })
      expect(emptyNotes.status()).toBe(400)
      expect(await readStatus('ds-awaiting-approval')).toBe('waiting: design QA done, ready for design approval')
    })
  })

  test("design QA's screenshot route serves only files inside the task's design-qa directory", async ({ request }) => {
    const image = await request.get('/task-asset/ds-awaiting-approval/design-qa/primary-light.png')
    expect(image.status()).toBe(200)
    expect(image.headers()['content-type']).toContain('image/png')

    const traversal = await request.get('/task-asset/ds-awaiting-approval/design-qa/..%2FSTATUS')
    expect(traversal.status()).toBeGreaterThanOrEqual(400)
    expect(await traversal.text()).not.toContain('ready for design approval')
  })
})

test.describe('ds pipeline — M1 skills ship with a fresh install', () => {
  test('pipelinely-design-qa and pipelinely-design-fixes are packaged and renamed for the public repo', async () => {
    await expectSkillPackaged('pipelinely-design-qa')
    await expectSkillPackaged('pipelinely-design-fixes')
  })
})
