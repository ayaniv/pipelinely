import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { withOrchestratorSessionLock } from '../fixtures/orchestratorSessionLock.js'

// Covers the QA card's full Playwright case list (pass + fail, not just
// failures — see renderDetailQaCases / parseQaCases in taskParser.ts) and
// the "Start QA" button (POST /stage-skill/:slug with { stage: 'qa'}
// → stageInSession — stages the command unsent, same as the other 5
// pipeline-stage CTAs, rather than auto-dispatching). Fixture data lives in
// e2e/fixtures/tasks/qa-all-pass and qa-with-failures (see
// playwright.config.ts for the fixture TASKS_DIR).
//
// This suite's own shared webServer (playwright.config.ts) never sets
// COCKPIT_DISPATCH_ENABLED — deliberately, so it identifies as a
// non-canonical instance of the dashboard, exactly like a worktree's own
// local preview server would (see TASK.md: canonical-dispatch-gate). That
// means POST /stage-skill/:slug's orchestrator-target branch (qa, like dev/
// code-review/plan-review) always 403s here now, even with a real iTerm2
// scratch session registered as ORCHESTRATOR_SESSION — the canonical gate
// runs before writeToOrchestrator ever attempts to stage into it. Real
// staging into a live orchestrator session once canonical is covered
// instead by src/server.canonicalGate.test.ts's vitest suite, which can
// flip COCKPIT_DISPATCH_ENABLED per test against a mocked focusTab.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ORCHESTRATOR_SESSION_PATH = path.join(__dirname, '..', 'fixtures', 'tasks', 'ORCHESTRATOR_SESSION')

