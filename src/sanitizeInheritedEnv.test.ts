import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LEAKED_ENV_VARS, SERVER_STARTUP_LEAK_VARS, sanitizeInheritedEnv } from './sanitizeInheritedEnv.js'

const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of LEAKED_ENV_VARS) savedEnv[key] = process.env[key]
})

afterEach(() => {
  for (const key of LEAKED_ENV_VARS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

describe('sanitizeInheritedEnv', () => {
  it('deletes every key it is given that is currently set', () => {
    process.env.BROWSER = 'none'
    process.env.PLAYWRIGHT_TEST = '1'

    sanitizeInheritedEnv(['BROWSER', 'PLAYWRIGHT_TEST'])

    expect(process.env.BROWSER).toBeUndefined()
    expect(process.env.PLAYWRIGHT_TEST).toBeUndefined()
  })

  it('does not throw and leaves nothing behind for a key that was never set', () => {
    delete process.env.COCKPIT_TASK_SLUG

    expect(() => sanitizeInheritedEnv(['COCKPIT_TASK_SLUG'])).not.toThrow()
    expect(process.env.COCKPIT_TASK_SLUG).toBeUndefined()
  })

  it('leaves a key untouched when it is not in the given list', () => {
    process.env.WORKTREES_DIR = '/some/worktrees'

    sanitizeInheritedEnv(['BROWSER'])

    expect(process.env.WORKTREES_DIR).toBe('/some/worktrees')
  })
})

describe('SERVER_STARTUP_LEAK_VARS', () => {
  it('excludes REPOS_DIR/TASKS_DIR/WORKTREES_DIR, which playwright.config.ts legitimately sets', () => {
    expect(SERVER_STARTUP_LEAK_VARS).not.toContain('REPOS_DIR')
    expect(SERVER_STARTUP_LEAK_VARS).not.toContain('TASKS_DIR')
    expect(SERVER_STARTUP_LEAK_VARS).not.toContain('WORKTREES_DIR')
  })

  it('is derived from LEAKED_ENV_VARS, not an independent copy — every other leaked var is included', () => {
    const expected = LEAKED_ENV_VARS.filter(
      (key) => key !== 'REPOS_DIR' && key !== 'TASKS_DIR' && key !== 'WORKTREES_DIR',
    )
    expect([...SERVER_STARTUP_LEAK_VARS]).toEqual(expected)
  })
})
