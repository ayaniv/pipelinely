import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gotoBoardTab, selectBoardTab } from '../fixtures/boardTabs.js'
import { BACKLOG_PATH, appendShelvedEntry, withBacklogFileLock, withRestoredBacklog } from '../fixtures/backlogFile.js'
import { withOrchestratorSessionLock } from '../fixtures/orchestratorSessionLock.js'
import { openScratchSession, closeScratchSession, readSessionContents } from '../fixtures/itermSessions.js'

// Covers demoting an in-progress task back to the backlog without losing the
// work already built for it, and promoting it back again.
//
// The mechanism under test, in one line: STATUS becomes a bare `shelved`
// value (so the task drops off both board tabs while its dir and branch
// stay exactly as they were), its worktree is committed and removed (the
// branch is the only thing that survives), and BACKLOG.md gains an entry
// carrying an indented `shelved: <slug>` marker line that points back at
// that task dir. Resuming that entry writes STATUS back to
// `paused: resumed from backlog`, deletes the backlog entry, and — since the
// worktree is gone — the next dead-session click on that card asks the
// orchestrator to recreate it from the branch before continuing. Neither
// direction ever goes through /backlog/dispatch, which is the
// dispatch-fresh path and would start the task over.
//
// No reason is captured anywhere: Shelve is a plain confirm(), not a form.
//
// @pending until this task's implementation lands — every test here fails
// against HEAD by design (there is no Shelve button, no `shelved` STATUS
// value, and no `shelved:` backlog marker yet). The dev stage removes the
// tag from every describe title once it does; until then the root VERIFY
// runs `playwright test --grep-invert @pending`, matching the precedent in
// orchestrator-pointer-race.spec.ts and tmux-session-collision.spec.ts.
//
// Every mutating test holds withBacklogFileLock: BACKLOG.md is a single
// fixture file that backlog-batch-dispatch.spec.ts asserts holds exactly
// three items, and fullyParallel workers would otherwise see this suite's
// appended entries mid-run. Fixture STATUS/TIMELINE files are restored the
// same way. The orchestrator-message case instead takes
// withOrchestratorSessionLock (never the backlog lock — it never touches
// BACKLOG.md), the same primitive resume-dead-session-fallback.spec.ts
// already uses for the same shared ORCHESTRATOR_SESSION fixture file.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TASKS_DIR = path.join(__dirname, '..', 'fixtures', 'tasks')
const ORCHESTRATOR_SESSION_PATH = path.join(TASKS_DIR, 'ORCHESTRATOR_SESSION')

// Committed fixtures, restored verbatim after any test that writes them.
const SHELVE_CANDIDATE = { slug: 'shelve-candidate', status: 'working\n' }
const SHELVED_TASK = { slug: 'shelved-task', status: 'shelved\n' }
const SHELVE_WITH_WORKTREE = { slug: 'shelve-with-worktree', status: 'working\n' }
const RESUME_WORKTREE_GONE = { slug: 'resume-worktree-gone', status: 'paused: resumed from backlog\n' }
const DONE_SLUG = 'board-done-one'

function statusPath(slug: string): string {
  return path.join(TASKS_DIR, slug, 'STATUS')
}

function timelinePath(slug: string): string {
  return path.join(TASKS_DIR, slug, 'TIMELINE')
}

// Runs `fn` with a fixture task's committed STATUS and TIMELINE restored
// afterwards, however `fn` ends — the STATUS/TIMELINE equivalent of
// withRestoredBacklog.
async function withRestoredTaskFiles<T>(fixture: { slug: string; status: string }, fn: () => Promise<T>): Promise<T> {
  const originalTimeline = await fs.readFile(timelinePath(fixture.slug), 'utf-8')
  try {
    return await fn()
  } finally {
    await fs.writeFile(statusPath(fixture.slug), fixture.status)
    await fs.writeFile(timelinePath(fixture.slug), originalTimeline)
  }
}

async function apiTask(page: Page, slug: string): Promise<any | undefined> {
  const res = await page.request.get('/api/tasks')
  expect(res.ok()).toBe(true)
  const body = await res.json()
  return (body.tasks as any[]).find((t) => t.slug === slug)
}

function activeCard(page: Page, slug: string) {
  return page.locator(`[data-testid="task-card"][data-slug="${slug}"]`)
}

// Shelve moved into the card's own 3-dot menu in the Pipelinely Pipeline
// redesign (see cardMenuItemsHtml in public/index.html) — same precedent as
// merge-tab-actions.spec.ts's own openCardMenu for Open PR/Mark done.
async function openCardMenu(page: Page, slug: string) {
  await activeCard(page, slug).getByTestId('card-menu-btn').click()
}

