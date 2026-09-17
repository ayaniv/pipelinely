import { describe, test, expect } from 'vitest'
import { execa } from 'execa'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const CLI = path.join(__dirname, 'pipelinelyOnboardCli.ts')

describe('pipelinely-onboard CLI', () => {
  test('a fresh target repo with no .pipelinely/pipeline.yml reports alreadyOnboarded: false and flags plan-review as ambiguous', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipelinely-onboard-'))
    await execa('git', ['init', '-q', dir])
    const result = await execa('tsx', [CLI, dir], { reject: false })
    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.alreadyOnboarded).toBe(false)
    expect(parsed.ambiguous).toContain('plan-review')
    await fs.rm(dir, { recursive: true, force: true })
  })

  test('a target repo that already has .pipelinely/pipeline.yml reports alreadyOnboarded: true', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipelinely-onboard-existing-'))
    await fs.mkdir(path.join(dir, '.pipelinely'), { recursive: true })
    await fs.writeFile(path.join(dir, '.pipelinely/pipeline.yml'), 'stages: []\n')
    const result = await execa('tsx', [CLI, dir], { reject: false })
    expect(JSON.parse(result.stdout).alreadyOnboarded).toBe(true)
    await fs.rm(dir, { recursive: true, force: true })
  })

  test('--confirm-plan-review=false writes config files and reports configWritten', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipelinely-onboard-confirm-'))
    await execa('git', ['init', '-q', dir])
    const result = await execa('tsx', [CLI, dir, '--confirm-plan-review=false'], { reject: false })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout).configWritten).toBe(true)
    expect(await fs.readFile(path.join(dir, '.pipelinely/pipeline.yml'), 'utf-8')).toContain('stages:')
    await fs.rm(dir, { recursive: true, force: true })
  })

  test('onboarding a subdirectory writes config at the repo root, and a second run against that same subdirectory reports alreadyOnboarded: true', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipelinely-onboard-subdir-'))
    await execa('git', ['init', '-q', repoDir])
    const subDir = path.join(repoDir, 'packages/web')
    await fs.mkdir(subDir, { recursive: true })

    const firstRun = await execa('tsx', [CLI, subDir, '--confirm-plan-review=false'], { reject: false })
    expect(firstRun.exitCode).toBe(0)
    expect(JSON.parse(firstRun.stdout).configWritten).toBe(true)
    // Config must land at the repo root, not the subdirectory.
    expect(await fs.readFile(path.join(repoDir, '.pipelinely/pipeline.yml'), 'utf-8')).toContain('stages:')
    await expect(fs.access(path.join(subDir, '.pipelinely/pipeline.yml'))).rejects.toThrow()

    const secondRun = await execa('tsx', [CLI, subDir], { reject: false })
    expect(secondRun.exitCode).toBe(0)
    expect(JSON.parse(secondRun.stdout).alreadyOnboarded).toBe(true)

    await fs.rm(repoDir, { recursive: true, force: true })
  })

  test('failure path: missing target directory argument exits non-zero with a clear message', async () => {
    const result = await execa('tsx', [CLI], { reject: false })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('Usage: pipelinely-onboard <target-dir>')
  })

  test('failure path: an underlying write failure exits non-zero with a clean single-line message, not a raw stack trace', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipelinely-onboard-writefail-'))
    await execa('git', ['init', '-q', dir])
    // Pre-create a regular file at the exact path writeProjectConfig needs as
    // a directory, so its fs.mkdir(configDir, { recursive: true }) throws
    // EEXIST — a realistic stand-in for permission-denied/disk-full/symlink
    // races that aren't caught anywhere upstream of main().
    await fs.writeFile(path.join(dir, '.pipelinely'), 'not a directory')
    const result = await execa('tsx', [CLI, dir, '--confirm-plan-review=false'], { reject: false })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.trim().split('\n')).toHaveLength(1)
    expect(result.stderr).not.toContain('at ')
    expect(result.stderr).not.toContain('UnhandledPromiseRejection')
    await fs.rm(dir, { recursive: true, force: true })
  })
})
