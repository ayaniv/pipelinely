import { test, expect, type Page } from '@playwright/test'
import { DESKTOP } from './fixtures/designTokens'
import { freezeLiveFeed, pushSnapshot, collectConsoleErrors } from './fixtures/liveBoard'

// cr-tab-interactive-findings: the CR tab's own findings checklist is the
// interactive one whenever the Fix N CR Comments button that acts on it is
// usable, so there is no "Select findings to fix" detour through the
// cr-fixes tab. Where nothing can be acted on, the tab stays the read-only
// recap exactly as before. Every case runs in both colour schemes: the
// checkboxes and the footer swap are theme-agnostic, and that is the claim.

const SLUG = 'cr-fixes-ready'
const COMMENT_FIX_STAGE = 'comment-fix'

const finding = (severity: 'must' | 'should' | 'suggestion', selected = false) => ({
  severity, category: 'correctness', description: `A ${severity} comment`, location: 'src/a.ts:1', selected,
})

// Each state is a patch over the cr-fixes-ready fixture, pushed as a snapshot
// so the shared fixture files on disk are never written.
const STATES = {
  approvedShouldFix: { status: 'waiting', waitingReason: 'CR approved, ready for QA', findings: [finding('should'), finding('suggestion')] },
  mustFix: { status: 'waiting', waitingReason: 'CR found 1 must-fix comments, triage and dispatch cr-fixes', findings: [finding('must', true)] },
  nothingToAct: { status: 'waiting', waitingReason: 'CR approved, ready for QA', findings: [] },
  alreadyFixed: { status: 'waiting', waitingReason: 'comments addressed, ready for QA', findings: [finding('should')] },
  notWaiting: { status: 'working', attentionStatus: 'working', waitingReason: undefined, findings: [finding('must', true)] },
} as const

const panel = (page: Page) => page.getByTestId('detail-panel-slot')

async function openCrTab(page: Page, state: keyof typeof STATES): Promise<string[]> {
  const consoleErrors = collectConsoleErrors(page)
  await page.goto(`/task/${SLUG}?stage=cr`)
  await expect(panel(page).getByTestId('l2-panel')).toBeVisible()
  await freezeLiveFeed(page)
  await pushSnapshot(page, { taskPatches: { [SLUG]: STATES[state] } })
  return consoleErrors
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`CR tab interactive findings (${colorScheme})`, () => {
    test.use({ colorScheme, viewport: DESKTOP })

    test('an approved review with only should-fix comments is interactive in place, with no jump button', async ({ page }) => {
      await openCrTab(page, 'approvedShouldFix')

      await expect(panel(page).getByTestId('triage-checklist')).toBeVisible()
      await expect(panel(page).getByTestId('triage-checkbox')).toHaveCount(2)
      await expect(panel(page).getByTestId('select-findings-btn')).toHaveCount(0)
      await expect(panel(page).getByTestId('l2-cta')).toBeDisabled()
      await expect(panel(page).getByTestId('skip-cta')).toBeEnabled()
    })

    test('a review with must-fix items is interactive and its selection POSTs to /triage once per toggle', async ({ page }) => {
      const bodies: unknown[] = []
      await page.route('**/triage/**', async (route) => {
        bodies.push(route.request().postDataJSON())
        await route.fulfill({ status: 200, json: { ok: true } })
      })
      await openCrTab(page, 'mustFix')
      const checkbox = panel(page).getByTestId('triage-checkbox')
      const cta = panel(page).getByTestId('l2-cta')

      await expect(checkbox).toBeChecked()
      await expect(cta).toHaveText(/Fix 1 CR Comment\b/)

      await checkbox.uncheck()
      await expect(panel(page).getByTestId('checklist-selected-count')).toHaveText('0')
      await expect(cta).toBeDisabled()
      await expect.poll(() => bodies.length).toBe(1)
      expect(bodies).toEqual([{ selected: [] }])

      await checkbox.check()
      await expect(cta).toBeEnabled()
      await expect.poll(() => bodies.length).toBe(2)
      expect(bodies[1]).toEqual({ selected: [0] })
    })

    test('the selection survives the server echoing it back, and Fix sends exactly one comment-fix request', async ({ page }) => {
      const stageRequests: unknown[] = []
      await page.route('**/triage/**', (route) => route.fulfill({ status: 200, json: { ok: true } }))
      await page.route(`**/stage-skill/${SLUG}`, async (route) => {
        stageRequests.push(route.request().postDataJSON())
        await route.fulfill({ status: 200, json: { submitted: false } })
      })
      await openCrTab(page, 'approvedShouldFix')

      await panel(page).getByTestId('triage-checkbox').nth(1).check()
      await pushSnapshot(page, { taskPatches: { [SLUG]: { ...STATES.approvedShouldFix, findings: [finding('should'), finding('suggestion', true)] } } })

      await expect(panel(page).getByTestId('triage-checkbox').nth(1)).toBeChecked()
      await expect(panel(page).getByTestId('triage-checkbox').nth(0)).not.toBeChecked()
      const cta = panel(page).getByTestId('l2-cta')
      await expect(cta).toHaveText(/Fix 1 CR Comment\b/)

      await cta.click()

      await expect(cta).toHaveClass(/btn-ok/)
      expect(stageRequests).toEqual([{ stage: COMMENT_FIX_STAGE, autoSubmit: false }])
    })

    test('a failed triage POST is logged and the box falls back to the last confirmed selection', async ({ page }) => {
      await page.route('**/triage/**', (route) => route.fulfill({ status: 500, json: { error: 'boom' } }))
      const consoleErrors = await openCrTab(page, 'mustFix')

      await panel(page).getByTestId('triage-checkbox').click()

      await expect.poll(() => consoleErrors.length).toBeGreaterThan(0)
      await expect(panel(page).getByTestId('triage-checkbox')).toBeChecked()
    })

    for (const state of ['nothingToAct', 'alreadyFixed', 'notWaiting'] as const) {
      test(`${state}: stays read-only, as before`, async ({ page }) => {
        await openCrTab(page, state)

        await expect(panel(page).getByTestId('triage-checkbox')).toHaveCount(0)
        await expect(panel(page).getByTestId('triage-checklist')).toHaveCount(0)
        await expect(panel(page).getByTestId('skip-cta')).toHaveCount(0)
        await expect(panel(page).getByTestId('l2-cta')).toHaveText('Start Code Review')
        await expect(panel(page).getByTestId('l2-cta')).toBeDisabled()
        if (state === 'nothingToAct') await expect(panel(page).getByTestId('cr-no-findings-note')).toBeVisible()
        else await expect(panel(page).getByTestId('select-findings-btn')).toBeVisible()
      })
    }
  })
}
