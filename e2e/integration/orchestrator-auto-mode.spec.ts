import { test, expect, type APIRequestContext } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { withOrchestratorSessionLock } from '../fixtures/orchestratorSessionLock.js'
import { openScratchSession, closeScratchSession, readSessionContents } from '../fixtures/itermSessions.js'
import {
  FIXTURE_TASKS_DIR,
  SETTINGS_PATH,
  readTaskFile,
  writeTaskFile,
  removeTaskFile,
  snapshotTaskFiles,
  snapshotSettings,
} from '../fixtures/taskFiles.js'

// Covers orchestrator auto mode: a settings-driven, edge-triggered
// advancement pass that auto-submits the next /cockpit-<stage> invocation
// into the orchestrator's own session when a task hands off at a MECHANICAL
// transition, and never at a judgment-call one.
//
// Why real osascript (no route mocking): the whole claim under test is
// "a command actually reached the orchestrator's session, unattended" —
// and, for the negative cases, that one did NOT. A route-level assertion
// can only see that the server decided to dispatch; it cannot distinguish
// a dispatch that landed from one that was swallowed, and it cannot prove
// absence at all. Same precedent as wave-batch-run.spec.ts,
// backlog-batch-dispatch.spec.ts and resume-dead-session-fallback.spec.ts.
//
// Proving absence: every "must not dispatch" test triggers the negative
// case FIRST, then triggers a known-good control dispatch and waits for the
// control's command to land. Once the control has arrived, the server has
// demonstrably completed a full advancement pass over the same task list,
// so the negative's continued absence is a real result rather than a race
// against a slow watcher.

const ORCHESTRATOR_SESSION_PATH = path.join(FIXTURE_TASKS_DIR, 'ORCHESTRATOR_SESSION')

// The STATUS phrases workers write on handoff — verbatim from
// NEXT_STAGE_BY_WAITING_REASON in src/taskParser.ts.
const CR_MARKER = 'PR open, ready for CR'
const CR_TRIAGE_MARKER = 'triage and dispatch cr-fixes'
const MERGE_MARKER = 'QA passed, ready to merge'

const MECHANICAL = 'auto-mechanical'
const TRIAGE = 'auto-triage'
const MERGE = 'auto-merge'
const TASK_OFF = 'auto-task-off'   // ships AUTO_MODE = manual
const TASK_ON = 'auto-task-on'     // ships AUTO_MODE = auto

const ALL_FIXTURES = [MECHANICAL, TRIAGE, MERGE, TASK_OFF, TASK_ON]

// Every test in this file writes the same shared fixture state
// (ORCHESTRATOR_SESSION, SETTINGS.json, and the fixture tasks' STATUS /
// TIMELINE), and playwright.config.ts turns fullyParallel on repo-wide.
test.describe.configure({ mode: 'serial' })

async function apiTask(request: APIRequestContext, slug: string) {
  const res = await request.get('/api/tasks')
  const { tasks } = await res.json()
  return tasks.find((t: { slug: string }) => t.slug === slug) ?? null
}

async function apiSettings(request: APIRequestContext) {
  const res = await request.get('/api/tasks')
  const { settings } = await res.json()
  return settings
}

async function setGlobalAutoMode(request: APIRequestContext, autoMode: boolean) {
  const res = await request.post('/settings', { data: { autoMode } })
  expect(res.status()).toBe(200)
  await expect.poll(() => apiSettings(request).then((s) => s?.autoMode), { timeout: 10_000 }).toBe(autoMode)
}

// Puts a task back in a state auto mode can never act on, and waits until
// the server has actually observed it. The wait is the point: auto mode is
// edge-triggered, so a reset the server never saw would make the next
// transition look like no transition at all.
async function resetTask(request: APIRequestContext, slug: string) {
  await writeTaskFile(slug, 'STATUS', 'working\n')
  await expect.poll(() => apiTask(request, slug).then((t) => t?.status), { timeout: 15_000 }).toBe('working')
}

async function handOff(slug: string, marker: string) {
  await writeTaskFile(slug, 'STATUS', `waiting: ${marker}\n`)
}

function expectedCommand(skill: string, slug: string) {
  return `/pipelinely-${skill} ${slug}`
}

