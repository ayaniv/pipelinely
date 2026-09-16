import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIXTURE_REPOS_DIR } from './fixtureDirs.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FAKE_GH_BIN_DIR = path.join(__dirname, 'bin')
const MERGE_CALLS_DIR = path.join(__dirname, 'gh', 'merge-calls')
const DELETE_REF_CALLS_DIR = path.join(__dirname, 'gh', 'delete-ref-calls')

// Matches e2e/fixtures/bin/gh's own sanitization for a branch name (which
// contains "/") turned into a filename.
function safeBranchFilename(branch: string): string {
  return branch.replace(/\//g, '__')
}

// Environment that makes a process resolve `gh` to the fixture stand-in in
// e2e/fixtures/bin/gh (see that script's own comment) — applied to the
// webServer in playwright.config.ts and to every CLI process a spec spawns.
export function fakeGhEnv(): Record<string, string> {
  return {
    PATH: `${FAKE_GH_BIN_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
    // merge-gate-repo is a plain directory inside this repo's own checkout.
    // Without a ceiling, a `git worktree remove` run there walks up and acts
    // on the enclosing cockpit-ai checkout instead of failing the way a
    // missing fixture repo is meant to.
    GIT_CEILING_DIRECTORIES: FIXTURE_REPOS_DIR,
    // PR #908's fixture reports mergeable UNKNOWN forever; the real 2s
    // re-read delay would only add wall clock to prove the same refusal.
    COCKPIT_MERGEABILITY_RETRY_DELAY_MS: '50',
  }
}

// What the fake gh recorded for `gh pr merge <prNumber>`, or null if it was
// never called — the proof a blocked merge really didn't reach GitHub.
export async function readMergeCalls(prNumber: number): Promise<string | null> {
  try {
    return await fs.readFile(path.join(MERGE_CALLS_DIR, `${prNumber}.log`), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function clearMergeCalls(prNumber: number): Promise<void> {
  await fs.rm(path.join(MERGE_CALLS_DIR, `${prNumber}.log`), { force: true })
}

// What the fake gh recorded for `gh api -X DELETE .../refs/heads/<branch>`,
// or null if it was never called — the proof a blocked/refused merge never
// touched the remote branch either.
export async function readDeleteRefCalls(branch: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(DELETE_REF_CALLS_DIR, `${safeBranchFilename(branch)}.log`), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function clearDeleteRefCalls(branch: string): Promise<void> {
  await fs.rm(path.join(DELETE_REF_CALLS_DIR, `${safeBranchFilename(branch)}.log`), { force: true })
}
