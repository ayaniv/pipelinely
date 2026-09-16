import { test, expect, type Page } from '@playwright/test'
import { gotoBoardTab } from './fixtures/boardTabs'

// The CLIENT half of "auto-submit stage CTAs, but only from a remote/mobile
// access context" (see tech-design.md). Everything here runs in the `ui`
// project against fixture tasks and fake session ids — no osascript, no tmux,
// no real iTerm2 window, nothing that could reach the developer's own
// orchestrator tab. That is deliberate and it is also this suite's ceiling.
//
// What this suite CAN prove: that the desktop dashboard offers no auto-submit
// affordance at all, that the toggle appears only when the server says the
// request came from a remote origin, that it defaults off, that it fails
// closed when the access probe itself fails, and that the flag the CTA
// actually puts on the wire tracks the toggle.
//
// What it CANNOT prove: whether the server then STAGED or SUBMITTED. In
// fixture space no real iTerm2 session matches a fixture's session id, so
// POST /stage-skill/:slug returns 503 before either write function is
// reached — the same honest limitation e2e/integration/pipeline-stage-cta
// .spec.ts documents about itself. The staged-vs-submitted decision is
// covered by src/server.autoSubmit.test.ts (vitest, focusTab.js mocked, both
// write functions observable) and, against a real terminal, by
// e2e/integration/cta-auto-submit-mobile.spec.ts.
//
// The remote origin is simulated by stubbing GET /api/access rather than by
// loading the page over one of this machine's real network interfaces. That
// keeps every case here deterministic on an offline machine, and the thing
// being tested on this side is the client's reaction to the answer, not the
// server's derivation of it (which is remoteAccess.test.ts's job).

// dev-ready's STATUS ("plan reviewed, ready for dev") resolves a real next
// stage, so its card footer carries a live "Start dev →" CTA — the same
// button e2e/board-redesign.spec.ts asserts is that card's primary action.
const CTA_SLUG = 'dev-ready'

const ACCESS_ROUTE = '**/api/access'

// Installs the access-context answer BEFORE the page loads, since the client
// probes once on load. `remote: null` stands for a probe that fails outright
// (offline, server restarting mid-load) — the fail-closed case.
async function stubAccessContext(page: Page, isRemoteAccess: boolean | null): Promise<void> {
  await page.route(ACCESS_ROUTE, async (route) => {
    if (isRemoteAccess === null) return route.abort()
    await route.fulfill({ json: { isRemoteAccess } })
  })
}

function ctaButton(page: Page) {
  return page.locator(`[data-testid="task-card"][data-slug="${CTA_SLUG}"]`).getByTestId('card-cta-btn')
}

// Clicks the stage CTA and returns the JSON body it actually put on the wire.
// Asserting the request body rather than the response is the point: the
// response is a fixture-space 503 either way, while the body is the whole
// client-side contract this suite exists to pin down.
async function stageCtaRequestBody(page: Page): Promise<Record<string, unknown>> {
  const cta = ctaButton(page)
  await expect(cta).toBeVisible()
  const [request] = await Promise.all([
    page.waitForRequest((r) => r.url().includes(`/stage-skill/${CTA_SLUG}`) && r.method() === 'POST'),
    cta.click(),
  ])
  return request.postDataJSON()
}

test.describe('desktop (loopback) dashboard — the regression constraint', () => {
  // No stub at all here: this hits the real GET /api/access over the real
  // loopback connection Playwright already makes, which is exactly the
  // desktop developer's situation.
  test('offers no auto-submit toggle anywhere in the header', async ({ page }) => {
    await gotoBoardTab(page, 'inprogress')
    await expect(page.getByTestId('auto-submit-toggle')).toHaveCount(0)
  })

  test('GET /api/access reports isRemoteAccess false to a loopback caller', async ({ request }) => {
    const res = await request.get('/api/access')
    expect(res.ok()).toBe(true)
    expect(await res.json()).toEqual({ isRemoteAccess: false })
  })

  test('a stage CTA still posts autoSubmit false, exactly as it does today', async ({ page }) => {
    await gotoBoardTab(page, 'inprogress')
    const body = await stageCtaRequestBody(page)
    expect(body.stage).toBe('dev')
    expect(body.autoSubmit).toBe(false)
  })
})

