import { test, expect, type Locator, type Page } from '@playwright/test'
import { DESKTOP, cssOf } from './fixtures/designTokens'
import {
  MIN_EFFECTIVE_TEXT_PX,
  edgeLabelCrossings,
  effectiveTextSizes,
  flowViewportTransform,
  flowZoom,
  readMountMarker,
  resolvedColor,
  setMountMarker,
} from './fixtures/flowGeometry'
import { pushSnapshot } from './fixtures/snapshotStub'
import { openParent, setMilestoneState } from './fixtures/waveSnapshots'

// dashboard-v4-inner-view M1 — the pipeline chart (REQUEST-v4.md §2 and §5;
// Pipelinely Pipeline.dc.html, PipelineFlow.jsx's PipelineFlow). The old
// dot-and-line rail (StageChainGraph's wide React Flow row) becomes five
// circle stage nodes with gradient edges, a coral rework loop and a viewport
// worked out by hand. A fan-out parent gets the same chart in place of its
// Plan / Plan Review / Dev tabs (QUESTIONS.md #5).
//
// Node ids and the `stage-chain-<id>` testids are kept from the old rail, so
// the selection, URL and v3 `data-task-stage` contracts other specs rely on
// still hold.

test.use({ colorScheme: 'light', viewport: DESKTOP })

const FLAT = 'dev-ready'
const MILESTONE_CHILD = 'fanout-parent-m0'
const PARENT = 'wave-batch-parent'
const NARROW_760 = { width: 760, height: 900 }
const FLAT_STAGES = ['planning', 'dev', 'cr', 'qa', 'merge'] as const
const CHILD_STAGES = ['dev', 'cr', 'qa', 'merge'] as const
// REQUEST-v4.md §2: 150px node, 50px circle, 24px chart padding, content
// height ~108px, ~144px with a rework loop.
const NODE_WIDTH = 150
const CIRCLE = 50
const PAD = 24
const CONTENT_HEIGHT = 108
const CONTENT_HEIGHT_WITH_LOOP = 144
const STAGE_TOKEN: Record<string, string> = { planning: 'plan', dev: 'dev', cr: 'cr', qa: 'qa', merge: 'merge' }

const chart = (page: Page) => page.getByTestId('pipeline-chart')
const stageNode = (page: Page, id: string) => page.getByTestId(`stage-chain-${id}`)
const circleOf = (page: Page, id: string) => stageNode(page, id).getByTestId('stage-node-circle')
const edge = (page: Page, source: string, target: string) => chart(page).locator(`path[data-testid="flow-edge"][data-edge-id="${source}-${target}"]`)

async function openFlat(page: Page, slug = FLAT) {
  await page.goto(`/task/${slug}`)
  await expect(chart(page)).toBeVisible()
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error('element has no bounding box — is it rendered and visible?')
  return box
}

async function centreX(locator: Locator): Promise<number> {
  const box = await boxOf(locator)
  return box.x + box.width / 2
}

// The chart box's inner width: what the viewport maths is computed against.
async function chartInnerWidth(page: Page): Promise<number> {
  return chart(page).evaluate((el) => el.clientWidth)
}

