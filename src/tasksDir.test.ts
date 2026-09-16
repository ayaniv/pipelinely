import { describe, it, expect } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { CANONICAL_REPO_PATH } from './derivePort.js'
import { resolveTasksDir } from './tasksDir.js'

const canonical = CANONICAL_REPO_PATH
const worktree = path.join(os.homedir(), 'Dev', 'worktrees', 'some-task')

describe('resolveTasksDir', () => {
  it('returns the resolved env value when TASKS_DIR is set, regardless of cwd', () => {
    expect(resolveTasksDir(worktree, '/explicit/tasks')).toBe(path.resolve('/explicit/tasks'))
  })

  it('resolves a relative env value against the current process cwd', () => {
    expect(resolveTasksDir(canonical, './relative-tasks')).toBe(path.resolve('./relative-tasks'))
  })

  it('returns the real default for the canonical checkout when no env value is set', () => {
    expect(resolveTasksDir(canonical, undefined)).toBe(path.join(CANONICAL_REPO_PATH, 'tasks'))
  })

  it('throws naming both remedies for a worktree with no explicit TASKS_DIR', () => {
    expect(() => resolveTasksDir(worktree, undefined)).toThrow(/TASKS_DIR/)
  })

  it('throws naming the worktree scratch-fixtures remedy specifically', () => {
    expect(() => resolveTasksDir(worktree, undefined)).toThrow(/e2e\/fixtures\/tasks/)
  })

  it('throws naming the deliberate-real-data remedy specifically', () => {
    expect(() => resolveTasksDir(worktree, undefined)).toThrow(path.join(CANONICAL_REPO_PATH, 'tasks'))
  })
})
