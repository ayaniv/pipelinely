import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { startTestServer, stopTestServer, type TestServerHandle } from './serverTestHarness.js'

// Regression coverage for COCKPIT_AUTO_OPEN_BROWSER: opening a real browser
// tab is opt-in, not opt-out (see TASK.md). Every existing spawn site —
// playwright's webServer, e2e fixture servers, every dispatched task's own
// "start the dev server for QA" step, even a real human's `npm run dev` —
// starts this same server, and none of them set this var, so the default
// must stay silent. The exact-port assertion for the var-set case lives in
// server.startup.test.ts; this file only covers the gating itself.
const openMock = vi.fn(async () => undefined)
vi.mock('open', () => ({ default: openMock }))

describe('main() started with no COCKPIT_AUTO_OPEN_BROWSER env var', () => {
  let handle: TestServerHandle

  beforeAll(async () => {
    handle = await startTestServer()
  })

  afterAll(async () => {
    await stopTestServer(handle)
  })

  it('never opens a browser tab', () => {
    expect(openMock).not.toHaveBeenCalled()
  })
})

describe('main() started with COCKPIT_AUTO_OPEN_BROWSER set', () => {
  let handle: TestServerHandle

  beforeAll(async () => {
    handle = await startTestServer({ COCKPIT_AUTO_OPEN_BROWSER: '1' })
  })

  afterAll(async () => {
    await stopTestServer(handle, ['COCKPIT_AUTO_OPEN_BROWSER'])
  })

  it('opens a browser tab', () => {
    expect(openMock).toHaveBeenCalledTimes(1)
  })
})
