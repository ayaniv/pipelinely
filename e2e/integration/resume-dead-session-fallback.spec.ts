import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { withOrchestratorSessionLock } from '../fixtures/orchestratorSessionLock.js'

// Covers the fix for: clicking Resume (or plain Terminal) on a task whose
// iTerm tab AND tmux session are both gone — e.g. after a computer restart —
// used to silently no-op. POST /focus/:slug called reattachOrFocus, which
// returned void regardless of outcome, so the route always answered 200
// even though nothing happened (see src/focusTab.ts's reattachOrFocus and
// src/server.ts's POST /focus/:slug). Now, when neither is reachable, the
// route falls back to pasteToOrchestrator — the same primitive
// /backlog/dispatch already uses — asking the orchestrator to recreate the
// task's tmux session against its existing worktree and resume it.
//
// Fixture tasks 'resume-dead-session' (paused — the "Resume" button) and
// 'focus-dead-session' (working, non-paused — the plain "Terminal" button)
// both carry an ITERM_SESSION/TMUX_SESSION that never match a real session,
// so decideReattachAction always returns 'none' for them here — the exact
// state a restarted machine leaves behind.
//
// This suite's own shared webServer (playwright.config.ts) never sets
// COCKPIT_DISPATCH_ENABLED — deliberately, so it identifies as a
// non-canonical instance of the dashboard, exactly like a worktree's own
// local preview server would (see TASK.md: canonical-dispatch-gate). The
// canonical-dispatch gate inside writeToOrchestrator (server.ts) is checked
// before ORCHESTRATOR_SESSION is ever read, so every scenario below now
// gets the same 403 regardless of whether a session was ever recorded — the
// old distinct "missing" vs "recorded-but-dead" 503 messages this suite used
// to distinguish are simply never reached here. Real pasting into a live
// orchestrator session once canonical is covered instead by
// src/server.canonicalGate.test.ts's vitest suite, which can flip
// COCKPIT_DISPATCH_ENABLED per test against a mocked focusTab.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TASKS_DIR = path.join(__dirname, '..', 'fixtures', 'tasks')
const ORCHESTRATOR_SESSION_PATH = path.join(TASKS_DIR, 'ORCHESTRATOR_SESSION')

// Serial: every test here reads/writes the same shared ORCHESTRATOR_SESSION
// fixture file. Each test's body additionally holds
// withOrchestratorSessionLock for its ORCHESTRATOR_SESSION window, which is
// what actually protects it from pipeline-stage-cta.spec.ts /
// qa-case-list.spec.ts running concurrently in other workers — serial mode
// alone only orders tests within this file.
test.describe.configure({ mode: 'serial' })

test.describe('resume/focus fallback — non-canonical instance, dispatch always refused', () => {
  test('paused task: fails loudly (403 read-only) instead of the old silent 200 no-op', async ({ page }) => {
    await withOrchestratorSessionLock(async () => {
      await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
      await page.goto('/')

      const btn = page.locator('.card[data-slug="resume-dead-session"] [data-testid="resume-btn"]')
      await expect(btn).toBeVisible()

      const [res] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/focus/resume-dead-session') && r.request().method() === 'POST'),
        btn.click(),
      ])
      expect(res.status()).toBe(403)
      await expect(btn).toHaveClass(/btn-err/)
      await expect(btn).not.toHaveClass(/btn-ok/)
    })
  })

  test('non-paused task (Terminal button): same fallback fires — the failure mode is identical regardless of isPaused', async ({ page }) => {
    await withOrchestratorSessionLock(async () => {
      await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
      await page.goto('/')

      const btn = page.locator('.card[data-slug="focus-dead-session"] [data-testid="focus-btn"]')
      await expect(btn).toBeVisible()

      const [res] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/focus/focus-dead-session') && r.request().method() === 'POST'),
        btn.click(),
      ])
      expect(res.status()).toBe(403)
      await expect(btn).toHaveClass(/btn-err/)
    })
  })

  test('ORCHESTRATOR_SESSION missing entirely vs recorded-but-dead: the canonical gate rejects both identically, before either is ever read', async ({ page }) => {
    await withOrchestratorSessionLock(async () => {
      await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
      const missing = await page.request.post('/focus/resume-dead-session')
      expect(missing.status()).toBe(403)
      expect((await missing.json()).error).toMatch(/not the canonical orchestrator dashboard/i)

      await fs.writeFile(ORCHESTRATOR_SESSION_PATH, 'fake-orchestrator-session-not-real')
      try {
        const recordedButDead = await page.request.post('/focus/resume-dead-session')
        expect(recordedButDead.status()).toBe(403)
        expect((await recordedButDead.json()).error).toMatch(/not the canonical orchestrator dashboard/i)
      } finally {
        await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
      }
    })
  })
})
