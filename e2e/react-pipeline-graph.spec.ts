import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page, type Locator } from '@playwright/test'
import { openTask } from './fixtures/taskDetail.js'
import { withRestoredFixtureFiles } from './fixtures/restoreFixtureFiles.js'
import { FIXTURE_TASKS_DIR } from './fixtures/fixtureDirs.js'
import { readTaskFile, writeTaskFile } from './fixtures/taskFiles.js'
import { startCanonicalServer, stopCanonicalServer } from './fixtures/canonicalServer.js'

// The task-detail graph slot — the flat stage chain (stepper)
// and the fan-out parent's milestone wave grid — is rendered with React
// Flow. It covers: flat stage nodes, milestone waves + dependency edges, the existing
// status/action information on every node, selection driving the matching
// stage panel, live status updates, selection surviving them, keyboard
// access, small-screen usability, a representative large milestone set —
// and, as explicit non-goals, no workflow editor and no persisted drag
// positions.
//
// The other task-detail specs (design-v2-task-detail, detail-stages-redesign,
// stepper-node-grouping, stage-scope-summary, design-v2-milestone-view,
// batch-dispatch-staging, ...) are not re-proved here.

const FLAT_SLUG = 'dev-ready'
const MILESTONE_CHILD_SLUG = 'fanout-parent-m0'
const LIVE_FLAT_SLUG = 'pipeline-graph-live'
const LARGE_SLUG = 'pipeline-graph-large'
const LARGE_LIVE_CHILD_SLUG = 'pipeline-graph-large-m1'

// dev-ready: Planning, Dev, CR, QA, Merge (Plan Review / CR fixes / QA fixes
// fold into their parent node — see stepper-node-grouping.spec.ts).
const FLAT_VISIBLE_COUNT = 5
const MILESTONE_VISIBLE_COUNT = 4
const MOBILE_VIEWPORT = { width: 390, height: 844 }
// chokidar/fsevents coalescing on macOS alone is ~1s; 10s is headroom, not an expectation.
const LIVE_UPDATE_TIMEOUT_MS = 10_000

interface DeclaredMilestone { id: string; needs: string[] }

// The fixture's own tech-design.md is the single source of truth for how many
// milestones/edges the graph must draw — parsed here rather than hard-coded
// so the two can't drift.
function declaredMilestones(slug: string): DeclaredMilestone[] {
  const plan = fs.readFileSync(path.join(FIXTURE_TASKS_DIR, slug, 'tech-design.md'), 'utf-8')
  return [...plan.matchAll(/^- (M\d+): .*? — needs: (.*?) — est:/gm)].map(([, id, needs]) => ({
    id,
    needs: needs === 'none' ? [] : needs.split(',').map((n) => n.trim()),
  }))
}

const stageFlow = (page: Page) => page.getByTestId('stage-flow')
const stageNode = (page: Page, id: string) => page.getByTestId(`stage-chain-${id}`)
const milestoneFlow = (page: Page) => page.getByTestId('milestone-flow')
const milestoneCard = (page: Page, id: string) => page.locator(`[data-testid="milestone-card"][data-milestone-id="${id}"]`)

function collectPageErrors(page: Page): Error[] {
  const errors: Error[] = []
  page.on('pageerror', (err) => errors.push(err))
  return errors
}

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()) })
  return errors
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error('element has no bounding box — is it rendered and visible?')
  return box
}

async function openLargeParent(page: Page) {
  await page.goto(`/task/${LARGE_SLUG}`)
  await expect(milestoneFlow(page)).toBeVisible()
}