// The control dispatch every absence proof synchronises on: a transition
// that MUST auto-dispatch under the settings the test has already applied.
async function awaitControlDispatch(request: APIRequestContext, sessionId: string, slug: string) {
  await resetTask(request, slug)
  await handOff(slug, CR_MARKER)
  await expect
    .poll(() => readSessionContents(sessionId), { timeout: 30_000 })
    .toContain(expectedCommand('cr', slug))
}

function autoTimelineEntries(timeline: string): string[] {
  return timeline.split('\n').filter((line) => /\bauto-dispatch(ed)?\b/.test(line))
}

let restoreTasks: (() => Promise<void>) | null = null
let restoreSettings: (() => Promise<void>) | null = null

test.beforeEach(async () => {
  restoreTasks = await snapshotTaskFiles(
    ALL_FIXTURES.map((slug) => ({ slug, files: ['STATUS', 'TIMELINE', 'AUTO_MODE'] })),
  )
  restoreSettings = await snapshotSettings()
})

test.afterEach(async () => {
  await restoreTasks?.()
  await restoreSettings?.()
  await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
})

// UN-QUARANTINED 2026-09-07, developer decision: every test in this file calls
// openScratchSession() and dispatches through the server's real
// orchestrator-write path. Quarantined 2026-09-01 after this suite was
// confirmed live to reach the developer's actual, real orchestrator tab (not
// the fixture ORCHESTRATOR_SESSION under e2e/fixtures/tasks) and dispatch a
// real /pipelinely-cr command into it, twice. The leading suspected cause —
// playwright.config.ts's `reuseExistingServer: true` picking up an
// already-running stray server not scoped to this suite's fixture dirs — is
// now fixed (`reuseExistingServer: false`, hardcoded, landed via
// run-e2e-in-vm-m0/PR #60, merged into this branch). This file was also
// relocated into e2e/integration/ so assertIsolatedEnvironment() gates it
// outside a real VM. Not fixed: `openScratchSession`/`closeScratchSession`
// (e2e/fixtures/itermSessions.ts) still iterate every open iTerm2 window on
// the machine, not just this suite's own scratch sessions — no code-level
// fix for that exists (run-e2e-in-vm's local-VM/tart approach was rejected
// and deleted; no remote VM path exists). Un-quarantined anyway, as a
// deliberate developer decision to run this once, tonight, while unattended
// — not because the underlying risk is fully closed.
test.describe('auto mode on — mechanical transitions advance themselves', () => {
  // The headline case: dev hands off with a PR open, and CR starts without
  // anyone clicking anything.
  test('a dev → code-review handoff auto-submits /pipelinely-cr into the orchestrator', async ({ request }) => {
    const sessionId = await openScratchSession()
    try {
      await withOrchestratorSessionLock(async () => {
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, sessionId + '\n')
        await setGlobalAutoMode(request, true)
        await resetTask(request, MECHANICAL)

        await handOff(MECHANICAL, CR_MARKER)

        await expect
          .poll(() => readSessionContents(sessionId), { timeout: 30_000 })
          .toContain(expectedCommand('cr', MECHANICAL))

        // Auto mode records what it did, in the same append-only file every
        // other stage transition is recorded in — an unattended dispatch
        // that left no trace would be indistinguishable from a stage the
        // developer started by hand.
        await expect
          .poll(() => readTaskFile(MECHANICAL, 'TIMELINE').then((t) => autoTimelineEntries(t ?? '').length), {
            timeout: 15_000,
          })
          .toBe(1)
        const timeline = (await readTaskFile(MECHANICAL, 'TIMELINE')) ?? ''
        expect(autoTimelineEntries(timeline)[0]).toContain('code-review')
      })
    } finally {
      await closeScratchSession(sessionId)
    }
  })

  // Auto mode must dispatch a transition exactly once. STATUS is rewritten
  // by workers, chokidar fires on a dozen file patterns, and refreshTasks
  // also runs on a timer — so a level-triggered implementation would
  // re-dispatch the same handoff on every unrelated refresh.
  test('a mechanical transition dispatches exactly once, even as other tasks churn', async ({ request }) => {
    const sessionId = await openScratchSession()
    try {
      await withOrchestratorSessionLock(async () => {
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, sessionId + '\n')
        await setGlobalAutoMode(request, true)
        await resetTask(request, MECHANICAL)

        await handOff(MECHANICAL, CR_MARKER)
        await expect
          .poll(() => readSessionContents(sessionId), { timeout: 30_000 })
          .toContain(expectedCommand('cr', MECHANICAL))

        // Force several more refresh passes over a task list that still
        // holds MECHANICAL at the very same waiting marker.
        for (let i = 0; i < 3; i++) {
          await writeTaskFile(TRIAGE, 'STATUS', `working\n`)
          await resetTask(request, TRIAGE)
        }

        const timeline = (await readTaskFile(MECHANICAL, 'TIMELINE')) ?? ''
        expect(autoTimelineEntries(timeline)).toHaveLength(1)
        const contents = await readSessionContents(sessionId)
        const occurrences = contents.split(expectedCommand('cr', MECHANICAL)).length - 1
        expect(occurrences).toBe(1)
      })
    } finally {
      await closeScratchSession(sessionId)
    }
  })
})

