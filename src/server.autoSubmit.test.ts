import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import { firstNonLoopbackIPv4 } from './testNetwork.js'

// The regression constraint of the whole auto-submit feature, proven at the
// production wiring level: POST /stage-skill/:slug decides between "stage and
// wait for a human Return" and "submit it right now", and it must make that
// decision from the request's own TCP peer — never from the request body
// alone. A localhost request carrying `autoSubmit: true` is exactly what the
// 2026-09-06 incident would look like if it came back, and case 1 below is the
// test that fails if it does.
//
// This lives in vitest, not Playwright, on purpose: this task's standing rule
// is that no e2e run may happen without asking the developer first, every
// single time, so the one check that must never be skipped is deliberately in
// the suite the verifier runs unattended.
//
// Mocks only the osascript/tmux-touching surface of focusTab.js — never route
// logic — following src/server.orchestratorLock.test.ts's precedent. The three
// write functions are distinguishable, which is the whole point: asserting
// "staged, not submitted" means asserting which function the route reached for.

const stageInSessionCalls: { sessionId: string; text: string }[] = []
const pasteIntoSessionQuietCalls: { sessionId: string; text: string }[] = []
const pasteIntoSessionCalls: { sessionId: string; text: string }[] = []

// Spreads the real module and overrides only the exports that actually shell
// out to osascript/tmux. Listing the fakes by hand instead would silently
// break the moment focusTab.ts gains an export something in the server's
// import graph needs — refreshTasks()'s own getLiveSessionIds() call is
// exactly that trap — while leaving the pure helpers (buildSessionWriteScript
// and friends) genuinely real.
vi.mock('./focusTab.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./focusTab.js')>()),

  stageInSession: vi.fn(async (sessionId: string, text: string) => {
    stageInSessionCalls.push({ sessionId, text })
    return true
  }),
  // The auto-submitted remote path. Tracked separately from pasteIntoSession
  // so "submitted quietly" and "submitted with a window jump" can never be
  // confused for one another by a passing test.
  pasteIntoSessionQuiet: vi.fn(async (sessionId: string, text: string) => {
    pasteIntoSessionQuietCalls.push({ sessionId, text })
    return true
  }),
  // Must stay at zero calls in every case in this file — /stage-skill is not
  // allowed to reach for the focus-stealing variant at all any more.
  pasteIntoSession: vi.fn(async (sessionId: string, text: string) => {
    pasteIntoSessionCalls.push({ sessionId, text })
    return true
  }),

  // Everything below merely has to not touch the real machine.
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
  openVSCode: vi.fn(async () => undefined),
  openBrowserUrl: vi.fn(async () => undefined),
  openAnnotationSession: vi.fn(async () => ({ status: 'error' as const, error: 'not exercised in this suite' })),
  pasteIntoTrackedSession: vi.fn(async () => ({ status: 'no-session' as const, hadRecordedSession: false })),
}))

const ORCHESTRATOR_SESSION_ID = 'orchestrator-session-id'
const OWN_SESSION_SLUG = 'quiet-own-session-fixture'
const OWN_SESSION_ID = 'own-session-id'

let tmpDir: string
let server: Server
let port: number
let loopbackUrl: string

const lanAddress = firstNonLoopbackIPv4()
const NO_LAN_REASON = 'no non-internal IPv4 interface on this machine — cannot produce a non-loopback peer'

function remoteUrl(): string {
  return `http://${lanAddress}:${port}`
}

