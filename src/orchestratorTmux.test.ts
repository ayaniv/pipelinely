import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { orchestratorTmuxPath, readOrchestratorTmux } from './orchestratorTmux.js'

let tasksDir: string

beforeEach(async () => {
  tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-tmux-test-'))
})

afterEach(async () => {
  await fs.rm(tasksDir, { recursive: true, force: true })
})

describe('readOrchestratorTmux', () => {
  it('returns the recorded session name, trimmed', async () => {
    await fs.writeFile(orchestratorTmuxPath(tasksDir), 'claude-orchestrator\n')
    expect(await readOrchestratorTmux(tasksDir)).toBe('claude-orchestrator')
  })

  it('returns null when the file is absent', async () => {
    expect(await readOrchestratorTmux(tasksDir)).toBeNull()
  })

  it('returns null when the file is blank', async () => {
    await fs.writeFile(orchestratorTmuxPath(tasksDir), '  \n')
    expect(await readOrchestratorTmux(tasksDir)).toBeNull()
  })

  it('throws on any other read failure, so a caller can fail closed', async () => {
    await fs.mkdir(orchestratorTmuxPath(tasksDir))
    await expect(readOrchestratorTmux(tasksDir)).rejects.toThrow()
  })
})
