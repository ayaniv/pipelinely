import { test, expect, type Page, type Request, type Route } from '@playwright/test'
import { openWithSnapshot, pushSnapshot } from './fixtures/snapshotStub.js'

// The Handover pills stage `/pipelinely-handover` into the right session instead of
// being decorative. See tech-design.md.
//
// Two targets, one rule:
//   - a task's own Handover pill (board card, detail header) -> POST
//     /pipelinely-handover/:slug -> the task's own tracked session
//   - the top bar's Handover segment (fused into the orchestrator ctx pill)
//     -> POST /orchestrator/pipelinely-handover -> the orchestrator's own session
// Both STAGE the text unsent (stageInSession / pasteIntoTrackedSession with
// submit:false) — that half is proved at the vitest level against the real
// route handlers (src/server.handover.test.ts), where the focusTab write
// functions can be mocked. This file proves what the dashboard SENDS and how
// it reports the outcome.
//
// `ui` project, local-safe by construction:
//   - every orchestrator-side case is route-stubbed. The unstubbed route
//     reads the shared fixture ORCHESTRATOR_SESSION pointer, which the
//     integration suite writes real scratch session ids into under a lock
//     this project cannot take (orchestratorSessionLock.ts asserts an
//     isolated environment at import) — so this file never lets that route
//     reach the real server.
//   - the one unstubbed task-side case targets `handover-hot`, a fixture
//     with no ITERM_SESSION and no TMUX_SESSION: pasteIntoTrackedSession's
//     pure no-session exit, zero osascript/tmux calls.
//
// Selectors are data-testid only; no assertion selects by visible copy.
//
// Committed red with @pending during planning (VERIFY runs
// --grep-invert @pending); the dev stage removed the tag once green.

const HOT_SLUG = 'handover-hot'

function hotCard(page: Page) {
  return page.locator(`[data-testid="task-card"][data-slug="${HOT_SLUG}"]`)
}

interface RecordedPosts {
  taskHandover: string[]
  orchestratorHandover: number
  otherDispatch: string[]
}

// Every dispatch-shaped POST the page makes. `otherDispatch` exists to prove
// the NEGATIVE — a Handover click never goes out through a sibling write
// route (stage-skill/focus/backlog/batch), and never to the other Handover
// target.
const OTHER_DISPATCH_ROUTES = ['/stage-skill/', '/focus/', '/backlog/dispatch', '/batch-dispatch']

function recordDispatchPosts(page: Page): RecordedPosts {
  const recorded: RecordedPosts = { taskHandover: [], orchestratorHandover: 0, otherDispatch: [] }
  page.on('request', (req: Request) => {
    if (req.method() !== 'POST') return
    const { pathname } = new URL(req.url())
    if (pathname === '/orchestrator/pipelinely-handover') {
      recorded.orchestratorHandover++
      return
    }
    const taskMatch = pathname.match(/^\/pipelinely-handover\/([^/]+)$/)
    if (taskMatch) {
      recorded.taskHandover.push(decodeURIComponent(taskMatch[1]))
      return
    }
    if (OTHER_DISPATCH_ROUTES.some((route) => pathname.startsWith(route))) recorded.otherDispatch.push(pathname)
  })
  return recorded
}

async function stubRoute(page: Page, glob: string, status: number, body?: unknown): Promise<void> {
  await page.route(glob, (route) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body ?? {}) }),
  )
}

// Holds a route open until the returned `release` is called — lets a test
// observe the in-flight state (button disabled) deterministically instead of
// racing a real response.
async function holdRoute(page: Page, glob: string): Promise<{ release: () => Promise<void> }> {
  const held: Route[] = []
  await page.route(glob, (route) => { held.push(route) })
  return {
    release: async () => {
      await expect.poll(() => held.length).toBeGreaterThan(0)
      await Promise.all(held.map((route) => route.fulfill({ status: 200, body: '{}' })))
    },
  }
}

test.describe('task Handover pill — board card', () => {
  test('is a real button carrying the handover action and the task slug', async ({ page }) => {
    await page.goto('/')
    const pill = hotCard(page).getByTestId('card-handover')
    await expect(pill).toBeVisible()
    expect(await pill.evaluate((el) => el.tagName)).toBe('BUTTON')
    await expect(pill).toHaveAttribute('type', 'button')
    await expect(pill).toHaveAttribute('data-action', 'handover')
    await expect(pill).toHaveAttribute('data-slug', HOT_SLUG)
  })

  test('clicking it stages into this task only — one POST /pipelinely-handover/:slug, no sibling route, no detail open', async ({ page }) => {
    const posts = recordDispatchPosts(page)
    await stubRoute(page, `**/pipelinely-handover/${HOT_SLUG}`, 200)
    await page.goto('/')

    const pill = hotCard(page).getByTestId('card-handover')
    await pill.click()

    await expect.poll(() => posts.taskHandover).toEqual([HOT_SLUG])
    await expect(pill).toHaveClass(/btn-ok/)
    expect(posts.orchestratorHandover).toBe(0)
    expect(posts.otherDispatch).toEqual([])
    // A button inside the card must not fall through to "click anywhere on a
    // card opens its detail".
    await expect(page.getByTestId('task-detail')).toBeHidden()
  })

  test('a task with no recorded session fails honestly against the real server: 503, error state, re-enabled', async ({ page }) => {
    await page.goto('/')
    const pill = hotCard(page).getByTestId('card-handover')

    const [response] = await Promise.all([
      page.waitForResponse((res) => new URL(res.url()).pathname === `/pipelinely-handover/${HOT_SLUG}` && res.request().method() === 'POST'),
      pill.click(),
    ])
    expect(response.status()).toBe(503)
    expect((await response.json()).error).toContain('no recorded session')
    await expect(pill).toHaveClass(/btn-err/)
    await expect(pill).toBeEnabled()
  })

  test('a 409 (reattached but the retry still failed) shows the error state', async ({ page }) => {
    await stubRoute(page, `**/pipelinely-handover/${HOT_SLUG}`, 409, { reattached: true, error: 'Session was gone — reattached a new tab, but the handover command still failed to stage. Click again.' })
    await page.goto('/')
    const pill = hotCard(page).getByTestId('card-handover')
    await pill.click()
    await expect(pill).toHaveClass(/btn-err/)
    await expect(pill).toBeEnabled()
  })

  test('a fast double-click sends exactly one request while the first is in flight', async ({ page }) => {
    const posts = recordDispatchPosts(page)
    const held = await holdRoute(page, `**/pipelinely-handover/${HOT_SLUG}`)
    await page.goto('/')

    const pill = hotCard(page).getByTestId('card-handover')
    await pill.dblclick()
    await expect(pill).toBeDisabled()
    await held.release()

    await expect(pill).toBeEnabled()
    expect(posts.taskHandover).toEqual([HOT_SLUG])
  })
})

