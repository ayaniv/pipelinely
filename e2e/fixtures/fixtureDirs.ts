import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The checked-in fixture TASKS_DIR/REPOS_DIR/WORKTREES_DIR — one definition
// shared by playwright.config.ts's webServer and any spec that spawns its
// own process against the same data (e2e/pipelinely-merge-gate.spec.ts runs the
// /pipelinely-merge CLI directly), so the two can never point at different
// fixture trees.
export const FIXTURE_TASKS_DIR = path.join(__dirname, 'tasks')
export const FIXTURE_REPOS_DIR = path.join(__dirname, 'repos')
export const FIXTURE_WORKTREES_DIR = path.join(__dirname, 'worktrees')

// The remote-access token the fixture server reads in place of the real
// ~/.config/pipelinely/remote-token. e2e/remote-auth.spec.ts writes and
// deletes it per test, so it is gitignored scratch, never a checked-in secret.
export const FIXTURE_REMOTE_TOKEN_FILE = path.join(__dirname, 'remote-token', 'token')

// The fixture server's bookmarks folder, in place of the real
// ~/.config/pipelinely/bookmarks. Gitignored scratch: e2e/bookmarks-page.spec.ts
// empties and re-seeds it per test with invented bookmarks only, and
// src/bookmarksPrivacy.test.ts proves it can never be committed.
export const FIXTURE_BOOKMARKS_DIR = path.join(__dirname, 'bookmarks')