test.describe('flat task: five circle stage nodes', () => {
  test('draws Planning → Dev → Code review → QA → Merge as React Flow nodes chained by four gradient edges, with no page errors', async ({ page }) => {
    const errors: Error[] = []
    page.on('pageerror', (err) => errors.push(err))
    await openFlat(page)

    for (const id of FLAT_STAGES) await expect(stageNode(page, id)).toBeVisible()
    const xs = await Promise.all(FLAT_STAGES.map((id) => centreX(circleOf(page, id))))
    expect([...xs].sort((a, b) => a - b)).toEqual(xs)
    for (let i = 1; i < FLAT_STAGES.length; i++) await expect(edge(page, FLAT_STAGES[i - 1], FLAT_STAGES[i])).toHaveCount(1)
    expect(errors).toEqual([])
  })

  test('each node is 150px wide with a 50px circle and a label block below it', async ({ page }) => {
    await openFlat(page)
    const zoom = await flowZoom(chart(page))
    for (const id of FLAT_STAGES) {
      expect((await boxOf(stageNode(page, id))).width / zoom).toBeCloseTo(NODE_WIDTH, 0)
      const circle = await boxOf(circleOf(page, id))
      expect(circle.width / zoom).toBeCloseTo(CIRCLE, 0)
      expect(circle.height / zoom).toBeCloseTo(CIRCLE, 0)
      const label = await boxOf(stageNode(page, id).getByTestId('flow-label-block'))
      expect(label.y).toBeGreaterThanOrEqual(circle.y + circle.height)
    }
  })

  test('the task\'s own stage is "current": filled with its stage colour, three pulsing white dots and a breathing halo', async ({ page }) => {
    await openFlat(page)
    const current = stageNode(page, 'dev')
    await expect(current).toHaveAttribute('data-state', 'current')
    await expect(current).toHaveAttribute('data-task-stage', 'true')
    expect(await cssOf(circleOf(page, 'dev'), 'background-color')).toBe(await resolvedColor(page, 'var(--devC)'))
    await expect(current.getByTestId('stage-node-pulse-dot')).toHaveCount(3)
    const halo = current.getByTestId('stage-node-halo')
    await expect(halo).toBeVisible()
    expect(await cssOf(halo, 'background-color')).toBe(await resolvedColor(page, 'var(--devSoft)'))
    expect(await cssOf(halo, 'animation-duration')).toBe('2.8s')
  })

  test('a recorded stage is "done": filled with its stage colour and a white check', async ({ page }) => {
    await openFlat(page)
    const done = stageNode(page, 'planning')
    await expect(done).toHaveAttribute('data-state', 'done')
    expect(await cssOf(circleOf(page, 'planning'), 'background-color')).toBe(await resolvedColor(page, 'var(--planC)'))
    await expect(done.getByTestId('stage-node-check')).toBeVisible()
  })

  test('a stage not started has a surface fill and a 2px dashed --border2 ring', async ({ page }) => {
    await openFlat(page)
    await expect(stageNode(page, 'qa')).toHaveAttribute('data-state', 'todo')
    const circle = circleOf(page, 'qa')
    expect(await cssOf(circle, 'background-color')).toBe(await resolvedColor(page, 'var(--surface)'))
    expect(await cssOf(circle, 'border-top-style')).toBe('dashed')
    expect(await cssOf(circle, 'border-top-width')).toBe('2px')
    expect(await cssOf(circle, 'border-top-color')).toBe(await resolvedColor(page, 'var(--border2)'))
  })

  test('the label is 13.5px/700 and the subtitle one 11px --text3 line cut off with an ellipsis', async ({ page }) => {
    await openFlat(page)
    const name = stageNode(page, 'qa').getByTestId('stage-node-name')
    const sub = stageNode(page, 'qa').getByTestId('stage-node-sub')
    expect(await cssOf(name, 'font-size')).toBe('13.5px')
    expect(await cssOf(name, 'font-weight')).toBe('700')
    expect(await cssOf(sub, 'font-size')).toBe('11px')
    expect(await cssOf(sub, 'color')).toBe(await resolvedColor(page, 'var(--text3)'))
    expect(await cssOf(sub, 'white-space')).toBe('nowrap')
    expect(await cssOf(sub, 'text-overflow')).toBe('ellipsis')
  })

  test('each subtitle is that stage\'s own status pill text, the same text its panel shows', async ({ page }) => {
    await openFlat(page)
    for (const id of FLAT_STAGES) {
      await stageNode(page, id).click()
      await expect(stageNode(page, id)).toHaveAttribute('aria-current', 'step')
      const panelPill = page.getByTestId('l2-panel-pill')
      // Planning opens the plan tab, which has no stage pill of its own.
      if (await panelPill.count()) await expect(stageNode(page, id).getByTestId('stage-node-sub')).toHaveText(await panelPill.innerText())
    }
  })

  test('the selected stage gets a 2px ring in its colour, an 800-weight label and a subtitle in its ink', async ({ page }) => {
    await openFlat(page)
    await stageNode(page, 'qa').click()
    const node = stageNode(page, 'qa')
    await expect(node).toHaveAttribute('data-selected', 'true')
    const ring = node.getByTestId('stage-node-ring')
    await expect(ring).toBeVisible()
    expect(await cssOf(ring, 'border-top-width')).toBe('2px')
    expect(await cssOf(ring, 'border-top-color')).toBe(await resolvedColor(page, 'var(--qaC)'))
    expect(await cssOf(node.getByTestId('stage-node-name'), 'font-weight')).toBe('800')
    expect(await cssOf(node.getByTestId('stage-node-sub'), 'color')).toBe(await resolvedColor(page, 'var(--qaInk)'))
    await expect(stageNode(page, 'dev').getByTestId('stage-node-ring')).toHaveCount(0)
  })

  test('a milestone child, which never plans on its own, draws Dev → Code review → QA → Merge', async ({ page }) => {
    await openFlat(page, MILESTONE_CHILD)
    for (const id of CHILD_STAGES) await expect(stageNode(page, id)).toBeVisible()
    await expect(stageNode(page, 'planning')).toHaveCount(0)
  })

  test('a done task has no current node: every recorded stage is done', async ({ page }) => {
    await openFlat(page, 'board-done-one')
    await expect(chart(page).locator('[data-state="current"]')).toHaveCount(0)
    await expect(chart(page).locator('[data-task-stage="true"]')).toHaveCount(0)
  })
})