// Un-quarantined 2026-09-07 — see the note above the first describe block in this file.
test.describe('auto mode on — judgment-call transitions still stop for a human', () => {
  // Deciding which review findings are worth fixing is the human's call.
  // Auto mode must never dispatch /pipelinely-cr-fixes on their behalf.
  test('a CR-findings triage handoff never auto-dispatches', async ({ request }) => {
    const sessionId = await openScratchSession()
    try {
      await withOrchestratorSessionLock(async () => {
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, sessionId + '\n')
        await setGlobalAutoMode(request, true)
        await resetTask(request, TRIAGE)

        await handOff(TRIAGE, CR_TRIAGE_MARKER)
        await awaitControlDispatch(request, sessionId, MECHANICAL)

        const contents = await readSessionContents(sessionId)
        expect(contents).not.toContain('cr-fixes')
        expect(contents).not.toContain(TRIAGE)
        expect(autoTimelineEntries((await readTaskFile(TRIAGE, 'TIMELINE')) ?? '')).toHaveLength(0)

        // The manual route is untouched: the card still offers its own CTA.
        const task = await apiTask(request, TRIAGE)
        expect(task.status).toBe('waiting')
        expect(task.waitingReason).toContain(CR_TRIAGE_MARKER)
      })
    } finally {
      await closeScratchSession(sessionId)
    }
  })

  // Merge is the one stage with no skill, deliberately — only an explicit
  // human action may move a task into "done".
  test('a QA-passed → merge handoff never auto-dispatches', async ({ request }) => {
    const sessionId = await openScratchSession()
    try {
      await withOrchestratorSessionLock(async () => {
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, sessionId + '\n')
        await setGlobalAutoMode(request, true)
        await resetTask(request, MERGE)

        await handOff(MERGE, MERGE_MARKER)
        await awaitControlDispatch(request, sessionId, MECHANICAL)

        const contents = await readSessionContents(sessionId)
        expect(contents).not.toContain(MERGE)
        expect(contents).not.toContain('/pipelinely-merge')
        expect(autoTimelineEntries((await readTaskFile(MERGE, 'TIMELINE')) ?? '')).toHaveLength(0)

        const task = await apiTask(request, MERGE)
        expect(task.status).toBe('waiting')
      })
    } finally {
      await closeScratchSession(sessionId)
    }
  })
})

