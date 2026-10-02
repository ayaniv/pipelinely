import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import { firstNonLoopbackIPv4, rawHttpRequest } from './testNetwork.js'

// The remote-access gate proven at the production wiring level: that
// server.ts installs it ahead of every route (static files and SSE included),
// that the loopback desktop is untouched, and that autoSubmit can only be
// reached by a signed-in remote peer. remoteAuth.test.ts covers the gate's
// own behaviour against a throwaway app; this file only proves it is wired.
//
// A remote client is presented two ways: over this machine's LAN address (a
// genuinely non-loopback TCP peer, skipped on an offline machine), and over
// loopback with a proxy header, which is what `tailscale serve` produces and
// which the gate must treat as remote.

const stageInSessionCalls: { sessionId: string; text: string }[] = []
const pasteIntoSessionQuietCalls: { sessionId: string; text: string }[] = []

// Same shape as server.autoSubmit.test.ts: spread the real module, override
// only what shells out to osascript/tmux.
vi.mock('./focusTab.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./focusTab.js')>()),
  stageInSession: vi.fn(async (sessionId: string, text: string) => {
    stageInSessionCalls.push({ sessionId, text })
    return true
  }),
  pasteIntoSessionQuiet: vi.fn(async (sessionId: string, text: string) => {
    pasteIntoSessionQuietCalls.push({ sessionId, text })
    return true
  }),
  pasteIntoSession: vi.fn(async () => true),
  focusITermTab: vi.fn(async () => false),
  getLiveSessionIds: vi.fn(async () => null),
  getLiveTmuxSessions: vi.fn(async () => new Set<string>()),
  getSessionTty: vi.fn(async () => null),
  tmuxSessionExists: vi.fn(async () => false),
  tmuxPaneIsStrayShell: vi.fn(async () => false),
  sessionIsClientOf: vi.fn(async () => false),
  findSessionAttachedToTmux: vi.fn(async () => null),
  reattachAndRecord: vi.fn(async () => null),
  reattachTmuxSession: vi.fn(async () => null),
  reattachOrFocus: vi.fn(async () => 'none' as const),
}))

const TOKEN = 'server-wiring-token-0123456789abcdefghijklmno'
const ORCHESTRATOR_SESSION_ID = 'orchestrator-session-id'
const PROXIED = { 'X-Forwarded-For': '100.64.1.2' }

let tmpDir: string
let tokenFile: string
let server: Server
let port: number
let loopbackUrl: string
let LOGIN_PATH: string
let LOGOUT_PATH: string
let REMOTE_SESSION_COOKIE: string
let registeredRoutes: { method: string; path: string }[]

const lanAddress = firstNonLoopbackIPv4()
const NO_LAN_REASON = 'no non-internal IPv4 interface on this machine — cannot produce a non-loopback peer'

function sessionCookie(): string {
  return `${REMOTE_SESSION_COOKIE}=${TOKEN}`
}

