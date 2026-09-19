import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { startTestServer, stopTestServer, type TestServerHandle } from './serverTestHarness.js'

// Regression coverage for main()'s app.listen callback logging/opening the
// pre-listen PORT value instead of the real OS-assigned port. PORT=0 is a
// legitimate "let the OS pick a free port" request (standard net.Server
// semantics) — before the fix this popped the developer's real default
// browser at the bogus http://localhost:0 every time (see TASK.md), because
// the callback closed over the PORT constant computed before .listen()
// resolved a real port.
const openMock = vi.fn(async () => undefined)
vi.mock('open', () => ({ default: openMock }))

let handle: TestServerHandle

// Import the module once, like src/server.test.ts does — vi.resetModules()
// plus a fresh import per test re-runs server.ts's module-level chokidar
// watchers and setInterval with nothing to close them, leaking watchers
// pointed at a tmpDir a later test has already removed.
beforeAll(async () => {
  // This test's own concern is the bound-port value open() is called with,
  // not whether it's called at all — opening is opt-in
  // (COCKPIT_AUTO_OPEN_BROWSER, see server.autoOpenBrowser.test.ts), so this
  // has to opt in explicitly to exercise the call.
  handle = await startTestServer({ COCKPIT_AUTO_OPEN_BROWSER: '1' })
})

afterAll(async () => {
  await stopTestServer(handle, ['COCKPIT_AUTO_OPEN_BROWSER'])
})

describe('resolveBoundPort', () => {
  it('returns the real port from a bound network address', async () => {
    const { resolveBoundPort } = await import('./server.js')
    expect(resolveBoundPort({ address: '0.0.0.0', family: 'IPv4', port: 54321 }, 0)).toBe(54321)
  })

  it('falls back to the pre-listen port and logs an error when address() is not a network address', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { resolveBoundPort } = await import('./server.js')
      expect(resolveBoundPort(null, 3030)).toBe(3030)
      expect(resolveBoundPort('/tmp/some.sock', 3030)).toBe(3030)
      expect(errorSpy).toHaveBeenCalledTimes(2)
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('main() started with PORT=0', () => {
  it('logs and opens the real OS-assigned port, not the literal 0', () => {
    const { boundPort, logSpy } = handle
    expect(boundPort).not.toBe(0)

    expect(openMock).toHaveBeenCalledWith(`http://localhost:${boundPort}`)
    expect(openMock).not.toHaveBeenCalledWith('http://localhost:0')

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`http://localhost:${boundPort}`))
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('http://localhost:0'))
  })
})
