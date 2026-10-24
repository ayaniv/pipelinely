import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import crypto from 'node:crypto'
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
// Mocks only the osascript/tmux-touching surface — never route logic —
// following src/server.orchestratorLock.test.ts's precedent. The write itself
// is writeTextToTmuxSession's {submit} option: "staged, not submitted" means
// submit:false, and a stage (as opposed to a send) is also the only mode that
// brings the attached tab forward.

vi.mock('./tmuxPaneWrite.js', () => ({
  writeTextToTmuxSession: vi.fn(async (_session: string, _text: string, _options: { submit: boolean }) => ({ status: 'ok', paneId: '%7' })),
}))

// Spreads the real module and overrides only the exports that actually shell
// out to osascript/tmux. Listing the fakes by hand instead would silently
// break the moment focusTab.ts gains an export something in the server's
// import graph needs — refreshTasks()'s own getLiveSessionIds() call is
// exactly that trap.
vi.mock('./focusTab.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./focusTab.js')>()),
  focusITermTab: vi.fn(async () => false),
  getLiveSessionIds: vi.fn(async () => null),
  getLiveTmuxSessions: vi.fn(async () => new Set<string>()),
  getSessionTty: vi.fn(async () => null),
  tmuxSessionExists: vi.fn(async () => false),
  findSessionAttachedToTmux: vi.fn(async () => ATTACHED_TAB_ID),
  reattachAndRecord: vi.fn(async () => null),
  reattachTmuxSession: vi.fn(async () => null),
  reattachOrFocus: vi.fn(async () => 'none' as const),
  openVSCode: vi.fn(async () => undefined),
  openBrowserUrl: vi.fn(async () => undefined),
  openAnnotationSession: vi.fn(async () => ({ status: 'error' as const, error: 'not exercised in this suite' })),
}))

const ORCHESTRATOR_TMUX_NAME = 'orchestrator'
const ATTACHED_TAB_ID = 'attached-tab-id'
const OWN_SESSION_SLUG = 'quiet-own-session-fixture'
const OWN_TMUX_NAME = 'worker-quiet-own-session-fixture'
const OWN_SESSION_ID = 'own-session-id'
const NO_TMUX_SLUG = 'no-tmux-own-session-fixture'

let tmpDir: string
let server: Server
let port: number
let loopbackUrl: string

const lanAddress = firstNonLoopbackIPv4()
const NO_LAN_REASON = 'no non-internal IPv4 interface on this machine — cannot produce a non-loopback peer'

function remoteUrl(): string {
  return `http://${lanAddress}:${port}`
}

// A random per-run token, never anything resembling a real one. A remote peer
// is only let through the remote-auth gate with the session cookie, so every
// remote case sends it; the loopback ones do not need it.
const TOKEN = `auto-submit-test-${crypto.randomUUID()}-${crypto.randomUUID()}`
let sessionCookie: string

async function postStageSkill(origin: string, slug: string, body: Record<string, unknown>) {
  return fetch(`${origin}/stage-skill/${slug}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin === loopbackUrl ? {} : { Cookie: sessionCookie }) },
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
  // The orchestrator-target cases below go through writeToOrchestrator, so
  // this suite runs as the canonical instance throughout — canonical-instance
  // gating itself is server.canonicalGate.test.ts's job, not this file's.
  process.env.COCKPIT_DISPATCH_ENABLED = '1'
  const tokenFile = path.join(tmpDir, 'remote-token')
  await fs.writeFile(tokenFile, TOKEN, { mode: 0o600 })
  process.env.PIPELINELY_REMOTE_TOKEN_FILE = tokenFile
  const { REMOTE_SESSION_COOKIE } = await import('./remoteAuth.js')
  sessionCookie = `${REMOTE_SESSION_COOKIE}=${TOKEN}`

  // Written BEFORE importing server.js: currentTasks is only ever filled by
  // refreshTasks(), which runs from main() (never called here) and from the
  // module-scope chokidar watcher. The own-session branch does a
  // currentTasks.find() and 404s on a miss, so without this the own-session
  // cases below would 404 and pass vacuously — asserting nothing at all.
  for (const [slug, tmuxName] of [[OWN_SESSION_SLUG, OWN_TMUX_NAME], [NO_TMUX_SLUG, null]] as const) {
    const taskDir = path.join(tmpDir, slug)
    await fs.mkdir(taskDir, { recursive: true })
    await fs.writeFile(
      path.join(taskDir, 'TASK.md'),
      `# Own-session fixture\n\n## Workspace\n- Repo: cockpit-ai\n- Branch: claude/${slug}\n`,
    )
    await fs.writeFile(path.join(taskDir, 'STATUS'), 'waiting: QA found 2 issues, triage and dispatch qa-fixes\n')
    await fs.writeFile(path.join(taskDir, 'ITERM_SESSION'), OWN_SESSION_ID + '\n')
    if (tmuxName) await fs.writeFile(path.join(taskDir, 'TMUX_SESSION'), tmuxName + '\n')
  }

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
  await waitForTaskToRegister(NO_TMUX_SLUG)
}, 30_000)

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
  await fs.rm(tmpDir, { recursive: true, force: true })
  delete process.env.COCKPIT_DISPATCH_ENABLED
  delete process.env.PIPELINELY_REMOTE_TOKEN_FILE
})