function postStageSkill(origin: string, headers: Record<string, string>, body: Record<string, unknown>) {
  return fetch(`${origin}/stage-skill/dev-ready`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

interface RouteLayer {
  route?: { path: unknown; methods: Record<string, boolean> }
}

// Express 4 keeps its route table on the private `_router`, with no public
// accessor and no type for it. Reading it is the only way to prove "a route
// added next month is gated too" without a hand-kept list that would drift.
function listRegisteredRoutes(app: unknown): { method: string; path: string }[] {
  const stack = (app as { _router: { stack: RouteLayer[] } })._router.stack
  return stack.flatMap((layer) => {
    const route = layer.route
    if (!route || typeof route.path !== 'string') return []
    const concretePath = route.path.replace(/:[^/]+/g, 'x')
    return Object.keys(route.methods).map((method) => ({ method: method.toUpperCase(), path: concretePath }))
  })
}

beforeAll(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-remote-auth-wiring-')))
  tokenFile = path.join(tmpDir, 'config', 'remote-token')
  process.env.TASKS_DIR = tmpDir
  process.env.COCKPIT_DISPATCH_ENABLED = '1'
  // Read live per request (see remoteToken.ts), so tests toggle remote access
  // on and off by writing and deleting this file — never the real one.
  process.env.PIPELINELY_REMOTE_TOKEN_FILE = tokenFile

  const remoteAuth = await import('./remoteAuth.js')
  LOGIN_PATH = remoteAuth.LOGIN_PATH
  LOGOUT_PATH = remoteAuth.LOGOUT_PATH
  REMOTE_SESSION_COOKIE = remoteAuth.REMOTE_SESSION_COOKIE

  const { app } = await import('./server.js')
  registeredRoutes = listRegisteredRoutes(app)
  await new Promise<void>((resolve) => {
    server = app.listen(0, '0.0.0.0', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a network address')
  port = address.port
  loopbackUrl = `http://127.0.0.1:${port}`
}, 30_000)

afterAll(async () => {
  // Guarded so a failed beforeAll reports its own error, not this one.
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
  delete process.env.COCKPIT_DISPATCH_ENABLED
  delete process.env.PIPELINELY_REMOTE_TOKEN_FILE
})

beforeEach(async () => {
  stageInSessionCalls.length = 0
  pasteIntoSessionQuietCalls.length = 0
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  await fs.writeFile(path.join(tmpDir, 'ORCHESTRATOR_SESSION'), ORCHESTRATOR_SESSION_ID)
  await fs.mkdir(path.dirname(tokenFile), { recursive: true })
  await fs.writeFile(tokenFile, TOKEN, { mode: 0o600 })
})

describe('the desktop (plain loopback) is untouched', () => {
  it('reads /api/tasks with no cookie', async () => {
    expect((await fetch(`${loopbackUrl}/api/tasks`)).status).toBe(200)
  })

  it('still only stages a loopback autoSubmit:true — the 2026-09-06 constraint', async () => {
    const res = await postStageSkill(loopbackUrl, {}, { stage: 'dev', autoSubmit: true })
    expect(await res.json()).toEqual({ submitted: false })
    expect(pasteIntoSessionQuietCalls).toEqual([])
  })

  it('works with remote access off too', async () => {
    await fs.rm(tokenFile)
    expect((await fetch(`${loopbackUrl}/api/tasks`)).status).toBe(200)
  })
})

describe('a remote client with no session is stopped before every route', () => {
  it('401s /api/tasks, /api/access and /events', async () => {
    for (const route of ['/api/tasks', '/api/access', '/events']) {
      const res = await fetch(`${loopbackUrl}${route}`, { headers: PROXIED })
      expect(res.status, route).toBe(401)
    }
  })

  // Derived from the live route table, not a list: whatever route server.ts
  // registers is gated by default. Only the gate's own login/logout routes
  // answer an unauthenticated remote client.
  it('401s every registered route, including any added after this test was written', async () => {
    const gatedRoutes = registeredRoutes.filter((route) => route.path !== LOGIN_PATH && route.path !== LOGOUT_PATH)
    // Guards against a routing refactor making this loop vacuous.
    expect(gatedRoutes.length).toBeGreaterThan(30)

    for (const route of gatedRoutes) {
      const res = await fetch(`${loopbackUrl}${route.path}`, { method: route.method, headers: PROXIED })
      expect(res.status, `${route.method} ${route.path}`).toBe(401)
    }
    expect(stageInSessionCalls).toEqual([])
    expect(pasteIntoSessionQuietCalls).toEqual([])
  })

  it('401s the static bundle, so nothing is served ahead of the gate', async () => {
    const res = await fetch(`${loopbackUrl}/assets/anything.js`, { headers: PROXIED })
    expect(res.status).toBe(401)
  })

  it('never reaches the terminal for a POST /stage-skill autoSubmit:true — the audit finding', async () => {
    const res = await postStageSkill(loopbackUrl, PROXIED, { stage: 'dev', autoSubmit: true })
    expect(res.status).toBe(401)
    expect(stageInSessionCalls).toEqual([])
    expect(pasteIntoSessionQuietCalls).toEqual([])
  })

  it.skipIf(lanAddress === null)(`does the same for a real LAN peer (${NO_LAN_REASON})`, async () => {
    const res = await postStageSkill(`http://${lanAddress}:${port}`, {}, { stage: 'dev', autoSubmit: true })
    expect(res.status).toBe(401)
    expect(pasteIntoSessionQuietCalls).toEqual([])
  })

  it('sends a page navigation to the login page', async () => {
    const res = await fetch(`${loopbackUrl}/task/some-task`, {
      headers: { ...PROXIED, Accept: 'text/html' },
      redirect: 'manual',
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(LOGIN_PATH)
  })

  it('answers 403 remote-access-disabled when remote access is off', async () => {
    await fs.rm(tokenFile)
    const res = await fetch(`${loopbackUrl}/api/tasks`, { headers: { ...PROXIED, Cookie: sessionCookie() } })
    expect(res.status).toBe(403)
  })
})

// The desktop browser is trusted as loopback, so these are the two ways a web
// page could still drive the dashboard through it.
describe('a page on another site, reaching the desktop dashboard through its browser', () => {
  it('cannot read task data through a rebound DNS name', async () => {
    const res = await rawHttpRequest(port, 'GET', '/api/tasks', { Host: `attacker.example:${port}` })
    expect(res.status).toBe(403)
  })

  it('cannot stage a command with a cross-site form POST', async () => {
    const res = await rawHttpRequest(port, 'POST', '/stage-skill/dev-ready', {
      Host: `127.0.0.1:${port}`,
      Origin: 'http://attacker.example',
      'Content-Type': 'application/x-www-form-urlencoded',
    })
    expect(res.status).toBe(403)
    expect(stageInSessionCalls).toEqual([])
    expect(pasteIntoSessionQuietCalls).toEqual([])
  })
})

describe('a signed-in remote client', () => {
  it('signs in through the real login route and reads the dashboard with the cookie it got', async () => {
    const login = await fetch(`${loopbackUrl}${LOGIN_PATH}`, {
      method: 'POST',
      headers: { ...PROXIED, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TOKEN }).toString(),
      redirect: 'manual',
    })
    expect(login.status).toBe(303)
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]

    const res = await fetch(`${loopbackUrl}/api/tasks`, { headers: { ...PROXIED, Cookie: cookie } })
    expect(res.status).toBe(200)
  })

  it.skipIf(lanAddress === null)(`auto-submits from a real LAN peer, as today (${NO_LAN_REASON})`, async () => {
    const res = await postStageSkill(`http://${lanAddress}:${port}`, { Cookie: sessionCookie() }, { stage: 'dev', autoSubmit: true })
    expect(await res.json()).toEqual({ submitted: true })
    expect(pasteIntoSessionQuietCalls).toHaveLength(1)
  })

  // The default answer to QUESTIONS.md's proxy question: a proxy header can
  // make a request need a session, but it never turns a loopback TCP peer into
  // one that auto-submits. Auto-submit stays keyed to the real peer address.
  it('only stages when it arrives over loopback through a proxy', async () => {
    const res = await postStageSkill(loopbackUrl, { ...PROXIED, Cookie: sessionCookie() }, { stage: 'dev', autoSubmit: true })
    expect(await res.json()).toEqual({ submitted: false })
    expect(pasteIntoSessionQuietCalls).toEqual([])
    expect(stageInSessionCalls).toHaveLength(1)
  })
})