test.describe('gradient edges', () => {
  test('each edge\'s stroke is a userSpaceOnUse gradient from the source stage colour to the target\'s', async ({ page }) => {
    await openFlat(page)
    const gradient = chart(page).locator('linearGradient[data-edge-id="planning-dev"]')
    await expect(gradient).toHaveAttribute('gradientUnits', 'userSpaceOnUse')
    const stops = gradient.locator('stop')
    await expect(stops).toHaveCount(2)
    expect(await cssOf(stops.nth(0), 'stop-color')).toBe(await resolvedColor(page, 'var(--planC)'))
    expect(await cssOf(stops.nth(1), 'stop-color')).toBe(await resolvedColor(page, 'var(--devC)'))
  })

  test('an edge into an unreached stage ends in --border2, the brief\'s #cfd7d7', async ({ page }) => {
    await openFlat(page)
    const stops = chart(page).locator('linearGradient[data-edge-id="cr-qa"] stop')
    expect(await cssOf(stops.nth(1), 'stop-color')).toBe(await resolvedColor(page, 'var(--border2)'))
  })

  test('a reached edge is 2.5px solid; an unreached one dashed 6 6 at about 55% opacity', async ({ page }) => {
    await openFlat(page)
    const reached = edge(page, 'planning', 'dev')
    await expect(reached).toHaveAttribute('data-reached', 'true')
    expect(await cssOf(reached, 'stroke-width')).toBe('2.5px')
    expect(await cssOf(reached, 'stroke-dasharray')).toBe('none')

    const unreached = edge(page, 'qa', 'merge')
    await expect(unreached).toHaveAttribute('data-reached', 'false')
    expect(await cssOf(unreached, 'stroke-dasharray')).toBe('6px, 6px')
    const stopOpacity = await cssOf(chart(page).locator('linearGradient[data-edge-id="qa-merge"] stop').first(), 'stop-opacity')
    expect(parseFloat(stopOpacity)).toBeCloseTo(0.55, 2)
  })
})

