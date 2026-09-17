import { describe, test, expect } from 'vitest'
import { validateEnvironment } from './pipelinelyValidate.js'

describe('validateEnvironment', () => {
  test('all checks passing reports ok with no failures', async () => {
    const result = await validateEnvironment(async () => ({ exitCode: 0 }))
    expect(result).toEqual({ ok: true, failures: [] })
  })

  test('failure path: a missing binary is named, not swallowed, and does not stop other checks from also being reported', async () => {
    const result = await validateEnvironment(async (cmd) => ({ exitCode: cmd === 'tmux' ? 127 : 0 }))
    expect(result.ok).toBe(false)
    expect(result.failures).toEqual(['tmux not found on PATH'])
  })

  test('failure path: multiple missing dependencies are all named', async () => {
    const result = await validateEnvironment(async (cmd) => ({ exitCode: cmd === 'tmux' || cmd === 'gh' ? 127 : 0 }))
    expect(result.failures).toEqual(['tmux not found on PATH', 'gh not found on PATH, or not authenticated'])
  })
})
