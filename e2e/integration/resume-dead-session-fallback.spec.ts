import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { withOrchestratorSessionLock } from '../fixtures/orchestratorSessionLock.js'
import {
  openScratchSession,
  closeScratchSession,
  readSessionContents,
} from '../fixtures/itermSessions.js'

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
// state a restarted machine leaves behind. Real osascript/tmux automation is
// used throughout (no route mocking), matching this suite's and
// qa-case-list.spec.ts's precedent: this dashboard is inherently
// macOS+iTerm2-only, so a real round trip is the honest verifier.

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

test.describe('resume/focus fallback — both sessions dead, no orchestrator reachable', () => {
  test('paused task: fails loudly (503) instead of the old silent 200 no-op', async ({ page }) => {
    await withOrchestratorSessionLock(async () => {
      await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
      await page.goto('/')

      const btn = page.locator('.card[data-slug="resume-dead-session"] [data-testid="resume-btn"]')
      await expect(btn).toBeVisible()

      const [res] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/focus/resume-dead-session') && r.request().method() === 'POST'),
        btn.click(),
      ])
      expect(res.status()).toBe(503)
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
      expect(res.status()).toBe(503)
      await expect(btn).toHaveClass(/btn-err/)
    })
  })

  test('ORCHESTRATOR_SESSION missing entirely vs recorded-but-dead: distinct error messages, mirroring /backlog/dispatch', async ({ page }) => {
    await withOrchestratorSessionLock(async () => {
      await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
      const missing = await page.request.post('/focus/resume-dead-session')
      expect(missing.status()).toBe(503)
      expect((await missing.json()).error).toMatch(/orchestrator not running/i)

      await fs.writeFile(ORCHESTRATOR_SESSION_PATH, 'fake-orchestrator-session-not-real')
      try {
        const recordedButDead = await page.request.post('/focus/resume-dead-session')
        expect(recordedButDead.status()).toBe(503)
        expect((await recordedButDead.json()).error).toMatch(/orchestrator tab not found/i)
      } finally {
        await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
      }
    })
  })
})

test.describe('resume/focus fallback — orchestrator reachable', () => {
  test('the resume message is actually pasted into the orchestrator session', async ({ page }) => {
    const sessionId = await openScratchSession()
    try {
      await withOrchestratorSessionLock(async () => {
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, sessionId + '\n')
        try {
          await page.goto('/')
          const btn = page.locator('.card[data-slug="resume-dead-session"] [data-testid="resume-btn"]')

          const [res] = await Promise.all([
            page.waitForResponse((r) => r.url().includes('/focus/resume-dead-session') && r.request().method() === 'POST'),
            btn.click(),
          ])
          expect(res.status()).toBe(202)
          await expect(btn).toHaveClass(/btn-ok/)

          await expect.poll(() => readSessionContents(sessionId)).toContain('resume-dead-session')
        } finally {
          await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
        }
      })
    } finally {
      await closeScratchSession(sessionId)
    }
  })
})