test.describe('layout and viewport, worked out by hand', () => {
  test('nodes sit in one row, spaced by clamp(28, (width − 48 − 5×150) / 4, 220)', async ({ page }) => {
    await openFlat(page)
    const zoom = await flowZoom(chart(page))
    const width = await chartInnerWidth(page)
    const gap = Math.min(220, Math.max(28, (width - 48 - 5 * NODE_WIDTH) / 4))
    const xs = await Promise.all(FLAT_STAGES.map((id) => centreX(circleOf(page, id))))
    const ys = await Promise.all(FLAT_STAGES.map(async (id) => (await boxOf(circleOf(page, id))).y))
    for (let i = 1; i < xs.length; i++) expect((xs[i] - xs[i - 1]) / zoom).toBeCloseTo(NODE_WIDTH + gap, 0)
    expect(new Set(ys.map((y) => Math.round(y))).size).toBe(1)
  })

  test('when the chart fits it is centred, at zoom 1, and marks itself as fitting', async ({ page }) => {
    await openFlat(page)
    await expect(chart(page)).toHaveAttribute('data-fits', 'true')
    expect(await flowZoom(chart(page))).toBe(1)
    const box = await boxOf(chart(page))
    const first = await boxOf(stageNode(page, 'planning'))
    const last = await boxOf(stageNode(page, 'merge'))
    expect(Math.abs((first.x - box.x) - (box.x + box.width - (last.x + last.width)))).toBeLessThanOrEqual(2)
  })

  test('the box is exactly the scaled content height plus padding: no dead space', async ({ page }) => {
    await openFlat(page)
    const zoom = await flowZoom(chart(page))
    const height = await chart(page).evaluate((el) => el.clientHeight)
    expect(Math.abs(height - Math.round(CONTENT_HEIGHT * zoom + 2 * PAD))).toBeLessThanOrEqual(1)
  })

  test('it is a plain surface box: 12px radius, 1px --border, no dot grid, no controls, no attribution', async ({ page }) => {
    await openFlat(page)
    expect(await cssOf(chart(page), 'background-color')).toBe(await resolvedColor(page, 'var(--surface)'))
    expect(await cssOf(chart(page), 'border-top-left-radius')).toBe('12px')
    expect(await cssOf(chart(page), 'border-top-width')).toBe('1px')
    expect(await cssOf(chart(page), 'border-top-color')).toBe(await resolvedColor(page, 'var(--border)'))
    await expect(chart(page).locator('.react-flow__background')).toHaveCount(0)
    await expect(chart(page).locator('.react-flow__controls')).toHaveCount(0)
    await expect(chart(page).locator('.react-flow__attribution')).toHaveCount(0)
  })

  test('nodes cannot be dragged, and wheel, pinch and double-click never zoom it', async ({ page }) => {
    await openFlat(page)
    const before = await boxOf(stageNode(page, 'qa'))
    const transform = await flowViewportTransform(chart(page))
    await page.mouse.move(before.x + before.width / 2, before.y + 10)
    await page.mouse.down()
    await page.mouse.move(before.x + before.width / 2 + 80, before.y + 60, { steps: 6 })
    await page.mouse.up()
    expect(await boxOf(stageNode(page, 'qa'))).toEqual(before)

    const box = await boxOf(chart(page))
    await page.mouse.move(box.x + 8, box.y + 8)
    await page.mouse.wheel(0, 200)
    await page.mouse.dblclick(box.x + 8, box.y + 8)
    expect(await flowViewportTransform(chart(page))).toBe(transform)
  })
})

