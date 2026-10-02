import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import {
  installRemoteAuth,
  requestAccess,
  requestNeedsRemoteAuth,
  LOGIN_PATH,
  LOGOUT_PATH,
  REMOTE_SESSION_COOKIE,
  REMOTE_SESSION_MAX_AGE_SECONDS,
} from './remoteAuth.js'
import { MIN_REMOTE_TOKEN_LENGTH } from './remoteToken.js'
import { rawHttpRequest } from './testNetwork.js'

// The remote-access gate, exercised over real HTTP against a throwaway
// express app. A single machine cannot present a genuinely non-loopback peer
// without a network interface (see testNetwork.ts), so the remote cases inject
// `needsAuth: () => true`; the default classifier is proven separately, both
// as a pure function and over real loopback HTTP with proxy headers.

const TOKEN = 'correct-horse-battery-staple-0123456789abcd'
const BASE64_TOKEN = 'Ab+cD/eF0123456789ghIJklMNopQRstUVwx+/yz=='

interface Harness {
  server: Server
  baseUrl: string
  setToken: (token: string | null) => void
  setReadFailure: (error: Error | null) => void
}

let harness: Harness

async function startApp(options: { isRemote: boolean | null }): Promise<Harness> {
  let token: string | null = TOKEN
  let readFailure: Error | null = null

  const app = express()
  installRemoteAuth(app, {
    readToken: async () => {
      if (readFailure) throw readFailure
      return token
    },
    ...(options.isRemote === null ? {} : { needsAuth: () => options.isRemote === true }),
  })
  app.get('/', (_req, res) => res.type('html').send('<main data-testid="dashboard-shell"></main>'))
  app.get('/api/tasks', (_req, res) => res.json({ access: requestAccess(res) }))
  app.post('/stage-skill/:slug', (_req, res) => res.json({ access: requestAccess(res) }))

  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a network address')

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    setToken: (next) => { token = next },
    setReadFailure: (next) => { readFailure = next },
  }
}

function sessionCookie(token: string): string {
  return `${REMOTE_SESSION_COOKIE}=${token}`
}

function login(token: string): Promise<Response> {
  return fetch(`${harness.baseUrl}${LOGIN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
    redirect: 'manual',
  })
}

let warnSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  if (harness?.server.listening) await new Promise<void>((resolve) => harness.server.close(() => resolve()))
  vi.restoreAllMocks()
})

describe('loopback requests — no token needed (the desktop default)', () => {
  beforeEach(async () => {
    harness = await startApp({ isRemote: false })
  })

  it('passes a loopback request with no cookie and marks it loopback', async () => {
    const res = await fetch(`${harness.baseUrl}/api/tasks`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ access: 'loopback' })
  })

  it('does not read the token at all for a loopback request, so a broken token file cannot lock the desktop out', async () => {
    harness.setReadFailure(new Error('EACCES'))
    const res = await fetch(`${harness.baseUrl}/api/tasks`)
    expect(res.status).toBe(200)
  })
})

// Loopback is trusted, so the one way in for a web page is through the
// developer's own desktop browser: a rebound DNS name pointing at 127.0.0.1,
// or a cross-site form POST. Both are refused before any route runs, by the
// same check the answer-dialog route reuses (src/localWriteGuard.ts).
describe('loopback requests from another site — DNS rebinding and CSRF', () => {
  let port: number
  let ownOrigin: string

  beforeEach(async () => {
    harness = await startApp({ isRemote: false })
    port = Number(new URL(harness.baseUrl).port)
    ownOrigin = `http://127.0.0.1:${port}`
  })

  it('refuses a Host that is not a loopback name, the DNS-rebinding case, with 403 bad-host', async () => {
    for (const host of [`attacker.example:${port}`, `0.0.0.0:${port}`]) {
      const res = await rawHttpRequest(port, 'GET', '/api/tasks', { Host: host })
      expect(res.status, host).toBe(403)
      expect(JSON.parse(res.body), host).toEqual({ error: 'bad-host', reason: 'bad-host' })
    }
  })

  it('accepts the loopback names the desktop actually uses', async () => {
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
      const res = await rawHttpRequest(port, 'GET', '/api/tasks', { Host: host })
      expect(res.status, host).toBe(200)
    }
  })

  it('refuses a cross-site POST by its Origin, Origin: null included, with 403 cross-site', async () => {
    for (const origin of ['http://attacker.example', 'null']) {
      const res = await rawHttpRequest(port, 'POST', '/stage-skill/some-task', {
        Host: `127.0.0.1:${port}`,
        Origin: origin,
        'Content-Type': 'application/x-www-form-urlencoded',
      })
      expect(res.status, origin).toBe(403)
      expect(JSON.parse(res.body), origin).toEqual({ error: 'cross-site', reason: 'cross-site' })
    }
  })

  it('refuses a POST that only Sec-Fetch-Site marks as coming from another site', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const res = await rawHttpRequest(port, 'POST', '/stage-skill/some-task', {
        Host: `127.0.0.1:${port}`,
        'Sec-Fetch-Site': site,
      })
      expect(res.status, site).toBe(403)
    }
  })

  it("accepts the dashboard's own same-origin POST", async () => {
    const res = await rawHttpRequest(port, 'POST', '/stage-skill/some-task', {
      Host: `127.0.0.1:${port}`,
      Origin: ownOrigin,
      'Sec-Fetch-Site': 'same-origin',
    })
    expect(res.status).toBe(200)
  })

  it('accepts a POST with no Origin at all — curl and local scripts, as today', async () => {
    const res = await rawHttpRequest(port, 'POST', '/stage-skill/some-task', { Host: `127.0.0.1:${port}` })
    expect(res.status).toBe(200)
  })

  // A GET changes nothing on this server, and without CORS headers the
  // browser never hands a cross-site page the response.
  it('lets a cross-site GET to a loopback Host through', async () => {
    const res = await rawHttpRequest(port, 'GET', '/api/tasks', {
      Host: `127.0.0.1:${port}`,
      Origin: 'http://attacker.example',
      'Sec-Fetch-Site': 'cross-site',
    })
    expect(res.status).toBe(200)
  })
})

