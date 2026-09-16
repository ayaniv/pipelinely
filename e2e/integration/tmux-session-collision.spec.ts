import { test, expect } from '@playwright/test'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { withOrchestratorSessionLock } from '../fixtures/orchestratorSessionLock.js'
import {
  openScratchSession,
  closeScratchSession,
  readSessionContents,
  typeIntoSession,
  sessionTty,
  tmuxClientTtys,
  tmuxSessionIsLive,
  createOrchestratorTmuxSession,
  killTmuxSession,
  countWindows,
  tabCountForWindowOfSession,
} from '../fixtures/itermSessions.js'

// M1 coverage for FINDINGS.md's Mechanism B and the window-ambiguity note
// that follows it — the two ways a tab this codebase opens can end up
// somewhere other than where the dispatcher meant:
//
//  1. `tmux new -A` in the dispatch command. `-A` means "attach if a session
//     by this name already exists, otherwise create it", so a name collision
//     — a `done` task's session that outlived its kill, or a same-slug
//     dispatch racing this one — silently drops the new tab into a stranger's
//     live conversation rather than running the freshly written launch
//     script. Every guard against that today is check-then-act with real
//     wall-clock time (a Write call, an osascript round trip, a brand-new
//     shell starting) between the check and the create.
//
//  2. `tell current window` in openNewTabRunning. iTerm2's "current window"
//     is application-global state — whichever window the OS most recently
//     made frontmost, which on this machine is any of a dozen live worker
//     tabs. A tab created that way lands in whatever window that happens to
//     be, not in anything scoped to the request that asked for it.
//
// The collision tests deliberately do NOT try to win a race: a TOCTOU window
// measured in milliseconds is not something a test can schedule reliably.
// They assert the invariant the fix actually rests on instead — that the
// dispatch command shape, run against a name that is already taken, refuses
// loudly and does not join the existing session — which is deterministic,
// and is the property that makes the remaining race harmless.
//
// Real osascript/tmux throughout, no mocking — see fixtures/itermSessions.ts.
// Session names carry the worker's pid so parallel workers cannot collide.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(__dirname, '..', '..')
const TASKS_DIR = path.join(__dirname, '..', 'fixtures', 'tasks')
const ORCHESTRATOR_SESSION_PATH = path.join(TASKS_DIR, 'ORCHESTRATOR_SESSION')
const ORCHESTRATOR_TMUX_PATH = path.join(TASKS_DIR, 'ORCHESTRATOR_TMUX')

const TAKEN_SESSION_NAME = `cockpit-e2e-collision-${process.pid}`
const FREE_SESSION_NAME = `cockpit-e2e-fresh-${process.pid}`
const REATTACH_SESSION_NAME = `cockpit-e2e-window-${process.pid}`
const DEAD_SESSION_ID = 'dead-orchestrator-session-not-real'

// The marker the dispatch command prints when tmux refuses to create the
// session. Must stay in sync with orchestrator-prompt.md, the handover
// skill, and src/focusTab.ts's openAnnotationSession — if the marker is
// renamed in one place and not the others, the collision is silent again in
// whichever copy was missed.
const COLLISION_MARKER = 'COCKPIT_TMUX_COLLISION'

// The exact command shape every dispatch types into its new tab, with the
// long-running payload standing in for `bash '<...>/launch.sh'`. One builder,
// not a literal per test, so the two collision tests below are provably
// exercising the same string.
function dispatchCommandFor(tmuxSession: string): string {
  return `tmux new-session -s '${tmuxSession}' "bash -c 'sleep 120'" || echo ${COLLISION_MARKER}`
}

async function clearPointers(): Promise<void> {
  await fs.rm(ORCHESTRATOR_SESSION_PATH, { force: true })
  await fs.rm(ORCHESTRATOR_TMUX_PATH, { force: true })
}

