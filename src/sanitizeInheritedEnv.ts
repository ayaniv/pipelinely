// Vars that have repeatedly been found leaking into a reused iTerm2 tab's
// shell and staying there indefinitely — a prior dispatch's own
// COCKPIT_TASK_SLUG/COCKPIT_STAGE, a manual `export BROWSER=none`/
// `PLAYWRIGHT_TEST=1` typed once to silence Playwright's HTML-report
// auto-open, or a stale REPOS_DIR/TASKS_DIR/WORKTREES_DIR from an e2e run.
// Documented here as the single reference list; orchestrator-prompt.md's
// launch.sh template unsets all seven of these for a freshly dispatched
// worker tab, which never has a legitimate reason to inherit any of them.
//
// sanitizeInheritedEnv below does NOT default to this whole list — REPOS_DIR/
// TASKS_DIR/WORKTREES_DIR are legitimately, deliberately set on src/server.ts
// itself in one sanctioned case (playwright.config.ts's webServer.env,
// pointing e2e runs at fixture directories), so a caller must opt in
// explicitly to stripping those three rather than have them silently
// dropped by a shared default.
export const LEAKED_ENV_VARS = [
  'REPOS_DIR',
  'TASKS_DIR',
  'WORKTREES_DIR',
  'BROWSER',
  'PLAYWRIGHT_TEST',
  'COCKPIT_TASK_SLUG',
  'COCKPIT_STAGE',
] as const

// Call once, as the very first thing a long-lived or standalone entrypoint
// does — before any other code reads process.env — so a tab's leftover
// dispatch/e2e env can't silently sabotage an execa call that inherits
// process.env by default (e.g. `gh --web` picking up a poisoned BROWSER).
// Takes an explicit key list rather than defaulting to LEAKED_ENV_VARS: which
// of these a given entrypoint can safely strip depends on what it legitimately
// accepts as an override, so the caller states that itself instead of a
// shared default silently deciding it.
export function sanitizeInheritedEnv(keys: readonly string[]): void {
  for (const key of keys) {
    delete process.env[key]
  }
}

// The subset of LEAKED_ENV_VARS that src/server.ts strips unconditionally at
// startup — derived from the single reference list above instead of a
// second, independently-typed literal, so the two can't drift out of sync.
// Excludes REPOS_DIR/TASKS_DIR/WORKTREES_DIR: see the file-level comment on
// why those three are never safe to strip at server startup.
export const SERVER_STARTUP_LEAK_VARS = LEAKED_ENV_VARS.filter(
  (key) => key !== 'REPOS_DIR' && key !== 'TASKS_DIR' && key !== 'WORKTREES_DIR',
)
