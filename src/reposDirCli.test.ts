import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { REPOS_DIR_FILE } from './reposDir.js'

const tsxBin = path.resolve(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx')
const cliPath = path.resolve(import.meta.dirname, 'reposDirCli.ts')

let sandbox: string
let tasksDir: string
let homeDir: string

beforeEach(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repos-dir-cli-')))
  tasksDir = path.join(sandbox, 'tasks')
  homeDir = path.join(sandbox, 'home')
  fs.mkdirSync(tasksDir)
  fs.mkdirSync(homeDir)
})

afterEach(() => {
  for (const entry of fs.readdirSync(sandbox)) fs.chmodSync(path.join(sandbox, entry), 0o700)
  fs.rmSync(sandbox, { recursive: true, force: true })
})

function runCli(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, TASKS_DIR: tasksDir, INIT_CWD: sandbox }
  delete env.REPOS_DIR
  const result = spawnSync(tsxBin, [cliPath, ...args], { env, cwd: sandbox, encoding: 'utf-8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const savedValue = () => fs.readFileSync(path.join(tasksDir, REPOS_DIR_FILE), 'utf-8').trim()

describe('repos-dir set', () => {
  it('saves an existing readable directory and prints it as JSON', () => {
    const root = path.join(sandbox, 'root')
    fs.mkdirSync(root)

    const result = runCli(['set', root])

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ reposDir: root, source: 'file' })
    expect(savedValue()).toBe(root)
  })

  it('refuses a directory the user cannot read, naming it, exiting 1 and keeping the saved value', () => {
    const root = path.join(sandbox, 'root')
    const locked = path.join(sandbox, 'locked')
    fs.mkdirSync(root)
    fs.mkdirSync(locked)
    runCli(['set', root])
    fs.chmodSync(locked, 0o000)

    const result = runCli(['set', locked])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(locked)
    expect(savedValue()).toBe(root)
  })

  it('refuses a nonexistent path with exit 1 and writes nothing', () => {
    const result = runCli(['set', path.join(sandbox, 'missing')])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('missing')
    expect(fs.existsSync(path.join(tasksDir, REPOS_DIR_FILE))).toBe(false)
  })
})

describe('repos-dir (resolve)', () => {
  it('falls back to the default and warns once when the saved root was deleted', () => {
    fs.writeFileSync(path.join(tasksDir, REPOS_DIR_FILE), `${path.join(sandbox, 'gone')}\n`)

    const result = runCli([])

    expect(JSON.parse(result.stdout)).toEqual({ reposDir: path.join(homeDir, 'Dev'), source: 'default' })
    expect(result.stderr).toContain('gone')
  })

  it('falls back to the default silently when there is no saved file', () => {
    const result = runCli([])

    expect(JSON.parse(result.stdout)).toEqual({ reposDir: path.join(homeDir, 'Dev'), source: 'default' })
    expect(result.stderr).toBe('')
  })
})