// Un-quarantined 2026-09-07 — see the note above the first describe block in this file.
test.describe('auto mode off — every transition stays manual', () => {
  test('a mechanical transition dispatches nothing and leaves the manual CTA to do it', async ({ page, request }) => {
    const sessionId = await openScratchSession()
    try {
      await withOrchestratorSessionLock(async () => {
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, sessionId + '\n')
        await setGlobalAutoMode(request, false)
        await resetTask(request, MECHANICAL)

        await handOff(MECHANICAL, CR_MARKER)
        // TASK_ON carries a per-task AUTO_MODE=auto override, so it is the
        // one transition that still dispatches with the global switch off —
        // which makes it this test's control as well as its own scope proof.
        await awaitControlDispatch(request, sessionId, TASK_ON)

        const contents = await readSessionContents(sessionId)
        expect(contents).not.toContain(expectedCommand('cr', MECHANICAL))
        expect(autoTimelineEntries((await readTaskFile(MECHANICAL, 'TIMELINE')) ?? '')).toHaveLength(0)

        // The developer's own click still works exactly as before: the CTA
        // stages (never submits) into the orchestrator's session.
        await page.goto('/')
        await page.locator(`.card[data-slug="${MECHANICAL}"] .card-title`).click()
        await expect(page.getByTestId('task-detail')).toBeVisible()
        await page.getByTestId('l2-cta').first().click()
        await expect
          .poll(() => readSessionContents(sessionId), { timeout: 15_000 })
          .toContain(expectedCommand('cr', MECHANICAL))
      })
    } finally {
      await closeScratchSession(sessionId)
    }
  })
})

// Un-quarantined 2026-09-07 — see the note above the first describe block in this file.
test.describe('settings scope — a global default with per-task overrides', () => {
  test('a per-task manual override wins over the global switch being on', async ({ request }) => {
    const sessionId = await openScratchSession()
    try {
      await withOrchestratorSessionLock(async () => {
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, sessionId + '\n')
        await setGlobalAutoMode(request, true)
        await resetTask(request, TASK_OFF)

        await handOff(TASK_OFF, CR_MARKER)
        await awaitControlDispatch(request, sessionId, MECHANICAL)

        expect(await readSessionContents(sessionId)).not.toContain(expectedCommand('cr', TASK_OFF))
        expect(autoTimelineEntries((await readTaskFile(TASK_OFF, 'TIMELINE')) ?? '')).toHaveLength(0)

        const task = await apiTask(request, TASK_OFF)
        expect(task.autoModeOverride).toBe('manual')
        expect(task.autoMode).toBe(false)
      })
    } finally {
      await closeScratchSession(sessionId)
    }
  })

  test('a per-task auto override wins over the global switch being off', async ({ request }) => {
    const sessionId = await openScratchSession()
    try {
      await withOrchestratorSessionLock(async () => {
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, sessionId + '\n')
        await setGlobalAutoMode(request, false)
        await resetTask(request, TASK_ON)

        await handOff(TASK_ON, CR_MARKER)
        await expect
          .poll(() => readSessionContents(sessionId), { timeout: 30_000 })
          .toContain(expectedCommand('cr', TASK_ON))

        const task = await apiTask(request, TASK_ON)
        expect(task.autoModeOverride).toBe('auto')
        expect(task.autoMode).toBe(true)
      })
    } finally {
      await closeScratchSession(sessionId)
    }
  })

  // Auto mode is edge-triggered on purpose: flipping the global switch on
  // while five tasks already sit at a handoff marker must not fire five
  // sessions at once for handoffs that happened before it was enabled.
  test('enabling auto mode does not dispatch tasks already sitting at a handoff', async ({ request }) => {
    const sessionId = await openScratchSession()
    try {
      await withOrchestratorSessionLock(async () => {
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, sessionId + '\n')
        await setGlobalAutoMode(request, false)
        await resetTask(request, MECHANICAL)

        await handOff(MECHANICAL, CR_MARKER)
        await expect
          .poll(() => apiTask(request, MECHANICAL).then((t) => t?.status), { timeout: 15_000 })
          .toBe('waiting')

        await setGlobalAutoMode(request, true)

        // TASK_ON dispatches on its own override, so it is a control that
        // proves a full advancement pass ran AFTER the switch was flipped.
        await awaitControlDispatch(request, sessionId, TASK_ON)

        expect(await readSessionContents(sessionId)).not.toContain(expectedCommand('cr', MECHANICAL))
        expect(autoTimelineEntries((await readTaskFile(MECHANICAL, 'TIMELINE')) ?? '')).toHaveLength(0)
      })
    } finally {
      await closeScratchSession(sessionId)
    }
  })

  test('the global setting round-trips through SETTINGS.json and survives a reload', async ({ page, request }) => {
    await withOrchestratorSessionLock(async () => {
      await setGlobalAutoMode(request, true)
      const onDisk = JSON.parse(await fs.readFile(SETTINGS_PATH, 'utf-8'))
      expect(onDisk.autoMode).toBe(true)

      // Written against the plan's original header toggle (`auto-mode-toggle`,
      // `data-auto-mode`), before e0c8b73 replaced it with a real /settings
      // page — this spec was quarantined at the time and never updated. The
      // switch (`settings-auto-mode-switch`) is a plain checkbox, always
      // present in the DOM (its parent `#settings-page` is only visually
      // `hidden`), so `checked` is the state to assert, not a data attribute
      // that no longer exists.
      await page.goto('/')
      await expect(page.getByTestId('settings-auto-mode-switch')).toBeChecked()

      await setGlobalAutoMode(request, false)
      await page.goto('/')
      await expect(page.getByTestId('settings-auto-mode-switch')).not.toBeChecked()
    })
  })

  test("the task detail's own control writes and clears that task's AUTO_MODE file", async ({ page, request }) => {
    await withOrchestratorSessionLock(async () => {
      await setGlobalAutoMode(request, false)
      await removeTaskFile(MECHANICAL, 'AUTO_MODE')

      await page.goto('/')
      await page.locator(`.card[data-slug="${MECHANICAL}"] .card-title`).click()
      await expect(page.getByTestId('task-detail')).toBeVisible()

      const control = page.getByTestId('task-auto-mode')
      await expect(control).toHaveValue('inherit')

      await control.selectOption('auto')
      await expect
        .poll(() => readTaskFile(MECHANICAL, 'AUTO_MODE').then((c) => c?.trim()), { timeout: 10_000 })
        .toBe('auto')

      await control.selectOption('inherit')
      await expect
        .poll(() => readTaskFile(MECHANICAL, 'AUTO_MODE'), { timeout: 10_000 })
        .toBeNull()
    })
  })
})

