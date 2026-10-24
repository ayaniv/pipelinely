import { test, expect, type Locator, type Page, type Request } from '@playwright/test'
import { DESKTOP, cssOf } from './fixtures/designTokens'
import {
  MIN_EFFECTIVE_TEXT_PX,
  edgeLabelCrossings,
  effectiveTextSizes,
  flowViewportTransform,
  flowZoom,
  resolvedColor,
} from './fixtures/flowGeometry'
import type { SnapshotShape } from './fixtures/snapshotStub'
import { openParent, setParentField, type MilestoneFixtureState } from './fixtures/waveSnapshots'

// dashboard-v4-inner-view M2 — the Dev wave graph and Run next wave
// (REQUEST-v4.md §3, §4, §5; Pipelinely Pipeline.dc.html ?stage=dev,
// PipelineFlow.jsx's WaveFlow). On a fan-out parent with Dev selected, the
// panel shows a React Flow graph — the task's creature blob as the root, wave
// circles on a spine, milestone circles branching off each wave — in place of
// the old milestone wave list. There is no graph/list toggle.
//
// Fixtures: wave-batch-parent declares M0 (wave 1), M1 and M2 (wave 2) and M3
// (wave 3), with only a done -m0 child on disk; pipeline-graph-large has five
// milestones in wave 2. Every other state is set in the served snapshot by
// fixtures/waveSnapshots.ts. Run next wave's POST /batch-dispatch is always
// intercepted: nothing reaches the orchestrator.

test.use({ colorScheme: 'light', viewport: DESKTOP })

const PARENT = 'wave-batch-parent'
const LARGE = 'pipeline-graph-large'
const NARROW_760 = { width: 760, height: 900 }
const CREATURE = { name: 'Pip', color: '#c9b8e8', shape: '42% 58% 55% 45% / 48% 44% 56% 52%' }
// REQUEST-v4.md §3 geometry, in flow units.
const ROOT_SIZE = 84
const WAVE_SIZE = 54
const CARD_SIZE = 42
const WAVE_SPACING = 215
const CARD_OFFSET_X = 100
const FIRST_ROW = 118
const ROW_STEP = 110
const ROW_SHIFT = 18
const PAD = 28

const devStage = (page: Page) => page.getByTestId('stage-chain-dev')
const graph = (page: Page) => page.getByTestId('wave-graph')
const root = (page: Page) => page.getByTestId('wave-root')
const wave = (page: Page, n: number) => page.getByTestId(`wave-node-${n}`)
const card = (page: Page, id: string) => page.getByTestId(`wave-task-${id}`)
const runNext = (page: Page) => page.getByTestId('run-next-wave-btn')
const circleOf = (node: Locator) => node.getByTestId('wave-circle')

async function openDev(page: Page, parentSlug: string, states: Record<string, MilestoneFixtureState> = {}, extra?: (snapshot: SnapshotShape) => void) {
  await openParent(page, parentSlug, states, extra)
  await devStage(page).click()
  await expect(graph(page)).toBeVisible()
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error('element has no bounding box — is it rendered and visible?')
  return box
}