test.describe('remote (mobile) dashboard', () => {
  test('shows the auto-submit toggle, off by default', async ({ page }) => {
    await stubAccessContext(page, true)
    await gotoBoardTab(page, 'inprogress')

    const toggle = page.getByTestId('auto-submit-toggle')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  })

  test('with the toggle off, a stage CTA posts autoSubmit false', async ({ page }) => {
    await stubAccessContext(page, true)
    await gotoBoardTab(page, 'inprogress')
    await expect(page.getByTestId('auto-submit-toggle')).toBeVisible()

    const body = await stageCtaRequestBody(page)
    expect(body.autoSubmit).toBe(false)
  })

  test('with the toggle on, a stage CTA posts autoSubmit true', async ({ page }) => {
    await stubAccessContext(page, true)
    await gotoBoardTab(page, 'inprogress')

    const toggle = page.getByTestId('auto-submit-toggle')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')

    const body = await stageCtaRequestBody(page)
    expect(body.stage).toBe('dev')
    expect(body.autoSubmit).toBe(true)
  })

  // Per-device by construction: the choice lives in this browser's own
  // localStorage, so the phone can have it on while the desktop — a
  // different browser on a different device — never even renders the button.
  test('the toggle choice survives a reload', async ({ page }) => {
    await stubAccessContext(page, true)
    await gotoBoardTab(page, 'inprogress')

    const toggle = page.getByTestId('auto-submit-toggle')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')

    await page.reload()
    await expect(page.getByTestId('auto-submit-toggle')).toHaveAttribute('aria-pressed', 'true')
  })

  test('turning the toggle back off returns the CTA to autoSubmit false', async ({ page }) => {
    await stubAccessContext(page, true)
    await gotoBoardTab(page, 'inprogress')

    const toggle = page.getByTestId('auto-submit-toggle')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')

    const body = await stageCtaRequestBody(page)
    expect(body.autoSubmit).toBe(false)
  })
})

test.describe('access probe failure — fails closed', () => {
  // A page that cannot find out where it is being viewed from must behave
  // like the desktop, not like the phone: no toggle, no flag, today's staged
  // behaviour. The board itself must still render — the probe is an
  // enhancement, not a load-bearing fetch.
  test('a failed /api/access probe leaves the dashboard with no toggle and no flag', async ({ page }) => {
    await stubAccessContext(page, null)
    await gotoBoardTab(page, 'inprogress')

    await expect(page.getByTestId('active-sessions')).toBeVisible()
    await expect(page.getByTestId('auto-submit-toggle')).toHaveCount(0)

    const body = await stageCtaRequestBody(page)
    expect(body.autoSubmit).toBe(false)
  })

  // A stored "on" choice from an earlier remote session must not survive
  // into a context that can no longer confirm it is remote — isRemoteAccess
  // is an AND, not a fallback.
  test('a stored "on" choice does not resurrect the toggle when the probe fails', async ({ page }) => {
    await stubAccessContext(page, true)
    await gotoBoardTab(page, 'inprogress')
    await page.getByTestId('auto-submit-toggle').click()
    await expect(page.getByTestId('auto-submit-toggle')).toHaveAttribute('aria-pressed', 'true')

    await page.unroute(ACCESS_ROUTE)
    await stubAccessContext(page, null)
    await page.reload()

    await expect(page.getByTestId('active-sessions')).toBeVisible()
    await expect(page.getByTestId('auto-submit-toggle')).toHaveCount(0)
    const body = await stageCtaRequestBody(page)
    expect(body.autoSubmit).toBe(false)
  })
})
