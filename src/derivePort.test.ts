import { describe, it, expect } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { CANONICAL_REPO_PATH, derivePortForCwd, isCanonicalRepoPath, defaultPortForCwd } from './derivePort.js'

describe('derivePortForCwd', () => {
  it('is deterministic — the same cwd always derives the same port', () => {
    const a = derivePortForCwd('/Users/dev/Dev/worktrees/some-task', 3030, 1000)
    const b = derivePortForCwd('/Users/dev/Dev/worktrees/some-task', 3030, 1000)
    expect(a).toBe(b)
  })

  it('derives different ports for different worktree paths', () => {
    const a = derivePortForCwd('/Users/dev/Dev/worktrees/task-one', 3030, 1000)
    const b = derivePortForCwd('/Users/dev/Dev/worktrees/task-two', 3030, 1000)
    expect(a).not.toBe(b)
  })

  it('always falls inside [basePort, basePort + range)', () => {
    for (const cwd of ['/a', '/b', '/Users/dev/Dev/worktrees/x', '/Users/dev/Dev/worktrees/y-y-y']) {
      const port = derivePortForCwd(cwd, 3030, 1000)
      expect(port).toBeGreaterThanOrEqual(3030)
      expect(port).toBeLessThan(4030)
    }
  })

  it('resolves relative/non-normalized paths the same as their absolute form — a trailing slash or "." must not change the derived port', () => {
    const a = derivePortForCwd('/Users/dev/Dev/worktrees/some-task', 3030, 1000)
    const b = derivePortForCwd('/Users/dev/Dev/worktrees/some-task/', 3030, 1000)
    const c = derivePortForCwd('/Users/dev/Dev/worktrees/some-task/./', 3030, 1000)
    expect(b).toBe(a)
    expect(c).toBe(a)
  })
})

describe('isCanonicalRepoPath', () => {
  const canonical = CANONICAL_REPO_PATH

  it('is true for the canonical checkout path', () => {
    expect(isCanonicalRepoPath(canonical)) .toBe(true)
  })

  it('is true regardless of a trailing slash or non-normalized form', () => {
    expect(isCanonicalRepoPath(canonical + '/')).toBe(true)
    expect(isCanonicalRepoPath(path.join(canonical, '.'))).toBe(true)
  })

  it('is false for a worktree checkout', () => {
    expect(isCanonicalRepoPath(path.join(os.homedir(), 'Dev', 'worktrees', 'some-task'))).toBe(false)
  })

  it('is false for an unrelated path', () => {
    expect(isCanonicalRepoPath('/tmp/some-other-place')).toBe(false)
  })
})

describe('defaultPortForCwd', () => {
  const canonical = CANONICAL_REPO_PATH

  it('returns the fixed canonical port for the canonical checkout — bookmarks/docs assume it stays stable', () => {
    expect(defaultPortForCwd(canonical, 3030, 3030, 1000)).toBe(3030)
  })

  it('returns a derived port (matching derivePortForCwd against derivedBasePort) for a worktree checkout', () => {
    const worktree = path.join(os.homedir(), 'Dev', 'worktrees', 'some-task')
    expect(defaultPortForCwd(worktree, 3030, 4000, 500)).toBe(derivePortForCwd(worktree, 4000, 500))
  })

  it('keeps the canonical port and the derived range independent — a worktree never lands on canonicalPort\'s numbering scheme', () => {
    const worktree = path.join(os.homedir(), 'Dev', 'worktrees', 'some-task')
    const derived = defaultPortForCwd(worktree, 3099, 4000, 500)
    expect(derived).toBeGreaterThanOrEqual(4000)
    expect(derived).toBeLessThan(4500)
  })
})
