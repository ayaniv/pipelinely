import { describe, test, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execa } from 'execa'
import { detectProject } from './pipelinelyDetect.js'

describe('detectProject', () => {
  test('detects npm via package-lock.json and its test/lint/typecheck scripts', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipelinely-detect-'))
    await fs.writeFile(path.join(dir, 'package-lock.json'), '{}')
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit' } })
    )
    const result = await detectProject(dir)
    expect(result.packageManager).toBe('npm')
    expect(result.scripts).toEqual({ test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit' })
    await fs.rm(dir, { recursive: true, force: true })
  })

  test('failure path: no lockfile and no scripts — reports null, not a throw', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipelinely-detect-empty-'))
    const result = await detectProject(dir)
    expect(result.packageManager).toBeNull()
    expect(result.scripts).toEqual({ test: null, lint: null, typecheck: null })
    expect(result.isGitRepo).toBe(false)
    await fs.rm(dir, { recursive: true, force: true })
  })

  test('detects an existing CLAUDE.md and .claude/skills/ without reading their content', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipelinely-detect-claude-'))
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), '# conventions')
    await fs.mkdir(path.join(dir, '.claude/skills/my-skill'), { recursive: true })
    const result = await detectProject(dir)
    expect(result.hasClaudeMd).toBe(true)
    expect(result.existingSkillDirs).toEqual(['my-skill'])
    await fs.rm(dir, { recursive: true, force: true })
  })

  test('malformed package.json — does not throw, reports scripts as null', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipelinely-detect-malformed-'))
    await fs.writeFile(path.join(dir, 'package.json'), '{ not valid json')
    const result = await detectProject(dir)
    expect(result.scripts).toEqual({ test: null, lint: null, typecheck: null })
    await fs.rm(dir, { recursive: true, force: true })
  })

  test('a subdirectory of a git repo resolves repoRoot to the repo toplevel, not the subdirectory', async () => {
    const repoRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pipelinely-detect-subdir-')))
    await execa('git', ['init', '-q', repoRoot])
    const subDir = path.join(repoRoot, 'packages', 'web')
    await fs.mkdir(subDir, { recursive: true })
    const result = await detectProject(subDir)
    expect(result.isGitRepo).toBe(true)
    expect(result.repoRoot).toBe(repoRoot)
    await fs.rm(repoRoot, { recursive: true, force: true })
  })
})
