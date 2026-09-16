import crypto from 'node:crypto'
import path from 'node:path'
import os from 'node:os'

// The canonical, non-worktree checkout. Its port should stay the fixed,
// well-known default — bookmarks, browser tabs, and docs all assume it —
// rather than hashed per-path the way a worktree's scratch instance is.
// The path segment is written as a single joined literal, not as two
// separate path.join arguments, so oss/publish.sh's text-level path rewrite
// can find and rewrite it.
export const CANONICAL_REPO_PATH = path.join(os.homedir(), 'Dev/pipelinely')

export function isCanonicalRepoPath(cwd: string): boolean {
  return path.resolve(cwd) === CANONICAL_REPO_PATH
}

// Deterministically derives a port in [basePort, basePort + range) from
// `cwd`. Same cwd always yields the same port (stable across repeated
// `npm run dev` / `npx playwright test` runs in that worktree), while
// different worktrees hash to different offsets — this is what stops two
// worktrees' dev/e2e servers from silently colliding on one hardcoded port
// and cross-contaminating each other's requests: with Playwright's
// `reuseExistingServer`, or a developer just picking the well-known default
// for a manual `npm run dev`, whichever process binds a shared literal port
// first gets silently reused by every other concurrent worktree, serving its
// own fixtures/code against a request meant for a different one.
export function derivePortForCwd(cwd: string, basePort: number, range: number): number {
  const hash = crypto.createHash('sha256').update(path.resolve(cwd)).digest()
  const offset = hash.readUInt16BE(0) % range
  return basePort + offset
}

// The port a server or webServer config should default to for `cwd`, absent
// an explicit override: the fixed `canonicalPort` for the canonical
// checkout, or a value derived from `cwd` within [derivedBasePort,
// derivedBasePort + range) for any worktree. `canonicalPort` and
// `derivedBasePort` are separate on purpose — server.ts's dev server and
// playwright.config.ts's e2e webServer each keep their own historical fixed
// port for the canonical checkout, but their *derived* ranges must be
// disjoint from one another so a worktree's own dev server and e2e server
// (both alive at once, in the same worktree, during ordinary dev work) can
// never collide with each other, not just with other worktrees.
export function defaultPortForCwd(cwd: string, canonicalPort: number, derivedBasePort: number, range: number): number {
  return isCanonicalRepoPath(cwd) ? canonicalPort : derivePortForCwd(cwd, derivedBasePort, range)
}