test.describe('stage chain: flat task and milestone child render as React Flow', () => {
  test('a flat task draws one React Flow node per visible stage, chained by edges, with no page errors', async ({ page }) => {
    const pageErrors = collectPageErrors(page)
    const consoleErrors = collectConsoleErrors(page)
    await openTask(page, FLAT_SLUG)

    await expect(stageFlow(page)).toBeVisible()
    await expect(stageFlow(page).locator('.react-flow__node')).toHaveCount(FLAT_VISIBLE_COUNT)
    await expect(stageFlow(page).locator('.react-flow__edge')).toHaveCount(FLAT_VISIBLE_COUNT - 1)
    // The node content is still the existing per-stage button, so every
    // selector the older specs use keeps resolving inside a flow node.
    for (const id of ['planning', 'dev', 'cr', 'qa', 'merge']) {
      await expect(stageFlow(page).locator('.react-flow__node').getByTestId(`stage-chain-${id}`)).toHaveCount(1)
    }
    expect(pageErrors, pageErrors.map(String).join('\n')).toEqual([])
    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  test('edges up to the current node are traversed and the rest are not', async ({ page }) => {
    await openTask(page, FLAT_SLUG)

    // dev-ready: Planning done, Dev current → Planning→Dev and Dev→CR are traversed.
    await expect(stageNode(page, 'dev')).toHaveAttribute('aria-current', 'step')
    await expect(stageFlow(page).locator('.react-flow__edge.is-traversed')).toHaveCount(2)
  })

  test('a milestone child renders its own four-node chain with the state word on each node', async ({ page }) => {
    await page.goto(`/task/${MILESTONE_CHILD_SLUG}`)

    await expect(stageFlow(page)).toBeVisible()
    await expect(stageFlow(page).locator('.react-flow__node')).toHaveCount(MILESTONE_VISIBLE_COUNT)
    await expect(stageFlow(page).getByTestId('stage-node-data')).toHaveCount(MILESTONE_VISIBLE_COUNT)
    await expect(page.getByTestId('stepper-wide')).toHaveClass(/is-milestone/)
  })

  test('the flow is display-only: dragging a node moves nothing and nothing is persisted', async ({ page }) => {
    await openTask(page, FLAT_SLUG)
    const node = stageFlow(page).locator('.react-flow__node').nth(2)
    const before = await boxOf(node)

    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
    await page.mouse.down()
    await page.mouse.move(before.x + before.width / 2 + 120, before.y + before.height / 2 + 60, { steps: 6 })
    await page.mouse.up()
    expect(await boxOf(node)).toEqual(before)

    const storedKeys = await page.evaluate(() => Object.keys(localStorage).filter((key) => /flow|node|position/i.test(key)))
    expect(storedKeys).toEqual([])
  })
})

test.describe('stage chain: selection drives the matching stage panel', () => {
  test('clicking a node selects it, marks it current, and swaps the panel and URL to that stage', async ({ page }) => {
    await openTask(page, FLAT_SLUG)

    await stageNode(page, 'qa').click()

    await expect(stageNode(page, 'qa')).toHaveAttribute('aria-current', 'step')
    await expect(stageNode(page, 'dev')).toHaveAttribute('aria-current', 'false')
    await expect(page.locator('.l2-panel-title')).toHaveText('QA')
    await expect(page).toHaveURL(/\/task\/dev-ready\?stage=qa$/)
  })

  test('a cold load of ?stage=<id> selects that node', async ({ page }) => {
    await page.goto(`/task/${FLAT_SLUG}?stage=cr`)

    await expect(stageNode(page, 'cr')).toHaveAttribute('aria-current', 'step')
    await expect(page.locator('.l2-panel-title')).toHaveText('CR')
  })

  test('the milestone chain inside a drill-down selects the same way', async ({ page }) => {
    await openLargeParent(page)
    await milestoneCard(page, 'M1').click()
    await expect(page.getByTestId('milestone-detail-head')).toBeVisible()

    await stageNode(page, 'qa').click()

    await expect(stageNode(page, 'qa')).toHaveAttribute('aria-current', 'step')
    await expect(page.locator('.l2-panel-title')).toHaveText('QA')
  })
})

test.describe('stage chain: keyboard access', () => {
  test('nodes are reachable in chain order with Tab and Enter selects the focused one', async ({ page }) => {
    await openTask(page, FLAT_SLUG)

    await stageNode(page, 'planning').focus()
    await page.keyboard.press('Tab')
    await expect(stageNode(page, 'dev')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(stageNode(page, 'cr')).toBeFocused()

    await page.keyboard.press('Enter')
    await expect(stageNode(page, 'cr')).toHaveAttribute('aria-current', 'step')
    await expect(page).toHaveURL(/\?stage=cr$/)
  })

  test('the arrow keys move focus between nodes without selecting', async ({ page }) => {
    await openTask(page, FLAT_SLUG)

    await stageNode(page, 'dev').focus()
    await page.keyboard.press('ArrowRight')
    await expect(stageNode(page, 'cr')).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await expect(stageNode(page, 'planning')).toBeFocused()
    await expect(stageNode(page, 'dev')).toHaveAttribute('aria-current', 'step')
  })
})

test.describe('stage chain: small screens', () => {
  test.use({ viewport: MOBILE_VIEWPORT })

  test('the compact stepper replaces the flow and still drives selection', async ({ page }) => {
    await openTask(page, FLAT_SLUG)

    await expect(page.getByTestId('stepper-compact')).toBeVisible()
    await expect(page.getByTestId('stepper-wide')).toBeHidden()

    await page.getByTestId('stepper-next').click()
    await expect(page.getByTestId('stepper-position')).toHaveText(`3/${FLAT_VISIBLE_COUNT}`)
    await expect(page.locator('.l2-panel-title')).toHaveText('CR')
  })
})

test.describe('stage chain: degraded data', () => {
  test('a task with no TIMELINE still draws every node and says why nothing is done', async ({ page }) => {
    const pageErrors = collectPageErrors(page)
    // react-shell-live has a STATUS but no TIMELINE at all.
    await openTask(page, 'react-shell-live')

    await expect(stageFlow(page).locator('.react-flow__node')).toHaveCount(FLAT_VISIBLE_COUNT)
    await expect(page.getByTestId('stage-chain-no-data')).toBeVisible()
    await expect(stageFlow(page).locator('.stage-chain-node.is-done')).toHaveCount(0)
    expect(pageErrors, pageErrors.map(String).join('\n')).toEqual([])
  })
})

// STATUS as well as TIMELINE: which node is *current* follows the task's
// next-action (its waitingReason), not TIMELINE's last line — see
// defaultStageTab in web/src/pipelineStages.ts — so a real stage advance writes both, as the
// skills do.
async function advanceLiveFlatTaskToCodeReview() {
  const timeline = (await readTaskFile(LIVE_FLAT_SLUG, 'TIMELINE')) ?? ''
  await writeTaskFile(LIVE_FLAT_SLUG, 'TIMELINE', `${timeline}2026-08-10T12:00:00Z code-review round 1: 1 finding\n`)
  await writeTaskFile(LIVE_FLAT_SLUG, 'STATUS', 'waiting: PR open, ready for CR\n')
}

test.describe.serial('stage chain: live updates', () => {
  test('a stage advancing on disk moves the current node with no reload', async ({ page }) => {
    await withRestoredFixtureFiles(LIVE_FLAT_SLUG, ['STATUS', 'TIMELINE'], async () => {
      await openTask(page, LIVE_FLAT_SLUG)
      await expect(stageNode(page, 'dev')).toHaveAttribute('aria-current', 'step')
      const flowRoot = await stageFlow(page).elementHandle()

      await advanceLiveFlatTaskToCodeReview()

      await expect(stageNode(page, 'cr')).toHaveAttribute('aria-current', 'step', { timeout: LIVE_UPDATE_TIMEOUT_MS })
      await expect(stageNode(page, 'dev')).toHaveClass(/is-done/)
      // React reconciled the same flow in place rather than remounting it.
      expect(await flowRoot?.evaluate((el) => el.isConnected)).toBe(true)
    })
  })

  test('an explicitly selected node stays selected across a live update', async ({ page }) => {
    await withRestoredFixtureFiles(LIVE_FLAT_SLUG, ['STATUS', 'TIMELINE'], async () => {
      await openTask(page, LIVE_FLAT_SLUG)
      await stageNode(page, 'planning').click()
      await expect(stageNode(page, 'planning')).toHaveAttribute('aria-current', 'step')

      await advanceLiveFlatTaskToCodeReview()

      await expect(stageNode(page, 'dev')).toHaveClass(/is-done/, { timeout: LIVE_UPDATE_TIMEOUT_MS })
      await expect(stageNode(page, 'planning')).toHaveAttribute('aria-current', 'step')
      await expect(stageNode(page, 'cr')).toHaveAttribute('aria-current', 'false')
    })
  })
})

test.describe('milestone graph: waves and dependencies', () => {
  test('every declared milestone is one flow node, every dependency is one edge, every wave has a header', async ({ page }) => {
    const pageErrors = collectPageErrors(page)
    const consoleErrors = collectConsoleErrors(page)
    const milestones = declaredMilestones(LARGE_SLUG)
    const dependencyCount = milestones.reduce((sum, m) => sum + m.needs.length, 0)
    await openLargeParent(page)

    await expect(milestoneFlow(page).getByTestId('milestone-card')).toHaveCount(milestones.length)
    await expect(milestoneFlow(page).locator('.react-flow__edge')).toHaveCount(dependencyCount)
    await expect(milestoneFlow(page).getByTestId('wave-header')).toHaveCount(6)
    expect(pageErrors, pageErrors.map(String).join('\n')).toEqual([])
    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })

  test('a later wave sits entirely below the wave it depends on', async ({ page }) => {
    await openLargeParent(page)

    const wave2Header = await boxOf(page.locator('[data-testid="wave"][data-wave="2"]'))
    const wave1Card = await boxOf(milestoneCard(page, 'M0'))
    const wave2Card = await boxOf(milestoneCard(page, 'M1'))
    const wave3Header = await boxOf(page.locator('[data-testid="wave"][data-wave="3"]'))

    expect(wave2Header.y).toBeGreaterThanOrEqual(wave1Card.y + wave1Card.height)
    expect(wave2Card.y).toBeGreaterThanOrEqual(wave2Header.y + wave2Header.height)
    expect(wave3Header.y).toBeGreaterThanOrEqual(wave2Card.y + wave2Card.height)
  })

  test('each node keeps its existing status and action information', async ({ page }) => {
    await openLargeParent(page)

    await expect(milestoneCard(page, 'M0').locator('.card-status-label')).toHaveText('merged')
    await expect(milestoneCard(page, 'M1').locator('.card-status-label')).toHaveText('dev')
    await expect(milestoneCard(page, 'M2').locator('.card-status-label')).toHaveText('queued')
    await expect(milestoneCard(page, 'M2').getByTestId('milestone-start-dev-btn')).toBeVisible()
    await expect(milestoneCard(page, 'M16').locator('.ms-card-meta')).toContainText('M12, M13, M14, M15')

    // Run wave (n): M0 is merged and M1 already dispatched, so wave 1 has
    // nothing queued and wave 2 has M2..M5.
    const wave1Run = page.locator('[data-testid="wave"][data-wave="1"]').getByTestId('wave-batch-count')
    const wave2Run = page.locator('[data-testid="wave"][data-wave="2"]').getByTestId('wave-batch-count')
    await expect(wave1Run).toHaveText('0')
    await expect(wave2Run).toHaveText('4')
  })

  test('the project summary above the graph is untouched', async ({ page }) => {
    await openLargeParent(page)

    await expect(page.getByTestId('project-summary')).toBeVisible()
    await expect(page.getByTestId('milestone-progress-label')).toHaveText('1 of 20 milestones merged')
  })

  test('the flow is display-only: dragging a milestone moves nothing', async ({ page }) => {
    await openLargeParent(page)
    const card = milestoneCard(page, 'M2')
    const before = await boxOf(card)

    await page.mouse.move(before.x + 40, before.y + 12)
    await page.mouse.down()
    await page.mouse.move(before.x + 200, before.y + 90, { steps: 6 })
    await page.mouse.up()

    expect(await boxOf(card)).toEqual(before)
  })
})

test.describe('milestone graph: selection and drill-down', () => {
  test('clicking a node opens that milestone, and Back returns to the same graph', async ({ page }) => {
    await openLargeParent(page)

    await milestoneCard(page, 'M1').click()
    await expect(page.getByTestId('milestone-detail-head')).toBeVisible()
    await expect(page.getByTestId('milestone-detail-id')).toHaveText('M1')
    await expect(stageFlow(page).locator('.react-flow__node')).toHaveCount(MILESTONE_VISIBLE_COUNT)
    await expect(milestoneFlow(page)).toHaveCount(0)

    await page.getByTestId('milestone-parent-link').click()
    await expect(milestoneFlow(page).getByTestId('milestone-card')).toHaveCount(declaredMilestones(LARGE_SLUG).length)
  })

  test('a focused node opens with Enter and with Space', async ({ page }) => {
    await openLargeParent(page)

    await milestoneCard(page, 'M2').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('milestone-detail-id')).toHaveText('M2')

    await page.getByTestId('milestone-parent-link').click()
    await milestoneCard(page, 'M3').focus()
    await page.keyboard.press(' ')
    await expect(page.getByTestId('milestone-detail-id')).toHaveText('M3')
  })
})

test.describe.serial('milestone graph: live updates', () => {
  test('a milestone changing stage on disk updates its node in place, with no reload and no remount', async ({ page }) => {
    await withRestoredFixtureFiles(LARGE_LIVE_CHILD_SLUG, ['TIMELINE'], async () => {
      await openLargeParent(page)
      await expect(milestoneCard(page, 'M1').locator('.card-status-label')).toHaveText('dev')
      const flowNode = await page.locator('.react-flow__node[data-id="M1"]').elementHandle()

      const timeline = (await readTaskFile(LARGE_LIVE_CHILD_SLUG, 'TIMELINE')) ?? ''
      await writeTaskFile(LARGE_LIVE_CHILD_SLUG, 'TIMELINE', `${timeline}2026-08-10T15:00:00Z code-review round 1: 2 findings\n`)

      await expect(milestoneCard(page, 'M1').locator('.card-status-label')).toHaveText('code review', { timeout: LIVE_UPDATE_TIMEOUT_MS })
      await expect(milestoneFlow(page).getByTestId('milestone-card')).toHaveCount(declaredMilestones(LARGE_SLUG).length)
      expect(await flowNode?.evaluate((el) => el.isConnected)).toBe(true)
    })
  })

  test('an open drill-down and its selected stage survive a live update', async ({ page }) => {
    await withRestoredFixtureFiles(LARGE_LIVE_CHILD_SLUG, ['TIMELINE'], async () => {
      await openLargeParent(page)
      await milestoneCard(page, 'M1').click()
      await stageNode(page, 'qa').click()
      await expect(stageNode(page, 'qa')).toHaveAttribute('aria-current', 'step')

      const timeline = (await readTaskFile(LARGE_LIVE_CHILD_SLUG, 'TIMELINE')) ?? ''
      await writeTaskFile(LARGE_LIVE_CHILD_SLUG, 'TIMELINE', `${timeline}2026-08-10T15:00:00Z code-review round 1: 2 findings\n`)

      await expect(stageNode(page, 'dev')).toHaveClass(/is-done/, { timeout: LIVE_UPDATE_TIMEOUT_MS })
      await expect(page.getByTestId('milestone-detail-id')).toHaveText('M1')
      await expect(stageNode(page, 'qa')).toHaveAttribute('aria-current', 'step')
    })
  })
})

test.describe('milestone graph: small screens', () => {
  test.use({ viewport: MOBILE_VIEWPORT })

  test('a large milestone set stacks into the viewport with no horizontal page scroll', async ({ page }) => {
    await openLargeParent(page)

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)

    const cards = await milestoneFlow(page).getByTestId('milestone-card').all()
    expect(cards).toHaveLength(declaredMilestones(LARGE_SLUG).length)
    for (const card of cards) {
      const box = await boxOf(card)
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(MOBILE_VIEWPORT.width)
    }
  })

  test('a node is still tappable and the wave header keeps its Run wave button in reach', async ({ page }) => {
    await openLargeParent(page)

    const runWave = page.locator('[data-testid="wave"][data-wave="2"]').getByTestId('wave-batch-btn')
    await runWave.scrollIntoViewIfNeeded()
    const runBox = await boxOf(runWave)
    expect(runBox.x + runBox.width).toBeLessThanOrEqual(MOBILE_VIEWPORT.width)

    await milestoneCard(page, 'M2').scrollIntoViewIfNeeded()
    await milestoneCard(page, 'M2').click()
    await expect(page.getByTestId('milestone-detail-id')).toHaveText('M2')
  })
})

// Run wave is disabled on a non-canonical instance (the shared webServer never
// sets COCKPIT_DISPATCH_ENABLED), so this block runs its own canonical one —
// see batch-dispatch-staging.spec.ts, which does the same. /batch-dispatch is
// always stubbed: nothing here reaches a real orchestrator.
test.describe('milestone graph: Run wave lifecycle', () => {
  let canonicalUrl: string
  test.beforeAll(async () => { canonicalUrl = await startCanonicalServer() })
  test.afterAll(async () => { await stopCanonicalServer(canonicalUrl) })

  const wave2Run = (page: Page) => page.locator('[data-testid="wave"][data-wave="2"]').getByTestId('wave-batch-btn')

  async function openCanonicalLargeParent(page: Page) {
    await page.goto(`${canonicalUrl}/task/${LARGE_SLUG}`)
    await expect(milestoneFlow(page)).toBeVisible()
  }

  test('a batch in flight disables the React-owned button, and finishing re-enables it', async ({ page }) => {
    let releaseResponse: () => void = () => {}
    const held = new Promise<void>((resolve) => { releaseResponse = resolve })
    await page.route('**/batch-dispatch', async (route) => {
      await held
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    })
    await openCanonicalLargeParent(page)
    await expect(wave2Run(page)).toBeEnabled()

    await wave2Run(page).click()
    await expect(wave2Run(page)).toBeDisabled()
    await expect(wave2Run(page)).toHaveAttribute('title', /Staging wave 2/)

    releaseResponse()
    await expect(wave2Run(page)).toBeEnabled()
    await expect(milestoneCard(page, 'M2').getByTestId('ms-dispatch-status')).toHaveText('staged')
  })

  test('a rejected batch re-enables the button so it is one click to retry', async ({ page }) => {
    await page.route('**/batch-dispatch', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }))
    await openCanonicalLargeParent(page)

    await wave2Run(page).click()

    await expect(milestoneCard(page, 'M2').getByTestId('ms-dispatch-status')).not.toBeEmpty()
    await expect(wave2Run(page)).toBeEnabled()
  })
})

test.describe('milestone graph: degraded data', () => {
  test('a fan-out parent with no dispatched children still draws every queued node and its edges', async ({ page }) => {
    const pageErrors = collectPageErrors(page)
    await page.goto('/task/fanout-parent')

    const milestones = declaredMilestones('fanout-parent')
    await expect(milestoneFlow(page).getByTestId('milestone-card')).toHaveCount(milestones.length)
    await expect(milestoneFlow(page).locator('.react-flow__edge')).toHaveCount(milestones.reduce((sum, m) => sum + m.needs.length, 0))
    expect(pageErrors, pageErrors.map(String).join('\n')).toEqual([])
  })

  test('a parent that is still planning has no milestone graph to draw and does not crash', async ({ page }) => {
    const pageErrors = collectPageErrors(page)
    await page.goto('/task/plan-summary-parent')

    await expect(page.getByTestId('task-detail')).toBeVisible()
    await expect(milestoneFlow(page)).toHaveCount(0)
    expect(pageErrors, pageErrors.map(String).join('\n')).toEqual([])
  })
})