describe('remote requests with a valid session — the phone, signed in', () => {
  beforeEach(async () => {
    harness = await startApp({ isRemote: true })
  })

  it('passes reads and marks them remote-authenticated', async () => {
    const res = await fetch(`${harness.baseUrl}/api/tasks`, { headers: { Cookie: sessionCookie(TOKEN) } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ access: 'remote-authenticated' })
  })

  it('passes mutating routes — the only way a request can be remote-authenticated for autoSubmit', async () => {
    const res = await fetch(`${harness.baseUrl}/stage-skill/some-task`, {
      method: 'POST',
      headers: { Cookie: `other=1; ${sessionCookie(TOKEN)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'qa', autoSubmit: true }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ access: 'remote-authenticated' })
  })
})

describe('remote requests without a valid session', () => {
  beforeEach(async () => {
    harness = await startApp({ isRemote: true })
  })

  it('rejects an API read with 401 and never runs the route', async () => {
    const res = await fetch(`${harness.baseUrl}/api/tasks`)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'remote-auth-required' })
  })

  it('rejects a mutating route with 401 — autoSubmit included', async () => {
    const res = await fetch(`${harness.baseUrl}/stage-skill/some-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'qa', autoSubmit: true }),
    })
    expect(res.status).toBe(401)
  })

  it('redirects a browser page navigation to the login page instead of showing a bare 401', async () => {
    const res = await fetch(`${harness.baseUrl}/`, { headers: { Accept: 'text/html' }, redirect: 'manual' })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(LOGIN_PATH)
  })

  it('rejects a cookie holding the wrong token, and logs the rejection without the token', async () => {
    const wrongToken = 'not-the-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
    const res = await fetch(`${harness.baseUrl}/api/tasks`, { headers: { Cookie: sessionCookie(wrongToken) } })

    expect(res.status).toBe(401)
    expect(warnSpy).toHaveBeenCalled()
    const logged = JSON.stringify(warnSpy.mock.calls)
    expect(logged).not.toContain(wrongToken)
    expect(logged).not.toContain(TOKEN)
  })

  // Rotating the token is how every signed-in device is revoked, so it must
  // take effect on the next request, with no server restart.
  it('rejects a session cookie from before the token was rotated', async () => {
    harness.setToken('rotated-token-yyyyyyyyyyyyyyyyyyyyyyyyyyyyy')
    const res = await fetch(`${harness.baseUrl}/api/tasks`, { headers: { Cookie: sessionCookie(TOKEN) } })
    expect(res.status).toBe(401)
  })
})