beforeEach(async () => {
  const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
  vi.mocked(writeTextToTmuxSession).mockReset()
  vi.mocked(writeTextToTmuxSession).mockResolvedValue({ status: 'ok', paneId: '%7' })
  const { focusITermTab } = await import('./focusTab.js')
  vi.mocked(focusITermTab).mockClear()
  await fs.writeFile(path.join(tmpDir, 'ORCHESTRATOR_SESSION'), ATTACHED_TAB_ID)
  await fs.writeFile(path.join(tmpDir, 'ORCHESTRATOR_TMUX'), ORCHESTRATOR_TMUX_NAME)
})

async function tmuxWriteCalls() {
  const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
  return vi.mocked(writeTextToTmuxSession).mock.calls
}

async function focusedTabIds() {
  const { focusITermTab } = await import('./focusTab.js')
  return vi.mocked(focusITermTab).mock.calls.map((call) => call[1])
}

describe('GET /api/access', () => {
  it('reports isRemoteAccess false to a loopback caller', async () => {
    const res = await fetch(`${loopbackUrl}/api/access`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ isRemoteAccess: false, hasRemoteSession: false })
  })

  it.skipIf(lanAddress === null)(`reports isRemoteAccess true to a non-loopback caller (${NO_LAN_REASON})`, async () => {
    const res = await fetch(`${remoteUrl()}/api/access`, { headers: { Cookie: sessionCookie } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ isRemoteAccess: true, hasRemoteSession: true })
  })
})