test.describe('QA case list', () => {
  test('QA card shows the full case list on a clean pass', async ({ page }) => {
    await page.goto('/task/qa-all-pass')
    await page.getByTestId('stage-chain-qa').click()

    await expect(page.getByTestId('qa-case-list')).toBeVisible()

    const rows = page.getByTestId('qa-case-row')
    await expect(rows).toHaveCount(3)
    await expect(page.locator('[data-testid="qa-case-row"][data-passed="true"]')).toHaveCount(3)
    await expect(page.locator('[data-testid="qa-case-row"][data-passed="false"]')).toHaveCount(0)

    const first = rows.first()
    await expect(first.locator('.finding-category')).toHaveText('Case 1')
    await expect(first.locator('.finding-description')).toHaveText('Filter resets correctly')
    await expect(first.locator('.finding-location')).toHaveText('case-1')
  })

  test('QA card shows the full case list alongside failures', async ({ page }) => {
    await page.goto('/task/qa-with-failures')
    await page.getByTestId('stage-chain-qa').click()

    const rows = page.getByTestId('qa-case-row')
    await expect(rows).toHaveCount(3)
    await expect(page.locator('[data-testid="qa-case-row"][data-passed="false"]')).toHaveCount(1)
    await expect(page.locator('[data-testid="qa-case-row"][data-passed="true"]')).toHaveCount(2)

    // parseQaCases scans "### Failing Cases" before "### Passing Cases" —
    // the same order QA_REPORT.md is written in — so the failing case is
    // always first.
    const failing = rows.first()
    await expect(failing).toHaveAttribute('data-passed', 'false')
    await expect(failing.locator('.finding-category')).toHaveText('Case 2')
    await expect(failing.locator('.finding-location')).toHaveText('case-2')
  })

  // Covers renderPlannedQaCases / parseQaCaseTitles / parseQaSpecFile —
  // before QA_REPORT.md exists, the QA tab previews the case titles
  // planning already committed to the declared e2e spec file (see
  // qa-spec-preview's tech-design.md and its worktree fixture).
  test('QA card previews planned case titles before QA_REPORT.md exists', async ({ page }) => {
    await page.goto('/task/qa-spec-preview')
    await page.getByTestId('stage-chain-qa').click()

    const rows = page.getByTestId('planned-qa-case-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.first().locator('.finding-description')).toHaveText('first planned case')
    await expect(rows.last().locator('.finding-description')).toHaveText('second planned case')

    // Never the real, verified case list — that's a distinct testid/style,
    // and only exists once QA_REPORT.md is written.
    await expect(page.getByTestId('qa-case-list')).toHaveCount(0)
  })

  // A milestone child's spec: field is declared on the PARENT's
  // tech-design.md and stitched onto the dispatched child in
  // parseAllTasks (see computeMilestones's second pass) — the preview has
  // to be fetched for the CHILD's slug, not the parent's, even though the
  // drill-down keeps detailSlug pointed at the parent the whole time (see
  // the msCard click handler in index.html). qa-spec-preview-parent/M0's
  // dispatched child is qa-spec-preview-parent-m0.
  test('QA card previews planned cases for a milestone child drilled into from its parent', async ({ page }) => {
    await page.goto('/task/qa-spec-preview-parent')
    await page.getByTestId('l1-tab-dev').click()
    await page.locator('[data-testid="milestone-card"][data-milestone-id="M0"]').click()
    await page.getByTestId('stage-chain-qa').click()

    const rows = page.getByTestId('planned-qa-case-row')
    await expect(rows).toHaveCount(1)
    await expect(rows.first().locator('.finding-description')).toHaveText('child milestone case one')
  })

  // Bug 1 (fix-qa-cr-bullet-format-gap): a bullet that still doesn't parse
  // (even after FINDING_BULLET_RE's bare-location leniency) used to vanish
  // with zero indication anything was lost — the header still says "all 2
  // cases passed". findQaCasesParseMismatch/parseMismatchWarningHtml now
  // surface that drift as a visible warning instead. Fixture:
  // e2e/fixtures/tasks/qa-parse-mismatch (declares 2 Passing Cases, lists
  // one well-formed bullet and one whose tail isn't location-shaped at all).
  test('QA card shows a parse-mismatch warning when a bullet count disagrees with its header', async ({ page }) => {
    await page.goto('/task/qa-parse-mismatch')
    await page.getByTestId('stage-chain-qa').click()

    const warning = page.getByTestId('qa-parse-mismatch-warning')
    await expect(warning).toBeVisible()
    await expect(warning).toContainText('Passing Cases: header says 2, parsed 1')

    // The one bullet that did parse still renders normally alongside the warning.
    await expect(page.getByTestId('qa-case-list')).toBeVisible()
    await expect(page.getByTestId('qa-case-row')).toHaveCount(1)
  })
})

test.describe('QA automation dispatch — read-only on a non-canonical instance', () => {
  test('"Start QA" is refused with 403 rather than a false "✓ staged"', async ({ page }) => {
    await withOrchestratorSessionLock(async () => {
      await fs.writeFile(ORCHESTRATOR_SESSION_PATH, 'fake-orchestrator-session-not-real\n')
      try {
        // qa-all-pass's STATUS ("waiting: CR approved, ready for QA") is
        // what makes computeNextStageCta report 'qa' as next, so stageCta
        // renders this as the live button rather than the disabled
        // placeholder — the canonical-dispatch gate is a separate, later
        // check inside writeToOrchestrator, not a reason for the button
        // itself to ever be proactively greyed out (see /stage-skill's CTA
        // convention in pipeline-stage-cta.spec.ts).
        await page.goto('/task/qa-all-pass')
        await page.getByTestId('stage-chain-qa').click()

        const btn = page.getByTestId('l2-cta')
        const [res] = await Promise.all([
          page.waitForResponse((r) => r.url().includes('/stage-skill/qa-all-pass') && r.request().method() === 'POST'),
          btn.click(),
        ])
        expect(res.status()).toBe(403)
        await expect(btn).toHaveClass(/btn-err/)
        await expect(btn).not.toHaveClass(/btn-ok/)
      } finally {
        await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
      }
    })
  })
})
