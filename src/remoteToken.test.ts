import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  remoteTokenPath,
  resolveRemoteTokenPath,
  REMOTE_TOKEN_FILE_ENV_VAR,
  generateRemoteToken,
  readRemoteToken,
  writeRemoteToken,
  tokensMatch,
} from './remoteToken.js'

// The remote-access token is the only secret this server has, so the file it
// lives in is held to two rules: it is never under a repo checkout (TASKS_DIR
// is inside one), and it is never readable by anyone but the owner.

let homeDir: string
let tokenFile: string

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-remote-token-'))
  tokenFile = remoteTokenPath(homeDir)
})

afterEach(async () => {
  await fs.rm(homeDir, { recursive: true, force: true })
})

describe('remoteTokenPath', () => {
  it('lives under ~/.config/pipelinely, outside any repo checkout', () => {
    expect(tokenFile).toBe(path.join(homeDir, '.config', 'pipelinely', 'remote-token'))
  })
})

// The override exists for one caller: playwright.config.ts's fixture server,
// which must never read (or need) the developer's real token.
describe('resolveRemoteTokenPath', () => {
  it('defaults to remoteTokenPath(home) when no override is set', () => {
    expect(resolveRemoteTokenPath({}, homeDir)).toBe(tokenFile)
  })

  it(`honours ${REMOTE_TOKEN_FILE_ENV_VAR}`, () => {
    const override = path.join(homeDir, 'elsewhere', 'token')
    expect(resolveRemoteTokenPath({ [REMOTE_TOKEN_FILE_ENV_VAR]: override }, homeDir)).toBe(override)
  })

  it('ignores a blank override instead of resolving it to the current directory', () => {
    expect(resolveRemoteTokenPath({ [REMOTE_TOKEN_FILE_ENV_VAR]: '  ' }, homeDir)).toBe(tokenFile)
  })
})

describe('generateRemoteToken', () => {
  it('is 32 random bytes, base64url-encoded so it pastes cleanly into a form field', () => {
    expect(generateRemoteToken()).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 50 }, generateRemoteToken))
    expect(tokens.size).toBe(50)
  })
})

describe('writeRemoteToken', () => {
  it('creates the directory owner-only and the file owner-read/write-only', async () => {
    await writeRemoteToken(tokenFile, 'a-token')

    const dirMode = (await fs.stat(path.dirname(tokenFile))).mode & 0o777
    const fileMode = (await fs.stat(tokenFile)).mode & 0o777
    expect(dirMode).toBe(0o700)
    expect(fileMode).toBe(0o600)
  })

  // A file someone created by hand with the default umask is group/world
  // readable; rewriting it must not keep that.
  it('tightens the mode of a pre-existing, wider file', async () => {
    await fs.mkdir(path.dirname(tokenFile), { recursive: true })
    await fs.writeFile(tokenFile, 'old', { mode: 0o644 })

    await writeRemoteToken(tokenFile, 'new-token')

    expect((await fs.stat(tokenFile)).mode & 0o777).toBe(0o600)
    expect(await readRemoteToken(tokenFile)).toBe('new-token')
  })
})

describe('readRemoteToken', () => {
  it('returns the token it was given, trimmed of the trailing newline an editor adds', async () => {
    await writeRemoteToken(tokenFile, 'a-token')
    await fs.appendFile(tokenFile, '\n')

    expect(await readRemoteToken(tokenFile)).toBe('a-token')
  })

  // No file is the normal "remote access was never enabled" state, not an error.
  it('returns null when the file does not exist', async () => {
    expect(await readRemoteToken(tokenFile)).toBeNull()
  })

  it('returns null for an empty or whitespace-only file rather than accepting an empty token', async () => {
    await writeRemoteToken(tokenFile, '   \n')
    expect(await readRemoteToken(tokenFile)).toBeNull()
  })

  // Anything other than "missing" must reach the caller, which fails the
  // request closed and logs it — never silently treated as "no token".
  it('rejects when the path cannot be read for a reason other than not existing', async () => {
    await fs.mkdir(tokenFile, { recursive: true })
    await expect(readRemoteToken(tokenFile)).rejects.toThrow()
  })
})

describe('tokensMatch', () => {
  it('accepts the exact token', () => {
    expect(tokensMatch('abc123', 'abc123')).toBe(true)
  })

  it('rejects a different token, a prefix, a missing one and an empty one', () => {
    expect(tokensMatch('abc124', 'abc123')).toBe(false)
    expect(tokensMatch('abc', 'abc123')).toBe(false)
    expect(tokensMatch('abc1234', 'abc123')).toBe(false)
    expect(tokensMatch(undefined, 'abc123')).toBe(false)
    expect(tokensMatch('', 'abc123')).toBe(false)
  })
})