test.describe('tmux dispatch — a taken session name fails loudly instead of attaching', () => {
  test('the dispatch command refuses to join a session that already owns its name', async () => {
    // The failure path, and the whole point of dropping `-A`: the tab must
    // end up attached to NOTHING rather than silently attached to somebody
    // else's running claude.
    await createOrchestratorTmuxSession(TAKEN_SESSION_NAME)
    const sessionId = await openScratchSession()
    try {
      expect(await tmuxSessionIsLive(TAKEN_SESSION_NAME)).toBe(true)
      const ttysBefore = await tmuxClientTtys(TAKEN_SESSION_NAME)

      await typeIntoSession(sessionId, dispatchCommandFor(TAKEN_SESSION_NAME))

      // Loud: the developer sees a marker in an otherwise-empty tab.
      await expect.poll(() => readSessionContents(sessionId)).toContain(COLLISION_MARKER)

      // And genuinely not attached — the assertion that fails with `-A`,
      // where this tab would have become a client of the existing session.
      const tty = await sessionTty(sessionId)
      expect(tty).not.toBeNull()
      expect(await tmuxClientTtys(TAKEN_SESSION_NAME)).not.toContain(tty)
      expect(await tmuxClientTtys(TAKEN_SESSION_NAME)).toEqual(ttysBefore)
    } finally {
      await closeScratchSession(sessionId)
      await killTmuxSession(TAKEN_SESSION_NAME)
    }
  })

  test('the same command against a free name really does start and attach the session', async () => {
    // The happy path for the identical string — without this, the test above
    // would pass just as well against a command that never works at all.
    const sessionId = await openScratchSession()
    try {
      expect(await tmuxSessionIsLive(FREE_SESSION_NAME)).toBe(false)

      await typeIntoSession(sessionId, dispatchCommandFor(FREE_SESSION_NAME))

      await expect.poll(() => tmuxSessionIsLive(FREE_SESSION_NAME)).toBe(true)
      const tty = await sessionTty(sessionId)
      expect(tty).not.toBeNull()
      await expect.poll(() => tmuxClientTtys(FREE_SESSION_NAME)).toContain(tty)
      expect(await readSessionContents(sessionId)).not.toContain(COLLISION_MARKER)
    } finally {
      await closeScratchSession(sessionId)
      await killTmuxSession(FREE_SESSION_NAME)
    }
  })
})

test.describe('tmux dispatch — no copy of the pattern still carries -A', () => {
  // `tmux new -A` lives in prose (orchestrator-prompt.md, the handover
  // skill) as much as in code, and prose copies are exactly what drifts back
  // after a fix. A grep-shaped assertion is the only thing that keeps the
  // three copies honest; nothing else in this suite can see the two Markdown
  // ones at all.
  const DISPATCH_SOURCES = [
    'orchestrator-prompt.md',
    '.claude/skills/handover/SKILL.md',
    'src/focusTab.ts',
  ]

  // Matches `tmux new -A`, `tmux new-session -A`, and the flag bundled with
  // others (`-As`, `-dA`), across any run of whitespace.
  const ATTACH_IF_EXISTS_RE = /tmux\s+new(-session)?\s+(-\w*A\w*\s|-\w*A$)/m

  for (const relativePath of DISPATCH_SOURCES) {
    test(`${relativePath} builds its dispatch command without tmux's attach-if-exists flag`, async () => {
      const content = await fs.readFile(path.join(REPO_ROOT, relativePath), 'utf-8')
      expect(content).not.toMatch(ATTACH_IF_EXISTS_RE)
      // ...and still actually dispatches, so deleting the line is not a way
      // to make this pass.
      expect(content).toContain('tmux new-session')
    })
  }
})

test.describe('tab creation — a dispatched tab gets its own window, not iTerm2’s ambient current one', () => {
  test('a reattach opens a dedicated window rather than appending a tab to whatever was frontmost', async ({ page }) => {
    // openNewTabRunning's `tell current window` resolves to application-global
    // state that no request controls. Scoping tab creation to a window this
    // dispatch created itself is what makes "where did that tab go?"
    // answerable — and is what stops a dispatched tab from materializing
    // inside a developer's working window mid-task.
    await withOrchestratorSessionLock(async () => {
      await createOrchestratorTmuxSession(REATTACH_SESSION_NAME)
      // A scratch window of its own, open for the whole test, so iTerm2's
      // "current window" is demonstrably NOT the one the reattach should
      // land in — if the fix regresses, the new tab appears in this window
      // and its tab count goes to 2.
      const bystanderSessionId = await openScratchSession()
      let reattachedSessionId = ''
      try {
        expect(await tmuxSessionIsLive(REATTACH_SESSION_NAME)).toBe(true)
        await clearPointers()
        await fs.writeFile(ORCHESTRATOR_TMUX_PATH, REATTACH_SESSION_NAME + '\n')
        await fs.writeFile(ORCHESTRATOR_SESSION_PATH, DEAD_SESSION_ID + '\n')

        const windowsBefore = await countWindows()

        const res = await page.request.post('/orchestrator/tab')
        expect(res.status()).toBe(200)

        await expect
          .poll(async () => (await fs.readFile(ORCHESTRATOR_SESSION_PATH, 'utf-8').catch(() => '')).trim())
          .not.toBe(DEAD_SESSION_ID)
        reattachedSessionId = (await fs.readFile(ORCHESTRATOR_SESSION_PATH, 'utf-8')).trim()
        expect(reattachedSessionId).not.toBe('')

        // Its own window: one more window than before, and the reattached
        // session is the only tab in the window that holds it.
        expect(await countWindows()).toBe(windowsBefore + 1)
        expect(await tabCountForWindowOfSession(reattachedSessionId)).toBe(1)
        // The bystander window was left exactly as it was.
        expect(await tabCountForWindowOfSession(bystanderSessionId)).toBe(1)
      } finally {
        await clearPointers()
        if (reattachedSessionId) await closeScratchSession(reattachedSessionId)
        await closeScratchSession(bystanderSessionId)
        await killTmuxSession(REATTACH_SESSION_NAME)
      }
    })
  })
})
