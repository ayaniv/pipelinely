import { beforeEach, describe, expect, test, vi, type Mock } from 'vitest'
import { REMOTE_LOGIN_PATH, redirectToRemoteLogin } from './remoteSession'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('redirectToRemoteLogin', () => {
  let navigate: Mock<(path: string) => void>
  let log: Mock<(message: string, ...args: unknown[]) => void>

  beforeEach(() => {
    navigate = vi.fn()
    log = vi.fn()
  })

  test('sends the browser to the login page on 401 remote-auth-required and says it did', async () => {
    const redirected = await redirectToRemoteLogin(jsonResponse(401, { error: 'remote-auth-required' }), { navigate, log })

    expect(redirected).toBe(true)
    expect(navigate).toHaveBeenCalledWith(REMOTE_LOGIN_PATH)
  })

  test('also redirects when remote access was switched off under an open tab (403 remote-access-disabled)', async () => {
    expect(await redirectToRemoteLogin(jsonResponse(403, { error: 'remote-access-disabled' }), { navigate, log })).toBe(true)
    expect(navigate).toHaveBeenCalledWith(REMOTE_LOGIN_PATH)
  })

  test('logs why it redirected, without anything from the request', async () => {
    await redirectToRemoteLogin(jsonResponse(401, { error: 'remote-auth-required' }), { navigate, log })

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[remote-session\]/))
  })

  test('leaves every other failure alone: other 403s, 500s and successes', async () => {
    for (const response of [
      jsonResponse(403, { error: 'not-canonical' }),
      jsonResponse(403, { error: 'bad-host' }),
      jsonResponse(500, { error: 'boom' }),
      jsonResponse(200, {}),
    ]) {
      expect(await redirectToRemoteLogin(response, { navigate, log })).toBe(false)
    }
    expect(navigate).not.toHaveBeenCalled()
  })

  test('treats a 401 or 403 whose body is not JSON as a plain failure, not a redirect, and does not throw', async () => {
    const redirected = await redirectToRemoteLogin(new Response('<html>nope</html>', { status: 403 }), { navigate, log })

    expect(redirected).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
  })

  test('does not consume the response body, so the caller can still read it', async () => {
    const response = jsonResponse(401, { error: 'remote-auth-required' })
    await redirectToRemoteLogin(response, { navigate, log })

    expect(response.bodyUsed).toBe(false)
  })
})