test.describe('at 760px the chart does not fit', () => {
  test.use({ viewport: NARROW_760 })

  test('it left-aligns, centres the current stage where it can, and pans horizontally only', async ({ page }) => {
    await openFlat(page)
    await expect(chart(page)).toHaveAttribute('data-fits', 'false')
    const box = await boxOf(chart(page))
    const current = await centreX(circleOf(page, 'dev'))
    // The current stage is pulled toward the middle, never past the content's edges.
    expect(Math.abs(current - (box.x + box.width / 2))).toBeLessThan(box.width / 2)

    const before = await boxOf(circleOf(page, 'merge'))
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 6)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height - 46, { steps: 8 })
    await page.mouse.up()
    const after = await boxOf(circleOf(page, 'merge'))
    expect(after.x).toBeLessThan(before.x)
    expect(after.y).toBe(before.y)
  })

  test('no text in the chart renders below 10px effective size', async ({ page }) => {
    await openFlat(page)
    const small = (await effectiveTextSizes(chart(page))).filter((sample) => sample.effectivePx < MIN_EFFECTIVE_TEXT_PX)
    expect(small).toEqual([])
  })

  test('no text below 10px on a parent with a rework loop and wave dots either', async ({ page }) => {
    await openParent(page, PARENT, { M1: 'review', M2: 'working' })
    await expect(chart(page)).toBeVisible()
    const small = (await effectiveTextSizes(chart(page))).filter((sample) => sample.effectivePx < MIN_EFFECTIVE_TEXT_PX)
    expect(small).toEqual([])
  })
})

test.describe('selecting a stage', () => {
  test('a click selects that stage and swaps the detail panel below', async ({ page }) => {
    await openFlat(page)
    await stageNode(page, 'cr').click()
    await expect(page).toHaveURL(/[?&]stage=cr(&|$)/)
    await expect(stageNode(page, 'cr')).toHaveAttribute('aria-current', 'step')
    await expect(page.getByTestId('stage-scope-cr')).toBeVisible()
  })

  test('the chart is not re-mounted and its viewport does not move', async ({ page }) => {
    await openFlat(page)
    await setMountMarker(chart(page))
    const transform = await flowViewportTransform(chart(page))
    const scrollY = await page.evaluate(() => window.scrollY)

    await stageNode(page, 'qa').click()
    await expect(stageNode(page, 'qa')).toHaveAttribute('aria-current', 'step')
    expect(await readMountMarker(chart(page))).toBe('kept')
    expect(await flowViewportTransform(chart(page))).toBe(transform)
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY)
  })

  test('at 760px a panned chart keeps its pan position through a selection', async ({ page }) => {
    await page.setViewportSize(NARROW_760)
    await openFlat(page)
    const box = await boxOf(chart(page))
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 6)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 - 90, box.y + box.height - 6, { steps: 6 })
    await page.mouse.up()
    await setMountMarker(chart(page))
    const panned = await flowViewportTransform(chart(page))

    await stageNode(page, 'planning').click()
    await expect(stageNode(page, 'planning')).toHaveAttribute('aria-current', 'step')
    expect(await readMountMarker(chart(page))).toBe('kept')
    expect(await flowViewportTransform(chart(page))).toBe(panned)
  })

  test('a live snapshot update does not re-mount the chart either', async ({ page }) => {
    const snapshot = await openParent(page, PARENT, { M1: 'working' })
    await expect(chart(page)).toBeVisible()
    await setMountMarker(chart(page))
    // A real change, not a replay of the same data: M1 moves into review, so
    // the pushed snapshot recolours a dot and adds the rework loop.
    setMilestoneState(snapshot, PARENT, 'M1', 'review')
    await pushSnapshot(page, snapshot)
    await expect(chart(page).getByTestId('stage-rework-loop')).toHaveCount(1)
    expect(await readMountMarker(chart(page))).toBe('kept')
  })
})

