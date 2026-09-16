import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { startTestServer, stopTestServer, type TestServerHandle } from './serverTestHarness.js'

// Regression coverage for COCKPIT_SKIP_AUTO_OPEN: playwright.config.ts's
// webServer starts this same server as a test fixture, not something a
// developer is sitting in front of, so it sets this var to keep an e2e run
// from popping a real browser tab (see TASK.md). The happy path — open()
// firing when the var is unset — is already covered by
// server.startup.test.ts; this file covers the failure-to-suppress path
// this var exists to close.
const openMock = vi.fn(async () => undefined)
vi.mock('open', () => ({ default: openMock }))

let handle: TestServerHandle

beforeAll(async () => {
  handle = await startTestServer({ COCKPIT_SKIP_AUTO_OPEN: '1' })
})

afterAll(async () => {
  await stopTestServer(handle, ['COCKPIT_SKIP_AUTO_OPEN'])
})

describe('main() started with COCKPIT_SKIP_AUTO_OPEN set', () => {
  it('never opens a browser tab', () => {
    expect(openMock).not.toHaveBeenCalled()
  })
})
