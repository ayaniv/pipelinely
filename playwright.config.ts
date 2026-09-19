import { defineConfig } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import { defaultPortForCwd } from './src/derivePort.js'
import { FIXTURE_REPOS_DIR, FIXTURE_TASKS_DIR, FIXTURE_WORKTREES_DIR } from './e2e/fixtures/fixtureDirs.js'
import { fakeGhEnv } from './e2e/fixtures/fakeGh.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Dedicated fixture TASKS_DIR/REPOS_DIR/WORKTREES_DIR (all checked into
// e2e/fixtures) so this suite never depends on — or mutates — whatever real
// tasks, repo checkouts, or worktrees happen to exist on the developer's own
// machine at the time. REPOS_DIR/WORKTREES_DIR matter for the
// merge/mark-done-cleanup routes specifically: those shell out to real
// `git`/`gh` against "<REPOS_DIR>/<task.repo>", so pointing that at fixture
// space (where no fixture repo name has a real checkout) keeps every git
// mutation this suite exercises confined to deterministic, git-level
// failures rather than touching anything real.
//
// The port itself is 3099 for the canonical checkout (unchanged), or stably
// derived from cwd for a worktree — a 4000-4499 range disjoint from
// server.ts's own 3030-3529 dev-server range, so a worktree's own dev server
// and its e2e webServer never collide with each other, and different
// worktrees' e2e runs don't silently collide with one another either
// (whichever binds the shared literal first used to answer every other
// worktree's requests too — see derivePort.ts).
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : defaultPortForCwd(__dirname, 3099, 4000, 500)

export default defineConfig({
  testDir: './e2e',
  // Playwright's own default testMatch also picks up *.test.ts — but
  // vitest.config.ts's own convention (see its comment) is that e2e/**/*.test.ts
  // are plain vitest unit tests for fixture helpers (e.g.
  // e2e/fixtures/itermSessions.test.ts, added alongside orchestrator auto
  // mode), not Playwright specs. Without this, Playwright tries to load
  // them too and crashes on their vi.mock calls — vitest's own mocker was
  // never initialized in a Playwright worker.
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  // Always starts its own fixture-scoped server and hard-errors on a port
  // conflict rather than adopting a stranger — the reservoir of stray
  // worktree `npm run dev` servers (each a fully-armed handle on whatever
  // TASKS_DIR it happened to bind) is exactly what let three real incidents
  // reach the developer's live orchestrator session. A port answering is
  // not proof of identity.
  webServer: {
    command: 'npx tsx src/server.ts',
    url: `http://localhost:${PORT}/api/tasks`,
    reuseExistingServer: false,
    env: {
      TASKS_DIR: FIXTURE_TASKS_DIR,
      REPOS_DIR: FIXTURE_REPOS_DIR,
      WORKTREES_DIR: FIXTURE_WORKTREES_DIR,
      // `gh` resolves to e2e/fixtures/bin/gh for this server — no e2e run can
      // reach a real GitHub PR, and the merge gate's PR states are canned.
      ...fakeGhEnv(),
      PORT: String(PORT),
      // See orchestratorLock.ts's own comment: without this, the "lock
      // already held" e2e test costs 15s of wall clock to prove a timeout
      // the same logic proves just as well at 10. This value is shared by
      // every e2e test on this server, not just that one — it must stay
      // comfortably above pasteIntoSession's real ~4s worst case (see
      // orchestratorLock.ts) so "two dispatches fired at once both land
      // intact" never mistakes the other writer's real critical section for
      // a stuck lock. 2000ms was tried first and was too tight: it's
      // shorter than that real critical section alone, which is exactly
      // what the "two dispatches" test waits out.
      COCKPIT_ORCH_LOCK_TIMEOUT_MS: '10000',
      // Browser auto-open is opt-in (COCKPIT_AUTO_OPEN_BROWSER, see
      // server.ts's own comment) and nothing here sets it, so this webServer
      // never pops a real browser tab without needing to say so explicitly.
      // Deliberately NOT setting COCKPIT_DISPATCH_ENABLED here — this
      // e2e-launched server must identify as non-canonical, the same as any
      // other process running src/server.ts outside the pipelinely
      // skill's own launch step, so its dispatch routes correctly 403
      // instead of being accidentally exempted from the canonical-dispatch
      // gate (see isCanonicalDispatchInstance in server.ts).
    },
  },
  // `ui` is the local-safe subset (`npm run test:e2e`) — everything except
  // e2e/integration/, which reaches real osascript/tmux/the real
  // orchestrator pointer files and refuses to load without an explicit,
  // freshly-granted consent token (see src/e2eIsolation.ts). `integration`
  // only runs via `npm run test:e2e:integration`.
  projects: [
    { name: 'ui', testDir: './e2e', testIgnore: /integration\// },
    { name: 'integration', testDir: './e2e/integration' },
  ],
})