async function postStageSkill(origin: string, slug: string, body: Record<string, unknown>) {
  return fetch(`${origin}/stage-skill/${slug}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// Gets the task into currentTasks, which is emptier than it looks: the
// server's chokidar watcher is configured `ignoreInitial: true`, so simply
// having written the task directory before import populates nothing — no
// event ever fires for files that were already there, and refreshTasks() is
// otherwise only called from main() (never run in a vitest suite) and from a
// five-minute interval. Rewriting a WATCHED file with its own unchanged
// contents is a real change event, which is what actually triggers the
// refresh.
//
// Rewritten on every attempt rather than once up front, because the watcher
// may not have finished becoming ready when the first write lands.
//
// expect.poll() is test-scoped and throws if called from a hook, so this is a
// plain loop. It throws rather than returning quietly: a missing task here
// would send every own-session case down the 404 branch, where they would
// assert nothing and still go green.
async function waitForTaskToRegister(slug: string, timeoutMs = 10_000): Promise<void> {
  const statusPath = path.join(tmpDir, slug, 'STATUS')
  const status = await fs.readFile(statusPath, 'utf-8')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await fs.writeFile(statusPath, status)
    const res = await fetch(`${loopbackUrl}/api/tasks`)
    const { tasks } = (await res.json()) as { tasks: { slug: string }[] }
    if (tasks.some((task) => task.slug === slug)) return
    if (Date.now() > deadline) {
      throw new Error(
        `task "${slug}" never appeared in /api/tasks within ${timeoutMs}ms — no watched write ever ` +
          'reached refreshTasks(), so every own-session case would have taken the 404 branch and ' +
          'passed while asserting nothing',
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

beforeAll(async () => {
  // realpath, not the raw mkdtemp result: on macOS os.tmpdir() is
  // /var/folders/..., a symlink to /private/var/folders/.... The server's
  // chokidar watcher would be registered on the symlinked spelling while the
  // filesystem reports events under the resolved one, so no watched write
  // would ever reach refreshTasks() and currentTasks would stay empty.
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-auto-submit-test-')))
  process.env.TASKS_DIR = tmpDir

  // Written BEFORE importing server.js: currentTasks is only ever filled by
  // refreshTasks(), which runs from main() (never called here) and from the
  // module-scope chokidar watcher. The own-session branch does a
  // currentTasks.find() and 404s on a miss, so without this the own-session
  // cases below would 404 and pass vacuously — asserting nothing at all.
  const taskDir = path.join(tmpDir, OWN_SESSION_SLUG)
  await fs.mkdir(taskDir, { recursive: true })
  await fs.writeFile(
    path.join(taskDir, 'TASK.md'),
    '# Own-session fixture\n\n## Workspace\n- Repo: cockpit-ai\n- Branch: claude/quiet-own-session-fixture\n',
  )
  await fs.writeFile(path.join(taskDir, 'STATUS'), 'waiting: QA found 2 issues, triage and dispatch qa-fixes\n')
  await fs.writeFile(path.join(taskDir, 'ITERM_SESSION'), OWN_SESSION_ID + '\n')

  const { app } = await import('./server.js')
  await new Promise<void>((resolve) => {
    // Explicit 0.0.0.0 rather than the bare listen(0) the other server suites
    // use: the remote-direction cases connect over this machine's own LAN
    // address, which an IPv6-only-reachable socket would refuse outright.
    server = app.listen(0, '0.0.0.0', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a network address')
  port = address.port
  loopbackUrl = `http://127.0.0.1:${port}`

  // The watcher's initial scan is asynchronous, so wait for it to actually
  // land rather than racing it. Throws rather than returning quietly: a
  // missing task here would send every own-session case down the 404 branch,
  // where they would assert nothing and still go green.
  await waitForTaskToRegister(OWN_SESSION_SLUG)
}, 30_000)

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
  await fs.rm(tmpDir, { recursive: true, force: true })
})

beforeEach(async () => {
  stageInSessionCalls.length = 0
  pasteIntoSessionQuietCalls.length = 0
  pasteIntoSessionCalls.length = 0
  // No ORCHESTRATOR_TMUX on purpose: with no live tmux session recorded,
  // writeToOrchestrator takes its fast path and writes to the recorded tab
  // directly, which is the branch these cases are about.
  await fs.writeFile(path.join(tmpDir, 'ORCHESTRATOR_SESSION'), ORCHESTRATOR_SESSION_ID)
  await fs.rm(path.join(tmpDir, 'ORCHESTRATOR_TMUX'), { force: true })
})

describe('GET /api/access', () => {
  it('reports isRemoteAccess false to a loopback caller', async () => {
    const res = await fetch(`${loopbackUrl}/api/access`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ isRemoteAccess: false })
  })

  it.skipIf(lanAddress === null)(`reports isRemoteAccess true to a non-loopback caller (${NO_LAN_REASON})`, async () => {
    const res = await fetch(`${remoteUrl()}/api/access`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ isRemoteAccess: true })
  })
})