test.describe('task Handover pill — detail header', () => {
  test('clicking it stages into this task and leaves the detail view open', async ({ page }) => {
    const posts = recordDispatchPosts(page)
    await stubRoute(page, `**/pipelinely-handover/${HOT_SLUG}`, 200)
    await page.goto(`/task/${HOT_SLUG}`)
    const detail = page.getByTestId('task-detail')
    await expect(detail).toBeVisible()

    const pill = detail.getByTestId('detail-handover')
    expect(await pill.evaluate((el) => el.tagName)).toBe('BUTTON')
    await pill.click()

    await expect.poll(() => posts.taskHandover).toEqual([HOT_SLUG])
    await expect(pill).toHaveClass(/btn-ok/)
    await expect(detail).toBeVisible()
    expect(posts.orchestratorHandover).toBe(0)
    expect(posts.otherDispatch).toEqual([])
  })
})

test.describe('orchestrator Handover segment — top bar', () => {
  // The segment binds its own onClick (and posts to /orchestrator/pipelinely-handover,
  // asserted by the next case), so it needs no data-action to route by. "No
  // slug" is the meaningful half: this segment is the orchestrator's, never a task's.
  test('is a real button that carries no task slug', async ({ page }) => {
    await page.goto('/')
    const segment = page.getByTestId('header-handover')
    await expect(segment).toBeVisible()
    expect(await segment.evaluate((el) => el.tagName)).toBe('BUTTON')
    await expect(segment).toHaveAttribute('type', 'button')
    await expect(segment).not.toHaveAttribute('data-slug', /.*/)
  })

  test('clicking it stages into the orchestrator only — one POST /orchestrator/pipelinely-handover, never a task route', async ({ page }) => {
    const posts = recordDispatchPosts(page)
    await stubRoute(page, '**/orchestrator/pipelinely-handover', 200)
    await page.goto('/')

    const segment = page.getByTestId('header-handover')
    await segment.click()

    await expect.poll(() => posts.orchestratorHandover).toBe(1)
    await expect(segment).toHaveClass(/btn-ok/)
    expect(posts.taskHandover).toEqual([])
    expect(posts.otherDispatch).toEqual([])
  })

  test('a 503 (orchestrator not running) shows the error state and leaves it usable', async ({ page }) => {
    await stubRoute(page, '**/orchestrator/pipelinely-handover', 503, { error: 'Orchestrator not running — no ORCHESTRATOR_SESSION found' })
    await page.goto('/')

    const segment = page.getByTestId('header-handover')
    await segment.click()
    await expect(segment).toHaveClass(/btn-err/)
    await expect(segment).toBeEnabled()
  })

  test('a server that is down shows the error state rather than nothing', async ({ page }) => {
    await page.route('**/orchestrator/pipelinely-handover', (route) => route.abort('connectionrefused'))
    await page.goto('/')

    const segment = page.getByTestId('header-handover')
    await segment.click()
    await expect(segment).toHaveClass(/btn-err/)
    await expect(segment).toBeEnabled()
  })

  // Every SSE message (any watched task file changing, every second or two
  // in real use) re-renders the header. The same root cause
  // focus-button-rerender-race.spec.ts documents for the board: a re-render
  // that replaced the button's DOM between mousedown and mouseup would
  // swallow the click entirely. The header is React, which reconciles the same node in place for a
  // same-content snapshot, so this pushes one through the page's own es.onmessage (a real SSE push,
  // via snapshotStub.ts) between a real mouse down/up.
  test('a same-content snapshot landing mid-click does not swallow the request', async ({ page }) => {
    const posts = recordDispatchPosts(page)
    await stubRoute(page, '**/orchestrator/pipelinely-handover', 200)
    const snapshot = await openWithSnapshot(page, '/', () => {})

    const segment = page.getByTestId('header-handover')
    await expect(segment).toBeVisible()
    const box = await segment.boundingBox()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.down()
    await pushSnapshot(page, { ...snapshot })
    await page.mouse.up()

    await expect.poll(() => posts.orchestratorHandover).toBe(1)
  })
})