function backlogRowFor(page: Page, slug: string) {
  return page.locator(`[data-testid="backlog-row"][data-shelved-slug="${slug}"]`)
}

test.describe('a shelved task is off the board but fully intact', () => {
  test('it renders no card in In Progress and no row in Done', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('active-sessions')).toBeVisible()
    await expect(activeCard(page, SHELVED_TASK.slug)).toHaveCount(0)

    await selectBoardTab(page, 'done')
    await expect(page.locator(`[data-testid="done-row"][data-slug="${SHELVED_TASK.slug}"]`)).toHaveCount(0)
  })

  test('the API still reports it, with its branch and plan preserved, showsOnBoard false and no shelvedReason', async ({ page }) => {
    const task = await apiTask(page, SHELVED_TASK.slug)
    expect(task).toBeDefined()
    expect(task.status).toBe('shelved')
    expect(task.shelvedReason).toBeUndefined()
    expect(task.showsOnBoard).toBe(false)
    // The whole point of shelving rather than dismissing: nothing already
    // built is discarded. Branch and computed stage both survive.
    expect(task.branch).toBe('claude/shelved-task')
    expect(task.stage).toBe('planning')
  })

  test('a done task offers no Shelve button — shelving is only for open work', async ({ page }) => {
    await page.goto('/')
    await selectBoardTab(page, 'done')
    const doneRow = page.locator(`[data-testid="done-row"][data-slug="${DONE_SLUG}"]`)
    await doneRow.click()
    await expect(doneRow.getByTestId('shelve-btn')).toHaveCount(0)
  })
})