test.describe('fan-out parent: dev wave dots and the rework loop', () => {
  test('a parent shows the five-node chart instead of the Plan / Plan Review / Dev tabs', async ({ page }) => {
    await openParent(page, PARENT)
    for (const id of FLAT_STAGES) await expect(stageNode(page, id)).toBeVisible()
    await expect(page.getByTestId('l1-tabs')).toHaveCount(0)
  })

  test('Dev carries one 6px dot per milestone, grouped by wave, coloured by status', async ({ page }) => {
    await openParent(page, PARENT, { M1: 'review', M2: 'working' })
    const dots = stageNode(page, 'dev').getByTestId('stage-node-dot')
    await expect(dots).toHaveCount(4)
    const byId = (id: string) => stageNode(page, 'dev').locator(`[data-testid="stage-node-dot"][data-milestone-id="${id}"]`)
    await expect(byId('M0')).toHaveAttribute('data-status', 'merged')
    await expect(byId('M1')).toHaveAttribute('data-status', 'review')
    await expect(byId('M2')).toHaveAttribute('data-status', 'working')
    await expect(byId('M3')).toHaveAttribute('data-status', 'queued')
    expect(await cssOf(byId('M0'), 'background-color')).toBe(await resolvedColor(page, 'var(--sage)'))
    expect(await cssOf(byId('M1'), 'background-color')).toBe(await resolvedColor(page, 'var(--crC)'))
    expect(await cssOf(byId('M2'), 'background-color')).toBe(await resolvedColor(page, 'var(--devC)'))
    expect(await cssOf(byId('M3'), 'border-top-color')).toBe(await resolvedColor(page, 'var(--border2)'))
    expect((await boxOf(byId('M0'))).width / await flowZoom(chart(page))).toBeCloseTo(6, 0)

    const groups = stageNode(page, 'dev').getByTestId('stage-node-dot-group')
    await expect(groups).toHaveCount(3)
    const [first, second] = [await boxOf(groups.nth(0)), await boxOf(groups.nth(1))]
    expect((second.x - (first.x + first.width)) / await flowZoom(chart(page))).toBeCloseTo(5, 0)
  })

  test('each milestone in review draws one coral, animated loop from Code review back to Dev, with an arrowhead and its id', async ({ page }) => {
    await openParent(page, PARENT, { M1: 'review', M2: 'review' })
    const loop = chart(page).getByTestId('stage-rework-loop')
    await expect(loop).toHaveCount(1)
    await expect(loop).toHaveAttribute('data-source', 'cr')
    await expect(loop).toHaveAttribute('data-target', 'dev')
    await expect(loop).toHaveAttribute('data-animated', 'true')
    // So edgeLabelCrossings (path[data-edge-id]) checks the loop too.
    await expect(loop).toHaveAttribute('data-edge-id', 'cr-dev-loop')
    expect(await loop.getAttribute('marker-end')).toMatch(/^url\(/)
    expect(await cssOf(loop, 'stroke')).toBe(await resolvedColor(page, 'var(--crC)'))
    await expect(chart(page).getByTestId('stage-rework-label')).toHaveText('M1, M2 · findings → fixes')
  })

  test('the loop leaves from below Code review\'s label block and enters below Dev\'s', async ({ page }) => {
    await openParent(page, PARENT, { M1: 'review' })
    const ends = await chart(page).getByTestId('stage-rework-loop').evaluate((el) => {
      const path = el as SVGPathElement
      const matrix = path.getScreenCTM()!
      const start = new DOMPoint(path.getPointAtLength(0).x, path.getPointAtLength(0).y).matrixTransform(matrix)
      const end = new DOMPoint(path.getPointAtLength(path.getTotalLength()).x, path.getPointAtLength(path.getTotalLength()).y).matrixTransform(matrix)
      return { startY: start.y, endY: end.y }
    })
    const crLabel = await boxOf(stageNode(page, 'cr').getByTestId('flow-label-block'))
    const devLabel = await boxOf(stageNode(page, 'dev').getByTestId('flow-label-block'))
    expect(ends.startY).toBeGreaterThanOrEqual(crLabel.y + crLabel.height)
    expect(ends.endY).toBeGreaterThanOrEqual(devLabel.y + devLabel.height)
  })

  test('with a loop the box grows to about 144px of content; with none it is about 108px', async ({ page }) => {
    await openParent(page, PARENT, { M1: 'review' })
    const zoom = await flowZoom(chart(page))
    const withLoop = await chart(page).evaluate((el) => el.clientHeight)
    expect(Math.abs(withLoop - Math.round(CONTENT_HEIGHT_WITH_LOOP * zoom + 2 * PAD))).toBeLessThanOrEqual(1)

    await openParent(page, PARENT, { M1: 'working' })
    await expect(chart(page).getByTestId('stage-rework-loop')).toHaveCount(0)
    const withoutLoop = await chart(page).evaluate((el) => el.clientHeight)
    expect(Math.abs(withoutLoop - Math.round(CONTENT_HEIGHT * zoom + 2 * PAD))).toBeLessThanOrEqual(1)
  })

  test('a parent is "current" at Dev while any milestone is still queued or in dev', async ({ page }) => {
    await openParent(page, PARENT, { M1: 'review' })
    await expect(stageNode(page, 'dev')).toHaveAttribute('data-state', 'current')
    await expect(stageNode(page, 'planning')).toHaveAttribute('data-state', 'done')
    await expect(stageNode(page, 'cr')).toHaveAttribute('data-state', 'todo')
  })

  test('selecting Code review on a parent lists the milestones in review, each linking to its own page', async ({ page }) => {
    await openParent(page, PARENT, { M1: 'review', M2: 'working' })
    await stageNode(page, 'cr').click()
    const list = page.getByTestId('parent-stage-list')
    await expect(list).toBeVisible()
    await expect(list.getByTestId('parent-stage-row')).toHaveCount(1)
    const row = list.locator('[data-testid="parent-stage-row"][data-milestone-id="M1"]')
    await row.click()
    await expect(page).toHaveURL(/\/task\/wave-batch-parent-m1(\?|$)/)
  })

  test('a parent stage with no milestone in it says so instead of an empty list', async ({ page }) => {
    await openParent(page, PARENT, { M1: 'working' })
    await stageNode(page, 'qa').click()
    await expect(page.getByTestId('parent-stage-empty')).toBeVisible()
    await expect(page.getByTestId('parent-stage-row')).toHaveCount(0)
  })
})

test.describe('no edge crosses a label', () => {
  for (const viewport of [DESKTOP, NARROW_760]) {
    test(`flat task at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await openFlat(page)
      expect(await edgeLabelCrossings(chart(page))).toEqual([])
    })

    test(`parent with a rework loop at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await openParent(page, PARENT, { M1: 'review', M2: 'review' })
      await expect(chart(page).getByTestId('stage-rework-loop')).toHaveCount(1)
      expect(await edgeLabelCrossings(chart(page))).toEqual([])
    })
  }
})