// Un-quarantined 2026-09-07 — see the note above the first describe block in this file.
test.describe('auto mode failure paths', () => {
  // A dispatch that cannot reach the orchestrator must be recorded and then
  // left alone. Retrying on every refresh would hammer a dead session
  // forever; failing silently would leave a task looking like it advanced.
  test('a failed auto-dispatch is recorded once and never retried', async ({ request }) => {
    await withOrchestratorSessionLock(async () => {
      await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
      await setGlobalAutoMode(request, true)
      await resetTask(request, MECHANICAL)

      await handOff(MECHANICAL, CR_MARKER)

      await expect
        .poll(() => readTaskFile(MECHANICAL, 'TIMELINE').then((t) => autoTimelineEntries(t ?? '').length), {
          timeout: 20_000,
        })
        .toBe(1)
      expect(autoTimelineEntries((await readTaskFile(MECHANICAL, 'TIMELINE')) ?? '')[0]).toMatch(/failed/i)

      // Several more refresh passes over the same unchanged handoff.
      for (let i = 0; i < 3; i++) {
        await resetTask(request, TRIAGE)
        await writeTaskFile(TRIAGE, 'STATUS', 'working\n')
      }

      expect(autoTimelineEntries((await readTaskFile(MECHANICAL, 'TIMELINE')) ?? '')).toHaveLength(1)

      // The task is still exactly where the developer left it, with its
      // manual CTA live — a failed auto-dispatch never consumes the handoff.
      const task = await apiTask(request, MECHANICAL)
      expect(task.status).toBe('waiting')
      expect(task.waitingReason).toContain(CR_MARKER)
    })
  })

  // Auto mode reads a settings file a human may have hand-edited. A broken
  // one must fail closed (auto off), never crash the refresh loop that every
  // card on the board depends on.
  test('a malformed SETTINGS.json leaves auto mode off and the board serving', async ({ request }) => {
    await withOrchestratorSessionLock(async () => {
      await fs.writeFile(SETTINGS_PATH, '{ this is not json')

      await expect.poll(() => apiSettings(request).then((s) => s?.autoMode), { timeout: 15_000 }).toBe(false)

      const res = await request.get('/api/tasks')
      expect(res.status()).toBe(200)
      const { tasks } = await res.json()
      expect(tasks.length).toBeGreaterThan(0)
    })
  })
})
