import { test, expect, type Page } from '@playwright/test'
import { openTask } from './fixtures/taskDetail.js'

// ds-pipeline-kind M0: a task's pipeline kind comes from its own one-word
// KIND file (absent → dev), and a ds task's stage chain is the design-system
// pipeline's, not the dev one. Folding still applies (plan-review into
// planning, cr-fixes into cr, qa-fixes into qa, design-fixes into
// design-approval), so the ds chain shows nine nodes.
//
// Planning committed this spec red and tagged pending; M0's dev stage removed
// the tag once it went green, so VERIFY's --grep-invert no longer skips it.

const DS_CHAIN_IDS = ['design-intake', 'planning', 'dev', 'cr', 'qa', 'design-qa', 'design-approval', 'merge', 'adopt']
const DEV_FLAT_VISIBLE_COUNT = 5

interface ApiTask { slug: string; kind: string }

async function apiTask(page: Page, slug: string): Promise<ApiTask> {
  const { tasks } = await (await page.request.get('/api/tasks')).json()
  return tasks.find((t: ApiTask) => t.slug === slug)
}

function collectPageErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  return errors
}

test.describe('ds pipeline kind — kind resolution', () => {
  test('a task with KIND "ds" is served as kind ds', async ({ page }) => {
    expect((await apiTask(page, 'ds-intake')).kind).toBe('ds')
  })

  test('a task with no KIND file is served as kind dev', async ({ page }) => {
    expect((await apiTask(page, 'planning-ready')).kind).toBe('dev')
  })

  test('an unrecognised KIND value falls back to dev instead of failing the task', async ({ page }) => {
    const task = await apiTask(page, 'ds-kind-invalid')
    expect(task).toBeDefined()
    expect(task.kind).toBe('dev')
  })
})

test.describe('ds pipeline kind — stage chain', () => {
  test('a ds task renders the ds chain, in order, with every fixes sub-stage folded', async ({ page }) => {
    const pageErrors = collectPageErrors(page)
    await openTask(page, 'ds-intake')

    const nodes = page.getByTestId('stepper-wide').locator('.stage-chain-node')
    await expect(nodes).toHaveCount(DS_CHAIN_IDS.length)
    const ids = await nodes.evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')))
    expect(ids).toEqual(DS_CHAIN_IDS.map((id) => `stage-chain-${id}`))
    await expect(page.getByTestId('stage-chain-design-fixes')).toHaveCount(0)
    await expect(page.getByTestId('stage-chain-plan-review')).toHaveCount(0)
    expect(pageErrors).toEqual([])
  })

  test("selecting the design-intake node shows that stage's own TIMELINE note", async ({ page }) => {
    await openTask(page, 'ds-intake')

    await page.getByTestId('stepper-wide').getByTestId('stage-chain-design-intake').click()

    await expect(page.getByTestId('detail-panel-meta')).toContainText('matched coreui/Button')
  })

  test('regression: a task without a kind still renders the five-node dev chain and no ds nodes', async ({ page }) => {
    await openTask(page, 'planning-ready')

    const wide = page.getByTestId('stepper-wide')
    await expect(wide.locator('.stage-chain-node')).toHaveCount(DEV_FLAT_VISIBLE_COUNT)
    for (const dsOnly of ['design-intake', 'design-qa', 'design-approval', 'adopt']) {
      await expect(page.getByTestId(`stage-chain-${dsOnly}`)).toHaveCount(0)
    }
  })

  test('an unrecognised KIND renders the dev chain without a page error', async ({ page }) => {
    const pageErrors = collectPageErrors(page)
    await openTask(page, 'ds-kind-invalid')

    await expect(page.getByTestId('stepper-wide').locator('.stage-chain-node')).toHaveCount(DEV_FLAT_VISIBLE_COUNT)
    expect(pageErrors).toEqual([])
  })
})