describe('remote access not enabled (no token file)', () => {
  beforeEach(async () => {
    harness = await startApp({ isRemote: true })
    harness.setToken(null)
  })

  it('rejects every remote API request with 403 remote-access-disabled, whatever cookie it carries', async () => {
    const res = await fetch(`${harness.baseUrl}/api/tasks`, { headers: { Cookie: sessionCookie(TOKEN) } })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'remote-access-disabled' })
  })

  it('shows a login page that explains remote access is off instead of a form', async () => {
    const res = await fetch(`${harness.baseUrl}${LOGIN_PATH}`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('data-testid="remote-access-disabled"')
    expect(html).not.toContain('data-testid="remote-login-form"')
  })

  it('refuses a login attempt with 403', async () => {
    const res = await login(TOKEN)
    expect(res.status).toBe(403)
  })
})

// The CLI only ever writes 43-character random tokens, but the file is plain
// text a person can overwrite by hand. With no rate limiter, a short token
// would be guessable online, so it is refused rather than trusted.
describe('a token too short to resist guessing', () => {
  const SHORT_TOKEN = 'x'.repeat(MIN_REMOTE_TOKEN_LENGTH - 1)

  beforeEach(async () => {
    harness = await startApp({ isRemote: true })
    harness.setToken(SHORT_TOKEN)
  })

  it('fails the remote request closed with 503, even with a matching cookie, and logs a pointer to rotate without the token', async () => {
    const res = await fetch(`${harness.baseUrl}/api/tasks`, { headers: { Cookie: sessionCookie(SHORT_TOKEN) } })

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'remote-auth-unavailable' })
    const logged = JSON.stringify(errorSpy.mock.calls)
    expect(logged).toContain('rotate')
    expect(logged).not.toContain(SHORT_TOKEN)
  })

  it('refuses to sign anyone in with it', async () => {
    const res = await login(SHORT_TOKEN)
    expect(res.status).toBe(503)
    expect(res.headers.get('set-cookie')).toBeNull()
  })
})

describe('token file unreadable', () => {
  beforeEach(async () => {
    harness = await startApp({ isRemote: true })
  })

  it('fails the remote request closed with 503 and logs why', async () => {
    harness.setReadFailure(new Error('EACCES: permission denied'))
    const res = await fetch(`${harness.baseUrl}/api/tasks`, { headers: { Cookie: sessionCookie(TOKEN) } })

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'remote-auth-unavailable' })
    expect(errorSpy).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: expect.stringContaining('EACCES') }))
  })
})

