import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The checked-in fixture TASKS_DIR/REPOS_DIR/WORKTREES_DIR — one definition
// shared by playwright.config.ts's webServer and any spec that spawns its
// own process against the same data (e2e/cockpit-merge-gate.spec.ts runs the
// /cockpit-merge CLI directly), so the two can never point at different
// fixture trees.
export const FIXTURE_TASKS_DIR = path.join(__dirname, 'tasks')
export const FIXTURE_REPOS_DIR = path.join(__dirname, 'repos')
export const FIXTURE_WORKTREES_DIR = path.join(__dirname, 'worktrees')
