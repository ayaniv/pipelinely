import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { REPOS_DIR_FILE, resolveReposDir, validateReposRoot, writeReposDir } from './reposDir.js'

let tasksDir: string
let homeDir: string

beforeEach(() => {
  tasksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repos-dir-tasks-'))
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repos-dir-home-'))
})

const madeDirs: string[] = []
function makeDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repos-dir-root-')))
  madeDirs.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of madeDirs.splice(0)) {
    fs.chmodSync(dir, 0o700)
    fs.rmSync(dir, { recursive: true, force: true })
  }
  fs.rmSync(tasksDir, { recursive: true, force: true })
  fs.rmSync(homeDir, { recursive: true, force: true })
})

describe('resolveReposDir', () => {
  it('prefers the env value over the saved file and the default', () => {
    fs.writeFileSync(path.join(tasksDir, REPOS_DIR_FILE), '/saved/root\n')

    expect(resolveReposDir({ envValue: '/from/env', tasksDir, homeDir })).toEqual({ reposDir: '/from/env', source: 'env' })
  })

  it('uses the saved file when no env value is set', () => {
    const root = makeDir()
    fs.writeFileSync(path.join(tasksDir, REPOS_DIR_FILE), `${root}\n`)

    expect(resolveReposDir({ envValue: undefined, tasksDir, homeDir })).toEqual({ reposDir: root, source: 'file' })
  })

  it('treats an empty env value as unset', () => {
    fs.writeFileSync(path.join(tasksDir, REPOS_DIR_FILE), `${makeDir()}\n`)

    expect(resolveReposDir({ envValue: '', tasksDir, homeDir }).source).toBe('file')
  })

  it('falls back to $HOME/Dev when there is no env value and no file', () => {
    expect(resolveReposDir({ envValue: undefined, tasksDir, homeDir })).toEqual({
      reposDir: path.join(homeDir, 'Dev'),
      source: 'default',
    })
  })

  it('trims whitespace and newlines around the saved path', () => {
    const root = makeDir()
    fs.writeFileSync(path.join(tasksDir, REPOS_DIR_FILE), `  \n  ${root}  \n\n`)

    expect(resolveReposDir({ envValue: undefined, tasksDir, homeDir }).reposDir).toBe(root)
  })

  it('treats a whitespace-only file as not set', () => {
    fs.writeFileSync(path.join(tasksDir, REPOS_DIR_FILE), '  \n')

    expect(resolveReposDir({ envValue: undefined, tasksDir, homeDir }).source).toBe('default')
  })

  it('logs and falls back to the default when the file cannot be read for a reason other than ENOENT', () => {
    // A directory where the file should be makes readFileSync fail with EISDIR.
    fs.mkdirSync(path.join(tasksDir, REPOS_DIR_FILE))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = resolveReposDir({ envValue: undefined, tasksDir, homeDir })

    expect(result).toEqual({ reposDir: path.join(homeDir, 'Dev'), source: 'default' })
    expect(consoleError).toHaveBeenCalledOnce()
    expect(String(consoleError.mock.calls[0][0])).toContain(REPOS_DIR_FILE)
  })

  it('logs a broken saved file once, not on every call', () => {
    fs.mkdirSync(path.join(tasksDir, REPOS_DIR_FILE))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    resolveReposDir({ envValue: undefined, tasksDir, homeDir })
    resolveReposDir({ envValue: undefined, tasksDir, homeDir })

    expect(consoleError).toHaveBeenCalledOnce()
  })

  it('expands a leading ~ in the saved path to the home dir', () => {
    fs.mkdirSync(path.join(homeDir, 'Projects'))
    fs.writeFileSync(path.join(tasksDir, REPOS_DIR_FILE), '~/Projects\n')

    expect(resolveReposDir({ envValue: undefined, tasksDir, homeDir }).reposDir).toBe(path.join(homeDir, 'Projects'))
  })

  it('drops a trailing slash from the saved path', () => {
    const root = makeDir()
    fs.writeFileSync(path.join(tasksDir, REPOS_DIR_FILE), `${root}/\n`)

    expect(resolveReposDir({ envValue: undefined, tasksDir, homeDir }).reposDir).toBe(root)
  })

  it('does not log when the file is simply absent', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    resolveReposDir({ envValue: undefined, tasksDir, homeDir })

    expect(consoleError).not.toHaveBeenCalled()
  })
})