describe('POST /stage-skill/:slug — orchestrator-target stage (dev)', () => {
  const DEV_COMMAND = '/pipelinely-dev dev-ready'

  // THE regression constraint. If this ever fails, the 2026-09-06 incident is
  // back: a request from the desktop browser got its command actually run
  // instead of staged for review.
  it('a LOOPBACK request carrying autoSubmit:true is still only staged', async () => {
    const res = await postStageSkill(loopbackUrl, 'dev-ready', { stage: 'dev', autoSubmit: true })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ submitted: false })
    expect(await tmuxWriteCalls()).toEqual([[ORCHESTRATOR_TMUX_NAME, DEV_COMMAND, { submit: false }]])
  })

  it('a loopback request with no flag is staged, exactly as it is today, and brings the attached tab forward', async () => {
    const res = await postStageSkill(loopbackUrl, 'dev-ready', { stage: 'dev' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ submitted: false })
    expect(await tmuxWriteCalls()).toEqual([[ORCHESTRATOR_TMUX_NAME, DEV_COMMAND, { submit: false }]])
    expect(await focusedTabIds()).toEqual([ATTACHED_TAB_ID])
  })

  it.skipIf(lanAddress === null)('a remote request carrying autoSubmit:true is submitted, without jumping the developer\'s windows', async () => {
    const res = await postStageSkill(remoteUrl(), 'dev-ready', { stage: 'dev', autoSubmit: true })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ submitted: true })
    expect(await tmuxWriteCalls()).toEqual([[ORCHESTRATOR_TMUX_NAME, DEV_COMMAND, { submit: true }]])
    // An unattended, phone-triggered write must not jump the developer's windows.
    expect(await focusedTabIds()).toEqual([])
  })

  it.skipIf(lanAddress === null)('a remote request with no flag is staged', async () => {
    const res = await postStageSkill(remoteUrl(), 'dev-ready', { stage: 'dev' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ submitted: false })
    expect(await tmuxWriteCalls()).toEqual([[ORCHESTRATOR_TMUX_NAME, DEV_COMMAND, { submit: false }]])
  })

  // The flag is read with === true, so a client that sends a truthy-but-wrong
  // value gets the safe answer rather than an accidental submit.
  it.skipIf(lanAddress === null)('a remote request whose autoSubmit is truthy but not the boolean true is staged', async () => {
    for (const value of ['true', 1, {}, ['yes']]) {
      const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
      vi.mocked(writeTextToTmuxSession).mockClear()

      const res = await postStageSkill(remoteUrl(), 'dev-ready', { stage: 'dev', autoSubmit: value })

      expect(await res.json()).toEqual({ submitted: false })
      expect(await tmuxWriteCalls()).toEqual([[ORCHESTRATOR_TMUX_NAME, DEV_COMMAND, { submit: false }]])
    }
  })

  it('no ORCHESTRATOR_TMUX recorded: refuses with 503 and types nothing', async () => {
    await fs.rm(path.join(tmpDir, 'ORCHESTRATOR_TMUX'), { force: true })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const res = await postStageSkill(loopbackUrl, 'dev-ready', { stage: 'dev' })
      expect(res.status).toBe(503)
      expect(await tmuxWriteCalls()).toEqual([])
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('POST /stage-skill/:slug — own-session-target stage (qa-fixes)', () => {
  it('a LOOPBACK request carrying autoSubmit:true is still only staged, and focuses the attached tab', async () => {
    const res = await postStageSkill(loopbackUrl, OWN_SESSION_SLUG, { stage: 'qa-fixes', autoSubmit: true })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ submitted: false })
    expect(await tmuxWriteCalls()).toEqual([[OWN_TMUX_NAME, '/pipelinely-qa-fixes', { submit: false }]])
    expect(await focusedTabIds()).toEqual([ATTACHED_TAB_ID])
  })

  it.skipIf(lanAddress === null)('a remote request carrying autoSubmit:true is submitted, without focusing iTerm', async () => {
    const res = await postStageSkill(remoteUrl(), OWN_SESSION_SLUG, { stage: 'qa-fixes', autoSubmit: true })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ submitted: true })
    expect(await tmuxWriteCalls()).toEqual([[OWN_TMUX_NAME, '/pipelinely-qa-fixes', { submit: true }]])
    expect(await focusedTabIds()).toEqual([])
  })

  it.skipIf(lanAddress === null)('a remote request with no flag is staged', async () => {
    const res = await postStageSkill(remoteUrl(), OWN_SESSION_SLUG, { stage: 'qa-fixes' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ submitted: false })
    expect(await tmuxWriteCalls()).toEqual([[OWN_TMUX_NAME, '/pipelinely-qa-fixes', { submit: false }]])
    expect(await focusedTabIds()).toEqual([ATTACHED_TAB_ID])
  })

  it('409 with the refusal reason when the pane is not ready, and nothing is focused', async () => {
    const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
    vi.mocked(writeTextToTmuxSession).mockResolvedValueOnce({ status: 'refused', reason: 'dialog-open' })

    const res = await postStageSkill(loopbackUrl, OWN_SESSION_SLUG, { stage: 'qa-fixes' })
    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe('dialog-open')
    expect(await focusedTabIds()).toEqual([])
  })

  it('503 when the pane fell back to a shell', async () => {
    const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
    vi.mocked(writeTextToTmuxSession).mockResolvedValueOnce({ status: 'refused', reason: 'stray-shell' })

    const res = await postStageSkill(loopbackUrl, OWN_SESSION_SLUG, { stage: 'qa-fixes' })
    expect(res.status).toBe(503)
  })

  it('500 with the failing step when the tmux write fails', async () => {
    const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
    vi.mocked(writeTextToTmuxSession).mockResolvedValueOnce({ status: 'failed', step: 'submit', error: 'boom' })

    const res = await postStageSkill(loopbackUrl, OWN_SESSION_SLUG, { stage: 'qa-fixes' })
    expect(res.status).toBe(500)
    expect((await res.json()).step).toBe('submit')
  })

  it('503 and no write when the task has no TMUX_SESSION recorded', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const res = await postStageSkill(loopbackUrl, NO_TMUX_SLUG, { stage: 'qa-fixes' })
      expect(res.status).toBe(503)
      expect(await tmuxWriteCalls()).toEqual([])
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})