test.describe('shelving an in-progress task from its card', () => {
  test('Shelve (confirmed) takes the task off the board and writes a backlog entry with no reason text', async ({ page }) => {
    await withBacklogFileLock(async () => {
      await withRestoredBacklog(async () => {
        await withRestoredTaskFiles(SHELVE_CANDIDATE, async () => {
          await page.goto('/')
          const card = activeCard(page, SHELVE_CANDIDATE.slug)
          await expect(card).toBeVisible()
          await openCardMenu(page, SHELVE_CANDIDATE.slug)

          page.once('dialog', (dialog) => dialog.accept())
          await card.getByTestId('shelve-btn').click()

          // Off the board — not moved to Done, just gone from both tabs.
          await expect(card).toHaveCount(0, { timeout: 10_000 })

          const task = await apiTask(page, SHELVE_CANDIDATE.slug)
          expect(task.status).toBe('shelved')
          expect(task.shelvedReason).toBeUndefined()

          // On the backlog, carrying the slug that makes it resumable.
          await selectBoardTab(page, 'backlog')
          const row = backlogRowFor(page, SHELVE_CANDIDATE.slug)
          await expect(row).toHaveCount(1)
          await expect(row.getByTestId('backlog-shelved-badge')).toBeVisible()

          const raw = await fs.readFile(BACKLOG_PATH, 'utf-8')
          expect(raw).toContain(`  shelved: ${SHELVE_CANDIDATE.slug}`)
        })
      })
    })
  })

  test('dismissing the confirm dialog shelves nothing', async ({ page }) => {
    await withBacklogFileLock(async () => {
      await withRestoredBacklog(async (original) => {
        await withRestoredTaskFiles(SHELVE_CANDIDATE, async () => {
          await page.goto('/')
          const card = activeCard(page, SHELVE_CANDIDATE.slug)
          await expect(card).toBeVisible()
          await openCardMenu(page, SHELVE_CANDIDATE.slug)

          page.once('dialog', (dialog) => dialog.dismiss())
          await card.getByTestId('shelve-btn').click()

          await expect(card).toBeVisible()
          const task = await apiTask(page, SHELVE_CANDIDATE.slug)
          expect(task.status).toBe('working')
          expect(await fs.readFile(BACKLOG_PATH, 'utf-8')).toBe(original)
        })
      })
    })
  })

  test('shelving an already-shelved task is refused, and adds no second backlog pointer', async ({ page }) => {
    await withBacklogFileLock(async () => {
      await withRestoredBacklog(async (original) => {
        const res = await page.request.post(`/shelve/${SHELVED_TASK.slug}`)
        expect(res.status()).toBe(400)
        expect(await fs.readFile(BACKLOG_PATH, 'utf-8')).toBe(original)
      })
    })
  })

  // Asserted as a pair deliberately: against HEAD the /shelve route does not
  // exist at all, so Express answers 404 to both and only the 400 half can
  // tell "the route rejected a done task" apart from "there is no route".
  test('an unknown slug is a 404 and a done task is a 400 — the route discriminates', async ({ page }) => {
    const unknown = await page.request.post('/shelve/no-such-task-dir')
    expect(unknown.status()).toBe(404)

    const done = await page.request.post(`/shelve/${DONE_SLUG}`)
    expect(done.status()).toBe(400)
  })

  test('shelving a task with a worktree still succeeds, surfacing a best-effort cleanup failure', async ({ page }) => {
    await withBacklogFileLock(async () => {
      await withRestoredBacklog(async () => {
        await withRestoredTaskFiles(SHELVE_WITH_WORKTREE, async () => {
          // shelve-with-worktree's fixture worktree dir is a placeholder,
          // not a real checkout (see playwright.config.ts), so the real git
          // calls fail deterministically and offline — exactly
          // merge-tab-actions.spec.ts's mark-done-with-worktree precedent.
          // What's under test is that the failure is reported, not that it
          // blocks the shelve. Read straight off the request rather than
          // page.waitForResponse: page.request is an APIRequestContext, and
          // its traffic is not reported through the page's network events.
          const response = await page.request.post(`/shelve/${SHELVE_WITH_WORKTREE.slug}`)
          expect(response.status()).toBe(200)
          const body = await response.json()
          expect(body.cleaned).toBe(false)
          expect(body.cleanupError).toMatch(/couldn't (commit pending work|remove worktree)/)

          const task = await apiTask(page, SHELVE_WITH_WORKTREE.slug)
          expect(task.status).toBe('shelved')
        })
      })
    })
  })
})

test.describe('a shelved backlog entry resumes instead of dispatching fresh', () => {
  test('it offers Resume — never Run, and never a batch checkbox', async ({ page }) => {
    await withBacklogFileLock(async () => {
      await withRestoredBacklog(async () => {
        await appendShelvedEntry('Shelved task fixture', '2026-08-28', SHELVED_TASK.slug, 'cockpit-ai')

        await gotoBoardTab(page, 'backlog')
        const row = backlogRowFor(page, SHELVED_TASK.slug)
        await expect(row.getByTestId('backlog-resume-btn')).toBeVisible()
        // Run would paste a promote-fresh message at the orchestrator, and
        // the batch bar's "Run selected" does exactly that per item — both
        // would start work that already exists over again.
        await expect(row.getByTestId('backlog-play-btn')).toHaveCount(0)
        await expect(row.getByTestId('backlog-select-checkbox')).toHaveCount(0)
      })
    })
  })

  test("clicking a shelved row's body opens the same task detail overlay an active card opens", async ({ page }) => {
    await withBacklogFileLock(async () => {
      await withRestoredBacklog(async () => {
        await appendShelvedEntry('Shelved task fixture', '2026-08-28', SHELVED_TASK.slug, 'cockpit-ai')

        await gotoBoardTab(page, 'backlog')
        const row = backlogRowFor(page, SHELVED_TASK.slug)
        await row.click()

        const overlay = page.getByTestId('task-detail')
        await expect(overlay).toBeVisible()
        await expect(overlay).toContainText('Shelved task fixture')

        // Read-only: the overlay's own action row renders focusButtonHtml
        // unconditionally today, and computeAttentionStatus maps a shelved
        // task onto 'paused' — so without an explicit guard this overlay
        // would offer a *primary* Terminal/Resume button that asks the
        // orchestrator to resume from a "STATUS paused note" that doesn't
        // exist, leaving the backlog pointer behind. The backlog row's own
        // Resume button is the only way back onto the board.
        await expect(overlay.getByTestId('focus-btn')).toHaveCount(0)
        await expect(overlay.getByTestId('resume-btn')).toHaveCount(0)
      })
    })
  })

  test('Resume puts the task back on the board as paused and clears the backlog entry', async ({ page }) => {
    await withBacklogFileLock(async () => {
      await withRestoredBacklog(async () => {
        await withRestoredTaskFiles(SHELVED_TASK, async () => {
          await appendShelvedEntry('Shelved task fixture', '2026-08-28', SHELVED_TASK.slug, 'cockpit-ai')

          await gotoBoardTab(page, 'backlog')
          const row = backlogRowFor(page, SHELVED_TASK.slug)
          await expect(row.getByTestId('backlog-resume-btn')).toBeVisible()

          const dispatchCalls: string[] = []
          page.on('request', (req) => {
            if (req.method() === 'POST' && req.url().includes('/backlog/dispatch')) dispatchCalls.push(req.url())
          })

          await row.getByTestId('backlog-resume-btn').click()

          // Back on the board, in the one state that already has a Resume
          // CTA of its own for recreating the worktree and reopening a
          // session.
          await expect(page.getByTestId('active-sessions')).toBeVisible({ timeout: 10_000 })
          const card = activeCard(page, SHELVED_TASK.slug)
          await expect(card).toBeVisible({ timeout: 10_000 })
          await expect(card).toHaveAttribute('data-status', 'paused')

          const task = await apiTask(page, SHELVED_TASK.slug)
          expect(task.status).toBe('paused')
          expect(task.pausedReason).toBe('resumed from backlog')

          // The backlog pointer is gone, and nothing was dispatched fresh.
          expect(await fs.readFile(BACKLOG_PATH, 'utf-8')).not.toContain(`shelved: ${SHELVED_TASK.slug}`)
          await selectBoardTab(page, 'backlog')
          await expect(backlogRowFor(page, SHELVED_TASK.slug)).toHaveCount(0)
          expect(dispatchCalls).toEqual([])
        })
      })
    })
  })

  test('resuming an entry whose task dir is gone fails loudly and keeps the entry', async ({ page }) => {
    await withBacklogFileLock(async () => {
      await withRestoredBacklog(async () => {
        await appendShelvedEntry('Vanished task fixture', '2026-08-28', 'no-such-task-dir', null)

        await gotoBoardTab(page, 'backlog')
        const row = backlogRowFor(page, 'no-such-task-dir')
        const resumeBtn = row.getByTestId('backlog-resume-btn')
        await resumeBtn.click()

        // The failure is visible on the button (btn-err is this dashboard's
        // one failure affordance — see flashBtn), and the entry survives so
        // it can still be waived by hand rather than silently vanishing.
        await expect(resumeBtn).toHaveClass(/btn-err/, { timeout: 10_000 })
        await expect(row).toHaveCount(1)
        expect(await fs.readFile(BACKLOG_PATH, 'utf-8')).toContain('shelved: no-such-task-dir')
      })
    })
  })

  // QUARANTINED — not because of this feature. This case is a real
  // osascript round trip into a scratch iTerm2 window, and pasteIntoSession
  // cannot confirm its own write there: the scratch window runs a plain
  // zsh, which *executes* the pasted line (the message is full of
  // backticks), so the text never reads back off the session verbatim and
  // POST /focus answers 503 instead of 202. Verified pre-existing: the
  // identical test in resume-dead-session-fallback.spec.ts fails exactly
  // the same way against a clean HEAD with this task's changes stashed, so
  // unskipping this one means fixing that shared fixture, not this feature.
  //
  // The behaviour it was written to check — that the fallback message gains
  // the `git worktree add` recreate clause when, and only when, the
  // worktree is gone and the task dir named a repo and branch — is covered
  // deterministically instead by buildDeadSessionMessage's own cases in
  // src/taskParser.test.ts, which assert the exact string in all three
  // branches rather than whatever a live shell left on screen.
  test.skip("resuming a task whose worktree is already gone: the orchestrator is told to recreate it", async ({ page }) => {
    // resume-worktree-gone is already 'paused: resumed from backlog' (as if
    // Resume had just run) with no fixture worktree dir, and a dead
    // ITERM_SESSION/TMUX_SESSION pair — the exact shape
    // resume-dead-session-fallback.spec.ts's own fixtures use to force
    // decideReattachAction into its 'none' outcome. This is real
    // osascript/tmux automation end to end, matching that suite's own
    // precedent: the dashboard is inherently macOS+iTerm2-only, so a real
    // round trip is the only honest verifier of what actually gets pasted.
    const sessionId = await openScratchSession()
    try {
      await withOrchestratorSessionLock(async () => {
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, sessionId + '\n')
        try {
          await page.goto('/')
          const btn = page.locator(`.card[data-slug="${RESUME_WORKTREE_GONE.slug}"] [data-testid="resume-btn"]`)

          const [res] = await Promise.all([
            page.waitForResponse((r) => r.url().includes(`/focus/${RESUME_WORKTREE_GONE.slug}`) && r.request().method() === 'POST'),
            btn.click(),
          ])
          expect(res.status()).toBe(202)

          await expect.poll(() => readSessionContents(sessionId)).toContain('worktree add')
        } finally {
          await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
        }
      })
    } finally {
      await closeScratchSession(sessionId)
    }
  })
})

test.describe('an ordinary backlog item is unaffected', () => {
  test('it still offers Run and a batch checkbox, and no Resume', async ({ page }) => {
    await withBacklogFileLock(async () => {
      await gotoBoardTab(page, 'backlog')
      // The first committed fixture item — a plain, never-dispatched idea.
      const row = page.locator('[data-testid="backlog-row"]').first()
      await expect(row).not.toHaveAttribute('data-shelved-slug', /./)
      await expect(row.getByTestId('backlog-play-btn')).toBeVisible()
      await expect(row.getByTestId('backlog-select-checkbox')).toBeVisible()
      await expect(row.getByTestId('backlog-resume-btn')).toHaveCount(0)
    })
  })
})
