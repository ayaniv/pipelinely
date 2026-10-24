import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { withOrchestratorSessionLock } from '../fixtures/orchestratorSessionLock.js'
import {
  openScratchSession,
  closeScratchSession,
  attachSessionToTmux,
  createOrchestratorTmuxSession,
  readTmuxPaneContents,
  killTmuxSession,
  tmuxEnterWasPressed,
} from '../fixtures/itermSessions.js'
import { startCanonicalServer, stopCanonicalServer } from '../fixtures/canonicalServer.js'

// The mechanism proof for "batch dispatch stages, never auto-submits" — the
// half a route mock cannot give. e2e/batch-dispatch-staging.spec.ts (`ui`
// project) proves the dashboard sends ONE /batch-dispatch; this proves what
// that request actually does to a real tmux pane.
//
// Incident this exists for (2026-09-06): "Run wave" on
// pipelinely-dashboard-redesign's wave 2 auto-submitted two real
// `/pipelinely-dev <slug>` commands into the developer's live, attended
// orchestrator session — via a write that pressed Return after typing. The
// fix routes both batch paths through the 'stage' write mode (paste, no
// Enter), the posture /stage-skill/:slug already uses.
//
// A route mock can distinguish neither "staged" from "submitted" nor "one
// combined command" from "two concatenated ones" — only reading a real
// pane can. The scratch orchestrator is a uniquely named tmux session running
// a fake claude that never reads its tty, so the tty just echoes what the
// server pastes: staged text leaves the cursor right after it, a pressed
// Enter returns the cursor to column 0. Same precedent as backlog-batch-dispatch.spec.ts,
// wave-batch-run.spec.ts and qa-case-list.spec.ts.
//
// VM-only: importing ../fixtures/itermSessions.js runs
// assertIsolatedEnvironment() at module load, so this file refuses to load
// anywhere the developer's real ORCHESTRATOR_SESSION is reachable. Runs only
// via `npm run test:e2e:vm`, never `npm run test:e2e`.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TASKS_DIR = path.join(__dirname, '..', 'fixtures', 'tasks')
const ORCHESTRATOR_SESSION_PATH = path.join(TASKS_DIR, 'ORCHESTRATOR_SESSION')

const ORCHESTRATOR_TMUX_PATH = path.join(TASKS_DIR, 'ORCHESTRATOR_TMUX')

// Batch dispatch is a 'stage' write, which focuses the tab attached to the
// orchestrator's tmux session. Attaching a scratch tab up front keeps the
// server from opening a window this spec cannot clean up.
async function withTmuxOrchestrator(fn: (tmuxName: string) => Promise<void>): Promise<void> {
  await withOrchestratorSessionLock(async () => {
    const tmuxName = `cockpit-e2e-batch-${randomUUID().slice(0, 8)}`
    await createOrchestratorTmuxSession(tmuxName)
    const attachedTabId = await openScratchSession()
    try {
      await attachSessionToTmux(attachedTabId, tmuxName)
      await fs.writeFile(ORCHESTRATOR_TMUX_PATH, tmuxName + '\n')
      await fn(tmuxName)
    } finally {
      await fs.rm(ORCHESTRATOR_TMUX_PATH, { force: true })
      // The server re-records the attached tab here after a write.
      await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
      await closeScratchSession(attachedTabId)
      await killTmuxSession(tmuxName)
    }
  })
}

async function postBatch(baseURL: string, body: unknown): Promise<number> {
  const res = await fetch(`${baseURL}/batch-dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.status
}

// POST /batch-dispatch goes through the canonical-dispatch gate first (see
// server.ts's writeToOrchestrator), and this suite's own shared webServer
// (playwright.config.ts) deliberately never sets COCKPIT_DISPATCH_ENABLED —
// see that config's own comment. So every test below runs its own
// dedicated, canonical instance of src/server.ts (same fixture TASKS_DIR,
// COCKPIT_DISPATCH_ENABLED=1) and targets it directly — same reasoning as
// orchestrator-session-self-heal.spec.ts's own dedicated server.
let canonicalUrl: string
test.beforeAll(async () => {
  canonicalUrl = await startCanonicalServer()
})
test.afterAll(async () => {
  await stopCanonicalServer(canonicalUrl)
})

test.describe('batch dispatch stages one unsent command in a real session', () => {
  test('a two-milestone wave batch leaves ONE combined command sitting unsent at the prompt', async () => {
    await withTmuxOrchestrator(async (tmuxName) => {
        const status = await postBatch(canonicalUrl, {
          kind: 'wave',
          slugs: ['wave-batch-parent-m1', 'wave-batch-parent-m2'],
        })
        expect(status).toBe(200)

        const contents = await readTmuxPaneContents(tmuxName)

        // One command carrying both milestones — not two separate ones.
        expect(contents).toContain('/pipelinely-dev wave-batch-parent-m1')
        expect(contents).toContain('/pipelinely-dev wave-batch-parent-m2')
        expect(contents).toContain('in parallel')

        // The regression that matters: it is STILL AT THE PROMPT. Before the
        // fix this text would have been submitted and gone, replaced by two
        // real dispatches spawning two real worktrees.
        expect(await tmuxEnterWasPressed(tmuxName)).toBe(false)
    })
  })

  test('a backlog batch whose item context spans a line break still stages a single unbroken line', async () => {
    await withTmuxOrchestrator(async (tmuxName) => {
        // The safety invariant, exercised end to end: a BACKLOG.md entry's
        // context legitimately sits on its own line, and an embedded newline
        // would split the staged command in two (and show up in Claude Code
        // as an opaque pasted-text block), so composeBatchMessage must
        // collapse it before it ever gets here.
        const status = await postBatch(canonicalUrl, {
          kind: 'backlog',
          items: [
            { description: 'First integration item', context: 'context line one\nand line two' },
            { description: 'Second integration item' },
          ],
        })
        expect(status).toBe(200)

        const contents = await readTmuxPaneContents(tmuxName)
        expect(contents).toContain('First integration item')
        expect(contents).toContain('Second integration item')
        // capture-pane -J joins soft wraps only, so a surviving newline would
        // break this one-line match.
        expect(contents).toContain('context line one and line two')
        // The words the orchestrator's promote flow keys on
        // (orchestrator-prompt.md) must survive composition.
        expect(contents).toContain('backlog items')
        expect(await tmuxEnterWasPressed(tmuxName)).toBe(false)
    })
  })

  test('two batches staged back-to-back concatenate visibly but neither is ever submitted', async () => {
    await withTmuxOrchestrator(async (tmuxName) => {
        // tech-design.md's "Requirement 3" decision, proved rather than
        // assumed: batch dispatch takes /stage-skill/:slug's posture, which
        // has no pending guard either — a second batch typed before the
        // developer presses Return lands on the same prompt line. That is
        // accepted BECAUSE the result is benign: garbled, visible, and above
        // all UNSENT, so nothing runs and the developer clears the line.
        expect(await postBatch(canonicalUrl, { kind: 'wave', slugs: ['wave-batch-parent-m1'] })).toBe(200)
        expect(await postBatch(canonicalUrl, { kind: 'backlog', items: [{ description: 'Second batch item' }] })).toBe(200)

        const contents = await readTmuxPaneContents(tmuxName)
        expect(contents).toContain('/pipelinely-dev wave-batch-parent-m1')
        expect(contents).toContain('Second batch item')

        // Neither batch ran. The second batch's text is the last thing on the
        // pane, so no Return was ever pressed for either.
        expect(await tmuxEnterWasPressed(tmuxName)).toBe(false)
    })
  })
})
