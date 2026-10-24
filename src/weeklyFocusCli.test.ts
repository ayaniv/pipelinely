import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tsxBin = path.resolve(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx')
const cliPath = path.resolve(import.meta.dirname, 'weeklyFocusCli.ts')

let tasksDir: string

beforeEach(() => {
  tasksDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-focus-cli-')))
})

afterEach(() => {
  fs.rmSync(tasksDir, { recursive: true, force: true })
})

function runCli(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, TASKS_DIR: tasksDir }
  const result = spawnSync(tsxBin, [cliPath, ...args], { env, cwd: tasksDir, encoding: 'utf-8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const writeSettings = (content: string) => fs.writeFileSync(path.join(tasksDir, 'SETTINGS.json'), content)
const writeFocus = (content: string) => fs.writeFileSync(path.join(tasksDir, 'WEEKLY_FOCUS'), content)

describe('weekly-focus get', () => {
  it('prints the stored focus while the setting is on', () => {
    writeFocus('ship the board\n')
    expect(runCli(['get'])).toEqual({ status: 0, stdout: 'ship the board\n', stderr: '' })
  })

  it('prints the stored focus when there is no settings file', () => {
    writeSettings('{"autoMode": false}')
    writeFocus('ship the board')
    expect(runCli(['get']).stdout).toBe('ship the board\n')
  })

  it('prints nothing while the setting is off, even with a stored focus', () => {
    writeSettings('{"weeklyFocusEnabled": false}')
    writeFocus('ship the board')
    expect(runCli(['get'])).toEqual({ status: 0, stdout: '', stderr: '' })
  })

  it('prints nothing when no focus is stored', () => {
    expect(runCli(['get'])).toEqual({ status: 0, stdout: '', stderr: '' })
  })

  it('treats an invalid setting value as on', () => {
    writeSettings('{"weeklyFocusEnabled": "no"}')
    writeFocus('ship the board')
    expect(runCli(['get']).stdout).toBe('ship the board\n')
  })

  it('leaves the stored file untouched', () => {
    writeSettings('{"weeklyFocusEnabled": false}')
    writeFocus('ship the board')
    runCli(['get'])
    expect(fs.readFileSync(path.join(tasksDir, 'WEEKLY_FOCUS'), 'utf-8')).toBe('ship the board')
  })
})

describe('weekly-focus failures are loud', () => {
  it('exits 1 with the reason on stderr when the stored focus cannot be read, rather than printing nothing', () => {
    fs.mkdirSync(path.join(tasksDir, 'WEEKLY_FOCUS'))   // EISDIR: exists but unreadable as a file
    const { status, stdout, stderr } = runCli(['get'])
    expect(status).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('EISDIR')
  })

  it('exits 1 naming the directory when TASKS_DIR does not exist, rather than reading it as "no focus"', () => {
    const missing = path.join(tasksDir, 'does-not-exist')
    const env: NodeJS.ProcessEnv = { ...process.env, TASKS_DIR: missing }
    const result = spawnSync(tsxBin, [cliPath, 'get'], { env, cwd: tasksDir, encoding: 'utf-8' })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(missing)
  })

  it('exits 1 when TASKS_DIR is a file, not a directory', () => {
    const file = path.join(tasksDir, 'a-file')
    fs.writeFileSync(file, '')
    const env: NodeJS.ProcessEnv = { ...process.env, TASKS_DIR: file }
    const result = spawnSync(tsxBin, [cliPath, 'get'], { env, cwd: tasksDir, encoding: 'utf-8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(file)
  })

  it('exits 1 when no TASKS_DIR is given from a non-canonical cwd', () => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.TASKS_DIR
    const result = spawnSync(tsxBin, [cliPath, 'get'], { env, cwd: tasksDir, encoding: 'utf-8' })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('TASKS_DIR')
  })
})

describe('weekly-focus usage errors', () => {
  it.each([[[]], [['set']], [['get', 'extra']]])('exits 1 with a usage line for %j', (args) => {
    const { status, stdout, stderr } = runCli(args)
    expect(status).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('Usage: weekly-focus get')
  })
})
