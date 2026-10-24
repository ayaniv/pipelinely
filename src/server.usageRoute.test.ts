import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestServer, stopTestServer, type TestServerHandle } from './serverTestHarness.js'

// dashboard-v3-update M0: the You tab became Usage at /usage. /usage serves the
// dashboard shell like every other board tab; the old /you URL (bookmarks,
// shared links) redirects there instead of 404ing. It is a redirect, not a
// shell route, so it deliberately has no SHELL_ROUTES entry
// (shell/routes.test.ts checks the shell routes only).

let handle: TestServerHandle
let baseUrl: string

beforeAll(async () => {
  handle = await startTestServer()
  baseUrl = `http://127.0.0.1:${handle.boundPort}`
})

afterAll(async () => {
  await stopTestServer(handle, [])
})

describe('Usage routes', () => {
  it('GET /usage serves the dashboard shell', async () => {
    const response = await fetch(`${baseUrl}/usage`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/text\/html/)
  })

  it('GET /you redirects to /usage', async () => {
    const response = await fetch(`${baseUrl}/you`, { redirect: 'manual' })

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/usage')
  })

  it('GET /you/ (trailing slash) redirects too', async () => {
    const response = await fetch(`${baseUrl}/you/`, { redirect: 'manual' })

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/usage')
  })
})
