import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withOrchestratorSessionLock } from '../fixtures/orchestratorSessionLock.js'
import { openScratchSession, closeScratchSession, readSessionContents } from '../fixtures/itermSessions.js'

// The mechanism proof for "batch dispatch stages, never auto-submits" — the
// half a route mock cannot give. e2e/batch-dispatch-staging.spec.ts (`ui`
// project) proves the dashboard sends ONE /batch-dispatch; this proves what
// that request actually does to a real iTerm2 session.
//
// Incident this exists for (2026-09-06): "Run wave" on
// pipelinely-dashboard-redesign's wave 2 auto-submitted two real
// `/cockpit-dev <slug>` commands into the developer's live, attended
// orchestrator session — via writeToOrchestrator(text, pasteIntoSession),
// which types the text and then writes a second, empty `newline yes` to press
// Return. The fix routes both batch paths through stageInSession instead
// (`newline no`), the posture /stage-skill/:slug already uses.
//
// A route mock can distinguish neither "staged" from "submitted" nor "one
// combined command" from "two concatenated ones" — only reading a real
// session's contents can. Same precedent as backlog-batch-dispatch.spec.ts,
// wave-batch-run.spec.ts and qa-case-list.spec.ts.
//
// VM-only: importing ../fixtures/itermSessions.js runs
// assertIsolatedEnvironment() at module load, so this file refuses to load
// anywhere the developer's real ORCHESTRATOR_SESSION is reachable. Runs only
// via `npm run test:e2e:vm`, never `npm run test:e2e`.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TASKS_DIR = path.join(__dirname, '..', 'fixtures', 'tasks')
const ORCHESTRATOR_SESSION_PATH = path.join(TASKS_DIR, 'ORCHESTRATOR_SESSION')

// A shell prompt line ends with the shell's own marker; a submitted command
// leaves the pane with the typed text followed by a NEW prompt (or the
// command's own output) after it. Staged text is the last thing on the pane
// with nothing after it — that difference is the entire assertion of this
// file, so it is computed one way, here, rather than re-derived per test.
function stagedTextIsUnsent(contents: string, stagedText: string): boolean {
  const trimmed = contents.replace(/\s+$/, '')
  return trimmed.endsWith(stagedText.replace(/\s+$/, ''))
}

async function postBatch(baseURL: string, body: unknown): Promise<number> {
  const res = await fetch(`${baseURL}/batch-dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.status
}

test.describe('batch dispatch stages one unsent command in a real session', () => {
  test('a two-milestone wave batch leaves ONE combined command sitting unsent at the prompt', async ({ baseURL }) => {
    await withOrchestratorSessionLock(async () => {
      const sessionId = await openScratchSession()
      try {
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, sessionId + '\n')

        const status = await postBatch(baseURL!, {
          kind: 'wave',
          slugs: ['wave-batch-parent-m1', 'wave-batch-parent-m2'],
        })
        expect(status).toBe(200)

        const contents = await readSessionContents(sessionId)

        // One command carrying both milestones — not two separate ones.
        expect(contents).toContain('/cockpit-dev wave-batch-parent-m1')
        expect(contents).toContain('/cockpit-dev wave-batch-parent-m2')
        expect(contents).toContain('in parallel')

        // The regression that matters: it is STILL AT THE PROMPT. Before the
        // fix this text would have been submitted and gone, replaced by two
        // real dispatches spawning two real worktrees.
        expect(stagedTextIsUnsent(contents, '/cockpit-dev wave-batch-parent-m2')).toBe(true)
      } finally {
        await closeScratchSession(sessionId)
        await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
      }
    })
  })

  test('a backlog batch whose item context spans a line break still stages a single unbroken line', async ({ baseURL }) => {
    await withOrchestratorSessionLock(async () => {
      const sessionId = await openScratchSession()
      try {
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, sessionId + '\n')

        // The safety invariant, exercised end to end: an embedded newline
        // reaches iTerm2 as a real LF keystroke (escapeForAppleScriptString
        // maps \n through to the AppleScript literal), which IS a submit. A
        // BACKLOG.md entry's context legitimately sits on its own line, so
        // composeBatchMessage must collapse it before it ever gets here.
        const status = await postBatch(baseURL!, {
          kind: 'backlog',
          items: [
            { description: 'First integration item', context: 'context line one\nand line two' },
            { description: 'Second integration item' },
          ],
        })
        expect(status).toBe(200)

        const contents = await readSessionContents(sessionId)
        expect(contents).toContain('First integration item')
        expect(contents).toContain('Second integration item')
        // The words the orchestrator's promote flow keys on
        // (orchestrator-prompt.md) must survive composition.
        expect(contents).toContain('backlog items')
        expect(stagedTextIsUnsent(contents, 'Second integration item')).toBe(true)
      } finally {
        await closeScratchSession(sessionId)
        await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
      }
    })
  })

  test('two batches staged back-to-back concatenate visibly but neither is ever submitted', async ({ baseURL }) => {
    await withOrchestratorSessionLock(async () => {
      const sessionId = await openScratchSession()
      try {
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, sessionId + '\n')

        // tech-design.md's "Requirement 3" decision, proved rather than
        // assumed: batch dispatch takes /stage-skill/:slug's posture, which
        // has no pending guard either — a second batch typed before the
        // developer presses Return lands on the same prompt line. That is
        // accepted BECAUSE the result is benign: garbled, visible, and above
        // all UNSENT, so nothing runs and the developer clears the line.
        expect(await postBatch(baseURL!, { kind: 'wave', slugs: ['wave-batch-parent-m1'] })).toBe(200)
        expect(await postBatch(baseURL!, { kind: 'backlog', items: [{ description: 'Second batch item' }] })).toBe(200)

        const contents = await readSessionContents(sessionId)
        expect(contents).toContain('/cockpit-dev wave-batch-parent-m1')
        expect(contents).toContain('Second batch item')

        // Neither batch ran. The second batch's text is the last thing on the
        // pane, so no Return was ever pressed for either.
        expect(stagedTextIsUnsent(contents, 'Second batch item')).toBe(true)
      } finally {
        await closeScratchSession(sessionId)
        await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
      }
    })
  })
})
