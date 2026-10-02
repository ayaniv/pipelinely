import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runRemoteTokenCommand } from './remoteTokenCli.js'
import { readRemoteToken, remoteTokenPath } from './remoteToken.js'

// `npm run remote-token -- <command>` is the only supported way to turn
// remote access on, rotate it, or turn it off. The commands are exercised
// through the exported function rather than a spawned process so the token
// file can live in a throwaway home directory.

let homeDir: string
let tokenFile: string

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-remote-token-cli-'))
  tokenFile = remoteTokenPath(homeDir)
})

afterEach(async () => {
  await fs.rm(homeDir, { recursive: true, force: true })
})

describe('status (the default command)', () => {
  it('reports remote access off when there is no token file', async () => {
    const output = await runRemoteTokenCommand(undefined, tokenFile)
    expect(output).toContain('off')
    expect(output).toContain(tokenFile)
  })

  it('reports remote access on without ever printing the token', async () => {
    await runRemoteTokenCommand('create', tokenFile)
    const token = await readRemoteToken(tokenFile)

    const output = await runRemoteTokenCommand('status', tokenFile)
    expect(output).toContain('on')
    expect(output).not.toContain(token)
  })
})

describe('create', () => {
  it('writes a fresh token and prints it once, with the path it was written to', async () => {
    const output = await runRemoteTokenCommand('create', tokenFile)
    const token = await readRemoteToken(tokenFile)

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(output).toContain(token)
    expect(output).toContain(tokenFile)
  })

  // Silently replacing an existing token would sign every device out with no
  // warning; that is what `rotate` is for, and it should be asked for by name.
  it('refuses to overwrite an existing token and leaves it untouched', async () => {
    await runRemoteTokenCommand('create', tokenFile)
    const before = await readRemoteToken(tokenFile)

    await expect(runRemoteTokenCommand('create', tokenFile)).rejects.toThrow(/rotate/)
    expect(await readRemoteToken(tokenFile)).toBe(before)
  })
})

describe('rotate', () => {
  it('replaces the token, which is how every signed-in device is revoked', async () => {
    await runRemoteTokenCommand('create', tokenFile)
    const before = await readRemoteToken(tokenFile)

    const output = await runRemoteTokenCommand('rotate', tokenFile)
    const after = await readRemoteToken(tokenFile)

    expect(after).not.toBe(before)
    expect(output).toContain(after)
  })

  it('also works when remote access was off', async () => {
    await runRemoteTokenCommand('rotate', tokenFile)
    expect(await readRemoteToken(tokenFile)).not.toBeNull()
  })
})

describe('show', () => {
  it('prints the current token for signing a new device in', async () => {
    await runRemoteTokenCommand('create', tokenFile)
    expect(await runRemoteTokenCommand('show', tokenFile)).toContain(await readRemoteToken(tokenFile))
  })

  it('fails with a pointer to create when remote access is off', async () => {
    await expect(runRemoteTokenCommand('show', tokenFile)).rejects.toThrow(/create/)
  })
})

describe('disable', () => {
  it('deletes the token file, turning remote access off', async () => {
    await runRemoteTokenCommand('create', tokenFile)
    await runRemoteTokenCommand('disable', tokenFile)
    expect(await readRemoteToken(tokenFile)).toBeNull()
  })

  it('is a no-op success when remote access is already off', async () => {
    await expect(runRemoteTokenCommand('disable', tokenFile)).resolves.toContain('off')
  })
})

describe('unknown command', () => {
  it('rejects with the usage line and touches nothing', async () => {
    await expect(runRemoteTokenCommand('enable', tokenFile)).rejects.toThrow(/Usage: remote-token/)
    expect(await readRemoteToken(tokenFile)).toBeNull()
  })
})