test.describe('dark mode by token swap only', () => {
  test.use({ colorScheme: 'dark' })

  test('fills, halo, gradient stops and the box all resolve to the dark theme\'s tokens', async ({ page }) => {
    await openFlat(page)
    for (const id of ['planning', 'dev']) {
      expect(await cssOf(circleOf(page, id), 'background-color')).toBe(await resolvedColor(page, `var(--${STAGE_TOKEN[id]}C)`))
    }
    expect(await cssOf(stageNode(page, 'dev').getByTestId('stage-node-halo'), 'background-color')).toBe(await resolvedColor(page, 'var(--devSoft)'))
    const stops = chart(page).locator('linearGradient[data-edge-id="planning-dev"] stop')
    expect(await cssOf(stops.nth(0), 'stop-color')).toBe(await resolvedColor(page, 'var(--planC)'))
    expect(await cssOf(stops.nth(1), 'stop-color')).toBe(await resolvedColor(page, 'var(--devC)'))
    expect(await cssOf(chart(page), 'background-color')).toBe(await resolvedColor(page, 'var(--surface)'))
    // Not the light value: the swap really happened.
    expect(await resolvedColor(page, 'var(--surface)')).not.toBe('rgb(255, 255, 255)')
  })

  test('no colour in either chart is a hard-coded literal: every gradient stop is a token', async ({ page }) => {
    await openParent(page, PARENT, { M1: 'review' })
    const literalStops = await chart(page).locator('linearGradient stop').evaluateAll((stops) =>
      stops.map((stop) => stop.getAttribute('style') ?? stop.getAttribute('stop-color') ?? '').filter((value) => /#[0-9a-f]{3,8}\b|rgb\(/i.test(value)))
    expect(literalStops).toEqual([])
  })
})