describe('resolveReposDir with an invalid saved root', () => {
  const defaultRoot = () => ({ reposDir: path.join(homeDir, 'Dev'), source: 'default' })
  const saveRaw = (raw: string | Buffer) => fs.writeFileSync(path.join(tasksDir, REPOS_DIR_FILE), raw)
  const resolveSaved = () => resolveReposDir({ envValue: undefined, tasksDir, homeDir })

  it.each([
    ['a binary file', Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x80])],
    ['a NUL byte', Buffer.from('/tmp/nul\0root')],
    ['two lines', '/tmp/two\n/var/lines'],
    ['a control character', '/tmp/ctl\u0007root'],
  ])('rejects %s, logs once and falls back to the default', (_label, raw) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    saveRaw(raw)

    expect(resolveSaved()).toEqual(defaultRoot())
    expect(resolveSaved()).toEqual(defaultRoot())
    expect(consoleError).toHaveBeenCalledOnce()
    expect(String(consoleError.mock.calls[0][0])).toContain(REPOS_DIR_FILE)
  })

  it('rejects a relative saved path instead of resolving it against the server cwd', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    saveRaw('some/rel-qa\n')

    expect(resolveSaved()).toEqual(defaultRoot())
    expect(resolveSaved()).toEqual(defaultRoot())
    expect(consoleError).toHaveBeenCalledOnce()
    expect(String(consoleError.mock.calls[0][0])).toMatch(/absolute/)
  })

  it('warns and falls back when the saved root no longer exists', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    saveRaw('/nonexistent/qa/root\n')

    expect(resolveSaved()).toEqual(defaultRoot())
    expect(resolveSaved()).toEqual(defaultRoot())
    expect(consoleError).toHaveBeenCalledOnce()
    expect(String(consoleError.mock.calls[0][0])).toContain('/nonexistent/qa/root')
  })

  it('warns and falls back when the saved root is a regular file', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const regularFile = path.join(makeDir(), 'a-file')
    fs.writeFileSync(regularFile, 'x')
    saveRaw(`${regularFile}\n`)

    expect(resolveSaved()).toEqual(defaultRoot())
    expect(consoleError).toHaveBeenCalledOnce()
  })

  it('logs each distinct invalid value once', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    saveRaw('/nonexistent/qa/first\n')
    resolveSaved()
    saveRaw('/nonexistent/qa/second\n')
    resolveSaved()

    expect(consoleError).toHaveBeenCalledTimes(2)
  })

  it('still lets an explicit env value win over an invalid saved root without logging', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    saveRaw('some/rel\n')

    expect(resolveReposDir({ envValue: '/from/env', tasksDir, homeDir })).toEqual({ reposDir: '/from/env', source: 'env' })
    expect(consoleError).not.toHaveBeenCalled()
  })
})

describe('validateReposRoot', () => {
  it('accepts a clean absolute readable directory', () => {
    const root = makeDir()

    expect(validateReposRoot(root, homeDir)).toEqual({ ok: true, reposDir: root })
  })

  it('expands a leading ~ to the home dir', () => {
    fs.mkdirSync(path.join(homeDir, 'Projects'))

    expect(validateReposRoot('~/Projects', homeDir)).toEqual({ ok: true, reposDir: path.join(homeDir, 'Projects') })
  })

  it('rejects ~user, which is not a home-relative form we expand', () => {
    expect(validateReposRoot('~someone/x', homeDir)).toMatchObject({ ok: false })
  })

  it('rejects a relative path', () => {
    expect(validateReposRoot('rel/dir', homeDir)).toMatchObject({ ok: false, reason: expect.stringMatching(/absolute/) })
  })

  it('rejects a directory the user cannot read and traverse', () => {
    const root = makeDir()
    fs.chmodSync(root, 0o000)

    const result = validateReposRoot(root, homeDir)

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining(root) })
  })
})

describe('writeReposDir', () => {
  it('persists an absolute existing directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repos-dir-root-'))

    expect(writeReposDir(tasksDir, root, '/unused')).toBe(root)
    expect(fs.readFileSync(path.join(tasksDir, REPOS_DIR_FILE), 'utf-8').trim()).toBe(root)
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('resolves a relative path against the given cwd', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'repos-dir-cwd-'))
    fs.mkdirSync(path.join(cwd, 'projects'))

    expect(writeReposDir(tasksDir, 'projects', cwd)).toBe(path.join(cwd, 'projects'))
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('expands a leading ~ to the home dir', () => {
    fs.mkdirSync(path.join(homeDir, 'Projects'))

    expect(writeReposDir(tasksDir, '~/Projects', '/unused', homeDir)).toBe(path.join(homeDir, 'Projects'))
  })

  it('refuses a path that does not exist and leaves no file behind', () => {
    expect(() => writeReposDir(tasksDir, path.join(homeDir, 'missing'), homeDir)).toThrow(/missing/)
    expect(fs.existsSync(path.join(tasksDir, REPOS_DIR_FILE))).toBe(false)
  })

  it('refuses a regular file and keeps the previously saved value', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repos-dir-root-'))
    const regularFile = path.join(homeDir, 'a-file')
    fs.writeFileSync(regularFile, 'x')
    writeReposDir(tasksDir, root, homeDir)

    expect(() => writeReposDir(tasksDir, regularFile, homeDir)).toThrow(/not a directory/i)
    expect(fs.readFileSync(path.join(tasksDir, REPOS_DIR_FILE), 'utf-8').trim()).toBe(root)
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('refuses an unreadable directory with the path in the message and keeps the previously saved value', () => {
    const root = makeDir()
    const locked = makeDir()
    writeReposDir(tasksDir, root, homeDir)
    fs.chmodSync(locked, 0o000)

    expect(() => writeReposDir(tasksDir, locked, homeDir)).toThrow(locked)
    expect(fs.readFileSync(path.join(tasksDir, REPOS_DIR_FILE), 'utf-8').trim()).toBe(root)
  })

  it('refuses a path with a newline so the saved file stays one clean line', () => {
    const odd = path.join(makeDir(), 'a\nb')
    fs.mkdirSync(odd)

    expect(() => writeReposDir(tasksDir, odd, homeDir)).toThrow(/control character/)
    expect(fs.existsSync(path.join(tasksDir, REPOS_DIR_FILE))).toBe(false)
  })

  it('leaves no temp file next to the saved one', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repos-dir-root-'))

    writeReposDir(tasksDir, root, homeDir)

    expect(fs.readdirSync(tasksDir)).toEqual([REPOS_DIR_FILE])
    fs.rmSync(root, { recursive: true, force: true })
  })
})