const centre = async (locator: Locator) => {
  const box = await boxOf(locator)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

// Records every POST /batch-dispatch and answers it with `status`, so a click
// on Run next wave is observable without staging anything for real.
async function stubBatchDispatch(page: Page, status = 200): Promise<Request[]> {
  const calls: Request[] = []
  await page.route('**/batch-dispatch', async (route) => {
    calls.push(route.request())
    await route.fulfill({ status, body: '' })
  })
  return calls
}

test.describe('the Dev panel on a parent is the wave graph', () => {
  test('selecting Dev shows the graph in place of the wave list, with no graph/list toggle', async ({ page }) => {
    await openDev(page, PARENT)
    await expect(page.getByTestId('milestone-flow')).toHaveCount(0)
    await expect(page.getByTestId('wave-view-toggle')).toHaveCount(0)
  })

  test('the header has the title and meta line on the left and one Run next wave button on the right', async ({ page }) => {
    await openDev(page, PARENT)
    const header = page.getByTestId('wave-panel-header')
    await expect(header.getByTestId('wave-panel-title')).toBeVisible()
    await expect(header.getByTestId('wave-panel-meta')).toBeVisible()
    await expect(header.getByTestId('run-next-wave-btn')).toHaveCount(1)
    const [title, button] = [await boxOf(header.getByTestId('wave-panel-title')), await boxOf(runNext(page))]
    expect(button.x).toBeGreaterThan(title.x + title.width)
    await expect(runNext(page).getByTestId('run-next-wave-icon')).toBeVisible()
    expect(await cssOf(runNext(page), 'background-color')).toBe(await resolvedColor(page, 'var(--ink)'))
  })

  test('on the active Dev view the status pill and the footer are gone', async ({ page }) => {
    await openDev(page, PARENT)
    await expect(page.getByTestId('l2-panel-pill')).toHaveCount(0)
    await expect(page.getByTestId('detail-panel-footer')).toHaveCount(0)
  })

  test('other stages keep their pill and footer', async ({ page }) => {
    await page.goto('/task/dev-ready?stage=cr')
    await expect(page.getByTestId('l2-panel-pill')).toBeVisible()
    await expect(page.getByTestId('detail-panel-footer')).toBeVisible()
  })
})

test.describe('root, waves and task cards', () => {
  test('the root is an 84px blob in the task\'s creature colour and shape, with two eyes, its title and "name · branch"', async ({ page }) => {
    await openDev(page, PARENT, {}, (snapshot) => setParentField(snapshot, PARENT, { creature: CREATURE }))
    // The blob IS v3 M3's <Creature> at 84px (QUESTIONS.md #20), not a second
    // drawing of it: same body, visor and eyes as the card and header.
    const blob = root(page).getByTestId('wave-root-blob')
    const body = blob.getByTestId('creature')
    const zoom = await flowZoom(graph(page))
    expect((await boxOf(blob)).width / zoom).toBeCloseTo(ROOT_SIZE, 0)
    expect((await boxOf(body)).width / zoom).toBeCloseTo(ROOT_SIZE, 0)
    await expect(body).toHaveAttribute('data-name', CREATURE.name)
    expect(await cssOf(body, 'background-color')).toBe(await resolvedColor(page, CREATURE.color))
    expect(await cssOf(body, 'border-top-left-radius')).not.toBe('50%')
    await expect(body.getByTestId('creature-eye')).toHaveCount(2)
    const branch = await page.evaluate(async (slug) => {
      const snapshot = await fetch('/api/tasks').then((r) => r.json())
      return (snapshot.tasks as Array<{ slug: string; branch: string }>).find((t) => t.slug === slug)!.branch
    }, PARENT)
    await expect(root(page).getByTestId('wave-root-sub')).toHaveText(`${CREATURE.name} · ${branch}`)
    expect(await cssOf(root(page).getByTestId('wave-root-title'), '-webkit-line-clamp')).toBe('2')
  })

  test('with no creature the root falls back to a plain dev-coloured blob and the branch alone', async ({ page }) => {
    await openDev(page, PARENT, {}, (snapshot) => setParentField(snapshot, PARENT, { creature: null }))
    expect(await cssOf(root(page).getByTestId('wave-root-blob'), 'background-color')).toBe(await resolvedColor(page, 'var(--devC)'))
    await expect(root(page).getByTestId('creature')).toHaveCount(0)
    await expect(root(page).getByTestId('wave-root-sub')).not.toContainText(' · ')
  })

  test('a complete wave is sage with a check and "complete"; the next is running with its number, a halo and "X of Y done"', async ({ page }) => {
    await openDev(page, PARENT, { M1: 'working' })
    await expect(wave(page, 1)).toHaveAttribute('data-state', 'complete')
    expect(await cssOf(circleOf(wave(page, 1)), 'background-color')).toBe(await resolvedColor(page, 'var(--sage)'))
    await expect(wave(page, 1).getByTestId('wave-check')).toBeVisible()
    await expect(wave(page, 1).getByTestId('wave-sub')).toHaveText('complete')

    await expect(wave(page, 2)).toHaveAttribute('data-state', 'running')
    expect(await cssOf(circleOf(wave(page, 2)), 'background-color')).toBe(await resolvedColor(page, 'var(--devC)'))
    await expect(wave(page, 2).getByTestId('wave-number')).toHaveText('2')
    expect(await cssOf(wave(page, 2).getByTestId('wave-halo'), 'background-color')).toBe(await resolvedColor(page, 'var(--devSoft)'))
    await expect(wave(page, 2).getByTestId('wave-sub')).toHaveText('0 of 2 done')
    expect((await boxOf(circleOf(wave(page, 2)))).width / await flowZoom(graph(page))).toBeCloseTo(WAVE_SIZE, 0)
  })

  test('a wave whose previous wave is not complete is locked: surface fill, dashed border, lock, "starts after wave N−1"', async ({ page }) => {
    await openDev(page, PARENT, { M1: 'working' })
    const locked = wave(page, 3)
    await expect(locked).toHaveAttribute('data-state', 'locked')
    expect(await cssOf(circleOf(locked), 'background-color')).toBe(await resolvedColor(page, 'var(--surface)'))
    expect(await cssOf(circleOf(locked), 'border-top-style')).toBe('dashed')
    expect(await cssOf(circleOf(locked), 'border-top-width')).toBe('2px')
    await expect(locked.getByTestId('wave-lock')).toBeVisible()
    await expect(locked.getByTestId('wave-sub')).toHaveText('starts after wave 2')
  })

  test('task cards are 42px circles coloured by status, each with "id · status" under its title', async ({ page }) => {
    await openDev(page, PARENT, { M1: 'review', M2: 'working' })
    const zoom = await flowZoom(graph(page))
    await expect(card(page, 'M0')).toHaveAttribute('data-status', 'merged')
    expect(await cssOf(circleOf(card(page, 'M0')), 'background-color')).toBe(await resolvedColor(page, 'var(--sage)'))
    await expect(card(page, 'M1')).toHaveAttribute('data-status', 'review')
    expect(await cssOf(circleOf(card(page, 'M1')), 'background-color')).toBe(await resolvedColor(page, 'var(--crC)'))
    await expect(card(page, 'M1').getByTestId('wave-halo')).toBeVisible()
    await expect(card(page, 'M2')).toHaveAttribute('data-status', 'working')
    expect(await cssOf(circleOf(card(page, 'M2')), 'background-color')).toBe(await resolvedColor(page, 'var(--devC)'))
    await expect(card(page, 'M2').getByTestId('wave-pulse-dot')).toHaveCount(3)
    await expect(card(page, 'M3')).toHaveAttribute('data-status', 'queued')
    expect(await cssOf(circleOf(card(page, 'M3')), 'border-top-style')).toBe('dashed')
    await expect(card(page, 'M3').getByTestId('wave-task-id')).toHaveText('M3')

    expect((await boxOf(circleOf(card(page, 'M1')))).width / zoom).toBeCloseTo(CARD_SIZE, 0)
    expect((await boxOf(card(page, 'M1').getByTestId('flow-label-block'))).width / zoom).toBeCloseTo(130, 0)
    await expect(card(page, 'M1').getByTestId('wave-task-sub')).toContainText('M1 · in review')
    expect(await cssOf(card(page, 'M1').getByTestId('wave-task-title'), '-webkit-line-clamp')).toBe('2')
  })

  test('clicking a dispatched or merged card opens that milestone\'s own task page', async ({ page }) => {
    await openDev(page, PARENT)
    await card(page, 'M0').click()
    await expect(page).toHaveURL(/\/task\/wave-batch-parent-m0(\?|$)/)
  })

  test('clicking a queued card opens its milestone detail, where Start dev still lives', async ({ page }) => {
    await openDev(page, PARENT)
    await card(page, 'M1').click()
    await expect(page.getByTestId('milestone-detail-head-slot')).toBeVisible()
  })
})

test.describe('layout', () => {
  test('the root sits at x=0 and each wave 215px further along one spine', async ({ page }) => {
    await openDev(page, PARENT, { M1: 'working' })
    const zoom = await flowZoom(graph(page))
    const rootCentre = await centre(root(page).getByTestId('wave-root-blob'))
    const waves = await Promise.all([1, 2, 3].map((n) => centre(circleOf(wave(page, n)))))
    expect((waves[0].x - rootCentre.x) / zoom).toBeCloseTo(WAVE_SPACING, 0)
    expect((waves[1].x - waves[0].x) / zoom).toBeCloseTo(WAVE_SPACING, 0)
    expect(new Set([rootCentre.y, ...waves.map((w) => w.y)].map((y) => Math.round(y))).size).toBe(1)
  })

  test('one task sits below its wave, 100px right and 118px off the spine', async ({ page }) => {
    await openDev(page, PARENT)
    const zoom = await flowZoom(graph(page))
    const waveCentre = await centre(circleOf(wave(page, 1)))
    const only = await centre(circleOf(card(page, 'M0')))
    await expect(card(page, 'M0')).toHaveAttribute('data-side', 'below')
    expect((only.x - waveCentre.x) / zoom).toBeCloseTo(CARD_OFFSET_X, 0)
    expect((only.y - waveCentre.y) / zoom).toBeCloseTo(FIRST_ROW, 0)
  })

  test('two tasks split one above, one below', async ({ page }) => {
    await openDev(page, PARENT)
    await expect(card(page, 'M1')).toHaveAttribute('data-side', 'above')
    await expect(card(page, 'M2')).toHaveAttribute('data-side', 'below')
  })

  test('four tasks split two and two; each extra row is 110px further out and 18px further right', async ({ page }) => {
    await openDev(page, LARGE)
    const zoom = await flowZoom(graph(page))
    const sides = await Promise.all(['M1', 'M2', 'M3', 'M4'].map((id) => card(page, id).getAttribute('data-side')))
    expect(sides).toEqual(['above', 'above', 'below', 'below'])
    const [outerAbove, innerAbove] = await Promise.all(['M1', 'M2'].map((id) => centre(circleOf(card(page, id)))))
    expect((innerAbove.y - outerAbove.y) / zoom).toBeCloseTo(ROW_STEP, 0)
    expect((outerAbove.x - innerAbove.x) / zoom).toBeCloseTo(ROW_SHIFT, 0)
  })

  test('a wave of five or more shows four tasks and a "+N more" circle that expands it in place', async ({ page }) => {
    await openDev(page, LARGE)
    await expect(card(page, 'M5')).toHaveCount(0)
    const more = page.getByTestId('wave-more-2')
    await expect(more).toHaveAttribute('data-count', '1')
    await more.click()
    await expect(card(page, 'M5')).toBeVisible()
    await expect(more).toHaveCount(0)
  })

  test('the box height is the scaled content height plus padding, so it grows with the busiest wave', async ({ page }) => {
    await openDev(page, PARENT)
    const small = await graph(page).evaluate((el) => el.clientHeight)
    await openDev(page, LARGE)
    const large = await graph(page).evaluate((el) => el.clientHeight)
    expect(large).toBeGreaterThan(small)
    const zoom = await flowZoom(graph(page))
    const contentHeight = Number(await graph(page).getAttribute('data-content-height'))
    expect(Math.abs(large - Math.round(contentHeight * zoom + 2 * PAD))).toBeLessThanOrEqual(1)
  })
})

test.describe('edges', () => {
  test('the spine runs root → wave 1 → wave 2 → wave 3, and links between waves are labelled "then" in 10.5px mono --text3', async ({ page }) => {
    await openDev(page, PARENT, { M1: 'working' })
    for (const id of ['root-w1', 'w1-w2', 'w2-w3']) await expect(graph(page).locator(`path[data-testid="flow-edge"][data-edge-id="${id}"]`)).toHaveCount(1)
    const labels = graph(page).getByTestId('wave-edge-label')
    await expect(labels).toHaveCount(2)
    expect(await cssOf(labels.first(), 'font-size')).toBe('10.5px')
    expect(await cssOf(labels.first(), 'fill')).toBe(await resolvedColor(page, 'var(--text3)'))
  })

  test('a locked wave\'s incoming link is dashed and dimmed; queued branches are dashed 4 5', async ({ page }) => {
    await openDev(page, PARENT, { M1: 'working' })
    const lockedLink = graph(page).locator('path[data-testid="flow-edge"][data-edge-id="w2-w3"]')
    expect(await cssOf(lockedLink, 'stroke-dasharray')).toBe('6px, 6px')
    await expect(lockedLink).toHaveAttribute('data-dim', 'true')
    const queuedBranch = graph(page).locator('path[data-testid="flow-edge"][data-edge-id="w2-M2"]')
    expect(await cssOf(queuedBranch, 'stroke-dasharray')).toBe('4px, 5px')
    expect(await cssOf(graph(page).locator('path[data-testid="flow-edge"][data-edge-id="w1-w2"]'), 'stroke-width')).toBe('2.5px')
    expect(await cssOf(graph(page).locator('path[data-testid="flow-edge"][data-edge-id="w1-M0"]'), 'stroke-width')).toBe('1.8px')
  })

  test('upper tasks leave from the wave\'s top, lower ones from below its label block, and every task is entered from its left', async ({ page }) => {
    await openDev(page, PARENT)
    const ends = (edgeId: string) => graph(page).locator(`path[data-testid="flow-edge"][data-edge-id="${edgeId}"]`).evaluate((el) => {
      const path = el as SVGPathElement
      const matrix = path.getScreenCTM()!
      const at = (length: number) => new DOMPoint(path.getPointAtLength(length).x, path.getPointAtLength(length).y).matrixTransform(matrix)
      const start = at(0)
      const end = at(path.getTotalLength())
      return { start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y } }
    })
    const waveCircle = await boxOf(circleOf(wave(page, 2)))
    const waveLabel = await boxOf(wave(page, 2).getByTestId('flow-label-block'))
    const up = await ends('w2-M1')
    const down = await ends('w2-M2')
    expect(up.start.y).toBeLessThanOrEqual(waveCircle.y + 1)
    expect(down.start.y).toBeGreaterThanOrEqual(waveLabel.y + waveLabel.height - 1)
    for (const [id, edgeEnds] of [['M1', up], ['M2', down]] as const) {
      const target = await boxOf(circleOf(card(page, id)))
      expect(edgeEnds.end.x).toBeLessThanOrEqual(target.x + 1)
    }
  })

  for (const viewport of [DESKTOP, NARROW_760]) {
    test(`no edge crosses a label at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await openDev(page, LARGE)
      expect(await edgeLabelCrossings(graph(page))).toEqual([])
    })
  }
})

test.describe('viewport and interaction', () => {
  test('when it fits it is centred with no right-edge fade', async ({ page }) => {
    await openDev(page, PARENT)
    await expect(graph(page)).toHaveAttribute('data-fits', 'true')
    await expect(page.getByTestId('wave-graph-fade')).toHaveCount(0)
  })

  test('when it does not fit it centres on the first wave that is not complete and fades the right edge', async ({ page }) => {
    await page.setViewportSize(NARROW_760)
    await openDev(page, LARGE)
    await expect(graph(page)).toHaveAttribute('data-fits', 'false')
    await expect(page.getByTestId('wave-graph-fade')).toBeVisible()
    const box = await boxOf(graph(page))
    const focus = await centre(circleOf(wave(page, 2)))
    expect(Math.abs(focus.x - (box.x + box.width / 2))).toBeLessThanOrEqual(2)
  })

  test('no text in the graph renders below 10px effective size at 760px', async ({ page }) => {
    await page.setViewportSize(NARROW_760)
    await openDev(page, LARGE, { M1: 'review' })
    const small = (await effectiveTextSizes(graph(page))).filter((sample) => sample.effectivePx < MIN_EFFECTIVE_TEXT_PX)
    expect(small).toEqual([])
  })

  test('nodes can be dragged, but positions do not survive reopening the task', async ({ page }) => {
    await openDev(page, PARENT)
    // page.mouse does not scroll: at 900px tall the card sits below the fold.
    await circleOf(card(page, 'M0')).scrollIntoViewIfNeeded()
    const before = await boxOf(circleOf(card(page, 'M0')))
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
    await page.mouse.down()
    await page.mouse.move(before.x + before.width / 2 + 60, before.y + before.height / 2 + 30, { steps: 6 })
    await page.mouse.up()
    const moved = await boxOf(circleOf(card(page, 'M0')))
    expect(moved.x).toBeGreaterThan(before.x + 30)

    await openDev(page, PARENT)
    const reopened = await boxOf(circleOf(card(page, 'M0')))
    expect(Math.abs(reopened.x - before.x)).toBeLessThanOrEqual(1)
  })

  test('a graph that fits does not pan until it is zoomed in, and then it does', async ({ page }) => {
    await openDev(page, PARENT)
    await expect(graph(page)).toHaveAttribute('data-fits', 'true')
    const dragAcrossPane = async () => {
      const box = await boxOf(graph(page))
      await page.mouse.move(box.x + 12, box.y + 12)
      await page.mouse.down()
      await page.mouse.move(box.x + 92, box.y + 52, { steps: 6 })
      await page.mouse.up()
    }

    const fitted = await flowViewportTransform(graph(page))
    await dragAcrossPane()
    expect(await flowViewportTransform(graph(page))).toBe(fitted)

    const before = await flowZoom(graph(page))
    await page.getByTestId('wave-graph-zoom-in').click()
    await expect.poll(() => flowZoom(graph(page))).toBeGreaterThan(before)
    const zoomed = await flowViewportTransform(graph(page))
    await dragAcrossPane()
    await expect.poll(() => flowViewportTransform(graph(page))).not.toBe(zoomed)
  })

  test('the wheel scrolls the page, not the graph\'s zoom', async ({ page }) => {
    await openDev(page, PARENT)
    const transform = await flowViewportTransform(graph(page))
    const box = await boxOf(graph(page))
    await page.mouse.move(box.x + 10, box.y + box.height / 2)
    await page.mouse.wheel(0, 120)
    expect(await flowViewportTransform(graph(page))).toBe(transform)
  })

  test('zoom in, zoom out and fit sit top-right with no lock button, and zoom in zooms', async ({ page }) => {
    await openDev(page, PARENT)
    const controls = page.getByTestId('wave-graph-controls')
    const [box, controlsBox] = [await boxOf(graph(page)), await boxOf(controls)]
    expect(controlsBox.y - box.y).toBeLessThan(40)
    expect(box.x + box.width - (controlsBox.x + controlsBox.width)).toBeLessThan(40)
    await expect(controls.locator('.react-flow__controls-interactive')).toHaveCount(0)
    const before = await flowZoom(graph(page))
    await page.getByTestId('wave-graph-zoom-in').click()
    await expect.poll(() => flowZoom(graph(page))).toBeGreaterThan(before)
    await expect(page.getByTestId('wave-graph-zoom-out')).toBeVisible()
    await expect(page.getByTestId('wave-graph-fit')).toBeVisible()
    expect(await cssOf(page.getByTestId('wave-graph-zoom-in'), 'background-color')).toBe(await resolvedColor(page, 'var(--surface)'))
  })
})

test.describe('Run next wave', () => {
  test('starts the first wave that is not complete: one batch for its queued, unblocked milestones', async ({ page }) => {
    const calls = await stubBatchDispatch(page)
    await openDev(page, PARENT)
    await expect(runNext(page)).toBeEnabled()
    await expect(runNext(page)).toHaveAttribute('data-wave', '2')
    await runNext(page).click()
    await expect.poll(() => calls.length).toBe(1)
    expect(calls[0].postDataJSON()).toEqual({ kind: 'wave', slugs: ['wave-batch-parent-m1', 'wave-batch-parent-m2'] })
  })

  test('is disabled while an earlier wave is unfinished, with "Waiting on wave N · M1 in review"', async ({ page }) => {
    const calls = await stubBatchDispatch(page)
    await openDev(page, PARENT, { M1: 'review', M2: 'merged' })
    await expect(runNext(page)).toBeDisabled()
    await expect(runNext(page)).toHaveAttribute('title', 'Waiting on wave 2 · M1 in review')
    await runNext(page).click({ force: true })
    expect(calls).toEqual([])
  })

  test('names every unfinished milestone of the blocking wave in the tooltip', async ({ page }) => {
    await openDev(page, PARENT, { M1: 'review', M2: 'qa' })
    await expect(runNext(page)).toHaveAttribute('title', 'Waiting on wave 2 · M1 in review, M2 in QA')
  })

  test('is disabled on a read-only (non-canonical) dashboard', async ({ page }) => {
    await openDev(page, PARENT, {}, (snapshot) => { snapshot.isCanonical = false })
    await expect(runNext(page)).toBeDisabled()
  })

  test('is disabled once every wave is merged', async ({ page }) => {
    await openDev(page, PARENT, { M1: 'merged', M2: 'merged', M3: 'merged' })
    await expect(runNext(page)).toBeDisabled()
  })

  test('a refused batch is reported on the button\'s status line and the button can be used again', async ({ page }) => {
    await stubBatchDispatch(page, 409)
    await openDev(page, PARENT)
    await runNext(page).click()
    await expect(page.getByTestId('run-next-wave-status')).toHaveAttribute('data-ok', 'false')
    await expect(runNext(page)).toBeEnabled()
  })
})

test.describe('dark mode by token swap only', () => {
  test.use({ colorScheme: 'dark' })

  test('wave and card fills, halos, the controls and the box resolve to the dark theme\'s tokens', async ({ page }) => {
    await openDev(page, PARENT, { M1: 'review' })
    expect(await cssOf(circleOf(wave(page, 1)), 'background-color')).toBe(await resolvedColor(page, 'var(--sage)'))
    expect(await cssOf(circleOf(card(page, 'M1')), 'background-color')).toBe(await resolvedColor(page, 'var(--crC)'))
    expect(await cssOf(card(page, 'M1').getByTestId('wave-halo'), 'background-color')).toBe(await resolvedColor(page, 'var(--crSoft)'))
    expect(await cssOf(graph(page), 'background-color')).toBe(await resolvedColor(page, 'var(--surface)'))
    expect(await cssOf(page.getByTestId('wave-graph-zoom-in'), 'background-color')).toBe(await resolvedColor(page, 'var(--surface)'))
    expect(await resolvedColor(page, 'var(--surface)')).not.toBe('rgb(255, 255, 255)')
  })

  test('every gradient stop in the graph is a token, not a literal', async ({ page }) => {
    await openDev(page, PARENT, { M1: 'review' })
    const literalStops = await graph(page).locator('linearGradient stop').evaluateAll((stops) =>
      stops.map((stop) => stop.getAttribute('style') ?? stop.getAttribute('stop-color') ?? '').filter((value) => /#[0-9a-f]{3,8}\b|rgb\(/i.test(value)))
    expect(literalStops).toEqual([])
  })
})
