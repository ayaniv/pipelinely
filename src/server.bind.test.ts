import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { startTestServer, stopTestServer, type TestServerHandle } from './serverTestHarness.js'
import { canConnect, firstNonLoopbackIPv4 } from './testNetwork.js'

vi.mock('open', () => ({ default: vi.fn(async () => undefined) }))

describe('main() bind address', () => {
  let handle: TestServerHandle | null = null
  let warnSpy: ReturnType<typeof vi.spyOn> | null = null

  afterEach(async () => {
    if (handle) await stopTestServer(handle, ['PIPELINELY_HOST', 'PIPELINELY_REMOTE_TOKEN_FILE'])
    handle = null
    vi.restoreAllMocks()
    warnSpy = null
    delete process.env.PIPELINELY_HOST
  })

  it('listens on loopback only and prints no warning when PIPELINELY_HOST is unset', async () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    handle = await startTestServer()

    expect(await canConnect('127.0.0.1', handle.boundPort)).toBe(true)
    const lanAddress = firstNonLoopbackIPv4()
    if (lanAddress !== null) expect(await canConnect(lanAddress, handle.boundPort)).toBe(false)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(handle.logSpy).toHaveBeenCalledWith(expect.stringContaining(`http://localhost:${handle.boundPort}`))
  })

  it('binds every wide address and warns once per wide host when PIPELINELY_HOST opts in', async () => {
    const lanAddress = firstNonLoopbackIPv4()
    if (lanAddress === null) return // offline machine: no second address to bind
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Pinned to a file that does not exist so this never reads the real token.
    const noTokenFile = path.join(os.tmpdir(), 'cockpit-bind-test-never-created', 'token')
    handle = await startTestServer({ PIPELINELY_HOST: `127.0.0.1, ${lanAddress}`, PIPELINELY_REMOTE_TOKEN_FILE: noTokenFile })

    expect(await canConnect('127.0.0.1', handle.boundPort)).toBe(true)
    expect(await canConnect(lanAddress, handle.boundPort)).toBe(true)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(lanAddress))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('npm run remote-token -- create'))
  })

  it('names the token file at startup when PIPELINELY_REMOTE_TOKEN_FILE overrides it, so a leaked override is visible', async () => {
    const tokenFile = path.join(os.tmpdir(), 'cockpit-bind-test-never-created', 'token')
    handle = await startTestServer({ PIPELINELY_REMOTE_TOKEN_FILE: tokenFile })

    expect(handle.logSpy).toHaveBeenCalledWith(expect.stringContaining(tokenFile))
  })

  it('does not mention a token file at startup when there is no override', async () => {
    handle = await startTestServer()

    expect(handle.logSpy).not.toHaveBeenCalledWith(expect.stringContaining('PIPELINELY_REMOTE_TOKEN_FILE'))
  })

  it('fails loudly at startup on an invalid PIPELINELY_HOST instead of falling back', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-server-bind-test-'))
    process.env.TASKS_DIR = tmpDir
    process.env.PORT = '0'
    process.env.PIPELINELY_HOST = 'not a host!'
    vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { main } = await import('./server.js')
      await expect(main()).rejects.toThrow(/PIPELINELY_HOST/)
    } finally {
      delete process.env.TASKS_DIR
      delete process.env.PORT
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})