describe('login and logout', () => {
  beforeEach(async () => {
    harness = await startApp({ isRemote: true })
  })

  it('serves the login form to an unauthenticated remote client', async () => {
    const res = await fetch(`${harness.baseUrl}${LOGIN_PATH}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('data-testid="remote-login-form"')
    expect(html).toContain('data-testid="remote-login-token"')
  })

  // The token travels only in a POST body and then the cookie, never in a URL
  // that browser history, a proxy log or a Referer would keep.
  it('posts the form rather than sending the token in a query string', async () => {
    const html = await (await fetch(`${harness.baseUrl}${LOGIN_PATH}`)).text()
    expect(html).toMatch(new RegExp(`<form[^>]*method="post"[^>]*action="${LOGIN_PATH}"|<form[^>]*action="${LOGIN_PATH}"[^>]*method="post"`, 'i'))
  })

  it('does not sign in from a token in the query string', async () => {
    const res = await fetch(`${harness.baseUrl}${LOGIN_PATH}?token=${TOKEN}`, { redirect: 'manual' })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('sets an HttpOnly, SameSite=Strict session cookie for the right token and sends the browser to the dashboard', async () => {
    const res = await login(TOKEN)

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/')
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(sessionCookie(TOKEN))
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/SameSite=Strict/i)
    expect(setCookie).toMatch(/Path=\//i)
    expect(setCookie).toContain(`Max-Age=${REMOTE_SESSION_MAX_AGE_SECONDS}`)
  })

  it('lets the cookie it set through on the next request', async () => {
    const setCookie = (await login(TOKEN)).headers.get('set-cookie') ?? ''
    const cookie = setCookie.split(';')[0]

    const res = await fetch(`${harness.baseUrl}/api/tasks`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
  })

  // A hand-written `openssl rand -base64 32` token is allowed, and its + / =
  // are percent-encoded in Set-Cookie, so the gate must decode what it reads.
  it('round-trips a base64 token containing + / and = through the cookie it set', async () => {
    harness.setToken(BASE64_TOKEN)
    const setCookie = (await login(BASE64_TOKEN)).headers.get('set-cookie') ?? ''
    const cookie = setCookie.split(';')[0]

    const res = await fetch(`${harness.baseUrl}/api/tasks`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ access: 'remote-authenticated' })
  })

  it('rejects a cookie that is not valid percent-encoding with 401 instead of crashing', async () => {
    const res = await fetch(`${harness.baseUrl}/api/tasks`, { headers: { Cookie: sessionCookie('%E0%A4%A') } })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'remote-auth-required' })
  })

  // Copying the token out of an SSH session often picks up surrounding spaces.
  it('accepts a pasted token with surrounding whitespace', async () => {
    const res = await login(`  ${TOKEN}\n`)
    expect(res.status).toBe(303)
    expect(res.headers.get('set-cookie') ?? '').toContain(sessionCookie(TOKEN))
  })

  it('still rejects a whitespace-only submission', async () => {
    const res = await login('   ')
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('rejects the wrong token with 401, sets no cookie, re-renders the form with an error, and logs without the token', async () => {
    const wrongToken = 'guess-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'
    const res = await login(wrongToken)

    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBeNull()
    const html = await res.text()
    expect(html).toContain('data-testid="remote-login-form"')
    expect(html).toContain('data-testid="remote-login-error"')
    expect(warnSpy).toHaveBeenCalled()
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(wrongToken)
  })

  it('rejects an empty submission with 401', async () => {
    const res = await login('')
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('clears the session cookie on logout and returns to the login page', async () => {
    const res = await fetch(`${harness.baseUrl}${LOGOUT_PATH}`, {
      method: 'POST',
      headers: { Cookie: sessionCookie(TOKEN) },
      redirect: 'manual',
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(LOGIN_PATH)
    expect(res.headers.get('set-cookie') ?? '').toMatch(new RegExp(`${REMOTE_SESSION_COOKIE}=;.*Max-Age=0`, 'i'))
  })
})

describe('requestNeedsRemoteAuth — the default classifier', () => {
  it('does not require auth for a plain loopback peer', () => {
    expect(requestNeedsRemoteAuth({ socket: { remoteAddress: '127.0.0.1' }, headers: {} })).toBe(false)
    expect(requestNeedsRemoteAuth({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: {} })).toBe(false)
  })

  it('requires auth for a tailnet or LAN peer', () => {
    expect(requestNeedsRemoteAuth({ socket: { remoteAddress: '100.64.1.2' }, headers: {} })).toBe(true)
    expect(requestNeedsRemoteAuth({ socket: { remoteAddress: '192.168.1.5' }, headers: {} })).toBe(true)
  })

  // isLoopbackAddress treats "unknown" as local, which is the safe answer for
  // auto-submit but the unsafe one for auth.
  it('requires auth when the peer address is missing or unreadable', () => {
    expect(requestNeedsRemoteAuth({ headers: {} })).toBe(true)
    for (const remoteAddress of ['', 'localhost', 'not-an-ip']) {
      expect(requestNeedsRemoteAuth({ socket: { remoteAddress }, headers: {} }), remoteAddress).toBe(true)
    }
  })

  // A local reverse proxy (`tailscale serve`, ngrok, caddy) makes a phone's
  // request arrive from 127.0.0.1. Proxy headers can only ever make this
  // answer stricter, never looser, so honouring them is safe even though a
  // local client could forge them.
  it('requires auth for a loopback peer that arrives through a proxy', () => {
    for (const header of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'tailscale-user-login']) {
      expect(requestNeedsRemoteAuth({ socket: { remoteAddress: '127.0.0.1' }, headers: { [header]: '100.64.1.2' } })).toBe(true)
    }
  })
})

describe('the default classifier, wired in over real loopback HTTP', () => {
  beforeEach(async () => {
    harness = await startApp({ isRemote: null })
  })

  it('lets a plain loopback request through', async () => {
    const res = await fetch(`${harness.baseUrl}/api/tasks`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ access: 'loopback' })
  })

  it('demands a session from a loopback request that carries a proxy header', async () => {
    const res = await fetch(`${harness.baseUrl}/api/tasks`, { headers: { 'X-Forwarded-For': '100.64.1.2' } })
    expect(res.status).toBe(401)
  })
})

// Loopback trusts a same-origin POST, so a page on another site must not be
// able to frame the dashboard and trick the developer into clicking Merge.
describe('framing — every response refuses to be embedded', () => {
  function expectNoFraming(res: Response): void {
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
  }

  it('sends the anti-framing headers on a loopback page', async () => {
    harness = await startApp({ isRemote: false })
    const res = await fetch(`${harness.baseUrl}/`)
    expect(res.status).toBe(200)
    expectNoFraming(res)
  })

  it('sends them on a refused loopback request too', async () => {
    harness = await startApp({ isRemote: false })
    const res = await fetch(`${harness.baseUrl}/stage-skill/some-task`, { method: 'POST', headers: { Origin: 'http://attacker.example' } })
    expect(res.status).toBe(403)
    expectNoFraming(res)
  })

  it('sends them on the remote login page and on a signed-in remote response', async () => {
    harness = await startApp({ isRemote: true })
    expectNoFraming(await fetch(`${harness.baseUrl}${LOGIN_PATH}`))
    expectNoFraming(await fetch(`${harness.baseUrl}/api/tasks`, { headers: { Cookie: sessionCookie(TOKEN) } }))
  })
})

// SameSite is by site, and for an IP host every port is the same site, so a
// page on another port of the tailnet IP would carry the phone's cookie.
// Origin cannot be checked against Host here (`tailscale serve` rewrites
// Host), but Sec-Fetch-Site can.
describe('remote writes from another origin — same-site CSRF', () => {
  beforeEach(async () => {
    harness = await startApp({ isRemote: true })
  })

  function remotePost(path: string, fetchSite: string | null): Promise<Response> {
    return fetch(`${harness.baseUrl}${path}`, {
      method: 'POST',
      headers: { Cookie: sessionCookie(TOKEN), ...(fetchSite === null ? {} : { 'Sec-Fetch-Site': fetchSite }) },
      redirect: 'manual',
    })
  }

  it('refuses a signed-in POST that Sec-Fetch-Site marks as same-site or cross-site, with 403 cross-site', async () => {
    for (const site of ['same-site', 'cross-site']) {
      const res = await remotePost('/stage-skill/some-task', site)
      expect(res.status, site).toBe(403)
      expect(await res.json(), site).toEqual({ error: 'cross-site', reason: 'cross-site' })
    }
  })

  it("accepts the phone's own same-origin POST, and one with no Sec-Fetch-Site at all", async () => {
    for (const site of ['same-origin', 'none', null]) {
      const res = await remotePost('/stage-skill/some-task', site)
      expect(res.status, String(site)).toBe(200)
    }
  })

  it('lets a same-site GET through — reads change nothing', async () => {
    const res = await fetch(`${harness.baseUrl}/api/tasks`, { headers: { Cookie: sessionCookie(TOKEN), 'Sec-Fetch-Site': 'same-site' } })
    expect(res.status).toBe(200)
  })

  it('refuses a same-site logout and leaves the session cookie alone', async () => {
    const res = await remotePost(LOGOUT_PATH, 'same-site')
    expect(res.status).toBe(403)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('still lets the phone log itself out', async () => {
    const res = await remotePost(LOGOUT_PATH, 'same-origin')
    expect(res.status).toBe(303)
  })
})