describe('POST /stage-skill/:slug — orchestrator-target stage (dev)', () => {
  // THE regression constraint. If this ever fails, the 2026-09-06 incident is
  // back: a request from the desktop browser got its command actually run
  // instead of staged for review.
  it('a LOOPBACK request carrying autoSubmit:true is still only staged', async () => {
    const res = await postStageSkill(loopbackUrl, 'dev-ready', { stage: 'dev', autoSubmit: true })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ submitted: false })
    expect(stageInSessionCalls).toEqual([
      { sessionId: ORCHESTRATOR_SESSION_ID, text: '/pipelinely-dev dev-ready' },
    ])
    expect(pasteIntoSessionQuietCalls).toEqual([])
    expect(pasteIntoSessionCalls).toEqual([])
  })

  it('a loopback request with no flag is staged, exactly as it is today', async () => {
    const res = await postStageSkill(loopbackUrl, 'dev-ready', { stage: 'dev' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ submitted: false })
    expect(stageInSessionCalls).toHaveLength(1)
    expect(pasteIntoSessionQuietCalls).toEqual([])
  })

  it.skipIf(lanAddress === null)('a remote request carrying autoSubmit:true is submitted, quietly', async () => {
    const res = await postStageSkill(remoteUrl(), 'dev-ready', { stage: 'dev', autoSubmit: true })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ submitted: true })
    expect(pasteIntoSessionQuietCalls).toEqual([
      { sessionId: ORCHESTRATOR_SESSION_ID, text: '/pipelinely-dev dev-ready' },
    ])
    expect(stageInSessionCalls).toEqual([])
    // Never the focus-stealing variant — an unattended, phone-triggered write
    // must not jump the developer's windows.
    expect(pasteIntoSessionCalls).toEqual([])
  })

  it.skipIf(lanAddress === null)('a remote request with no flag is staged', async () => {
    const res = await postStageSkill(remoteUrl(), 'dev-ready', { stage: 'dev' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ submitted: false })
    expect(stageInSessionCalls).toHaveLength(1)
    expect(pasteIntoSessionQuietCalls).toEqual([])
  })

  // The flag is read with === true, so a client that sends a truthy-but-wrong
  // value gets the safe answer rather than an accidental submit.
  it.skipIf(lanAddress === null)('a remote request whose autoSubmit is truthy but not the boolean true is staged', async () => {
    for (const value of ['true', 1, {}, ['yes']]) {
      stageInSessionCalls.length = 0
      pasteIntoSessionQuietCalls.length = 0

      const res = await postStageSkill(remoteUrl(), 'dev-ready', { stage: 'dev', autoSubmit: value })

      expect(await res.json()).toEqual({ submitted: false })
      expect(pasteIntoSessionQuietCalls).toEqual([])
      expect(stageInSessionCalls).toHaveLength(1)
    }
  })
})

describe('POST /stage-skill/:slug — own-session-target stage (qa-fixes)', () => {
  it('a LOOPBACK request carrying autoSubmit:true is still only staged', async () => {
    const res = await postStageSkill(loopbackUrl, OWN_SESSION_SLUG, { stage: 'qa-fixes', autoSubmit: true })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ submitted: false })
    expect(stageInSessionCalls).toEqual([{ sessionId: OWN_SESSION_ID, text: '/pipelinely-qa-fixes' }])
    expect(pasteIntoSessionQuietCalls).toEqual([])
    expect(pasteIntoSessionCalls).toEqual([])
  })

  it.skipIf(lanAddress === null)('a remote request carrying autoSubmit:true is submitted, quietly', async () => {
    const res = await postStageSkill(remoteUrl(), OWN_SESSION_SLUG, { stage: 'qa-fixes', autoSubmit: true })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ submitted: true })
    expect(pasteIntoSessionQuietCalls).toEqual([{ sessionId: OWN_SESSION_ID, text: '/pipelinely-qa-fixes' }])
    expect(stageInSessionCalls).toEqual([])
    expect(pasteIntoSessionCalls).toEqual([])
  })

  it.skipIf(lanAddress === null)('a remote request with no flag is staged', async () => {
    const res = await postStageSkill(remoteUrl(), OWN_SESSION_SLUG, { stage: 'qa-fixes' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ submitted: false })
    expect(stageInSessionCalls).toHaveLength(1)
    expect(pasteIntoSessionQuietCalls).toEqual([])
  })
})
