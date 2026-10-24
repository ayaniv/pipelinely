import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'

// POST /babysit is the Push forward pill's route: it plans one sweep with the
// same planSweep the /pipelinely-babysit skill uses, and only when there is
// something to push does it submit `/pipelinely-babysit` into the orchestrator.
// Like the other dispatch suites it mocks the osascript-touching functions in
// focusTab.js and the tmux writer, so no case can reach a real terminal.

const ORCHESTRATOR_TMUX_NAME = 'orchestrator'

vi.mock('./tmuxPaneWrite.js', () => ({
  writeTextToTmuxSession: vi.fn(async (_session: string, _text: string, _options: { submit: boolean }) => ({ status: 'ok', paneId: '%7' })),
}))

vi.mock('./focusTab.js', () => ({
  tmuxSessionExists: vi.fn(async () => false),
  focusITermTab: vi.fn(async () => undefined),
  findSessionAttachedToTmux: vi.fn(async () => null),
  reattachAndRecord: vi.fn(async () => null),
  reattachOrFocus: vi.fn(async () => 'none' as const),
  openVSCode: vi.fn(async () => undefined),
  openBrowserUrl: vi.fn(async () => undefined),
  openAnnotationSession: vi.fn(async () => ({ status: 'error' as const, error: 'not exercised in this suite' })),
  getLiveSessionIds: vi.fn(async () => null),
  getLiveTmuxSessions: vi.fn(async () => null),
  normalizeWhitespace: (value: string) => value.replace(/\s+/g, ' ').trim(),
}))

// QA has no intent brief yet, so the decision never dispatches it whatever the
// setting says. Give it one (the only input this wrapper changes) so
// qaStartPolicy is the one thing left deciding whether a QA hand-off counts.
vi.mock('./nextAction.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./nextAction.js')>()
  return {
    ...original,
    decisionContext: (settings: Parameters<typeof original.decisionContext>[0]) => {
      const context = original.decisionContext(settings)
      return { ...context, intentBriefStages: [...context.intentBriefStages, 'qa' as const] }
    },
  }
})

const CR_MARKER = 'PR open, ready for CR'
const QA_MARKER = 'CR approved, ready for QA'
const UI_VERIFY = 'npx playwright test --project=ui --grep-invert @pending'
const NORMAL_LOAD = 0.5
const OVERLOADED_LOAD = 12.4
const BABYSIT_COMMAND = '/pipelinely-babysit'

let tmpDir: string
let baseUrl: string
let server: Server
let orchestratorTmuxPath: string
let errorSpy: ReturnType<typeof vi.spyOn>

async function waitFor<T>(read: () => Promise<T | null | undefined | false>, what: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function fetchSnapshot(): Promise<{ tasks: { slug: string }[]; settings: { qaStartPolicy: string } }> {
  return (await fetch(`${baseUrl}/api/tasks`)).json() as Promise<{ tasks: { slug: string }[]; settings: { qaStartPolicy: string } }>
}

async function seedTask(slug: string, { status, timeline, verifier }: { status: string; timeline?: string; verifier?: string }): Promise<void> {
  await fs.mkdir(path.join(tmpDir, slug), { recursive: true })
  await fs.writeFile(path.join(tmpDir, slug, 'TASK.md'), '# Task\n\n## Workspace\n- Repo: cockpit-ai\n- Branch: claude/x\n')
  if (verifier) await fs.writeFile(path.join(tmpDir, slug, 'VERIFY'), `${verifier}\n`)
  if (timeline) await fs.writeFile(path.join(tmpDir, slug, 'TIMELINE'), timeline)
  await fs.writeFile(path.join(tmpDir, slug, 'STATUS'), `${status}\n`)
  await waitFor(async () => (await fetchSnapshot()).tasks.some((task) => task.slug === slug), `${slug} to load`)
}

async function clearTasks(): Promise<void> {
  const entries = await fs.readdir(tmpDir, { withFileTypes: true })
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => fs.rm(path.join(tmpDir, entry.name), { recursive: true, force: true })))
  await waitFor(async () => (await fetchSnapshot()).tasks.length === 0, 'the tasks to unload')
}

async function recordQaPolicy(qaStartPolicy: string): Promise<void> {
  await fs.writeFile(path.join(tmpDir, 'SETTINGS.json'), JSON.stringify({ autoMode: false, creaturePlacement: 'header', qaStartPolicy }))
  await waitFor(async () => (await fetchSnapshot()).settings.qaStartPolicy === qaStartPolicy, `qaStartPolicy ${qaStartPolicy} to load`)
}

async function tmuxWriteCalls() {
  const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
  return vi.mocked(writeTextToTmuxSession).mock.calls
}

const postBabysit = () => fetch(`${baseUrl}/babysit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
const seedCrReady = (slug: string) => seedTask(slug, { status: `waiting: ${CR_MARKER}` })

beforeAll(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pipelinely-babysit-route-test-')))
  process.env.TASKS_DIR = tmpDir
  // This suite is about the sweep's own plan and submit, not canonical-instance
  // gating beyond its one 403 case, so it runs as the canonical instance.
  process.env.COCKPIT_DISPATCH_ENABLED = '1'
  orchestratorTmuxPath = path.join(tmpDir, 'ORCHESTRATOR_TMUX')
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

  const { app } = await import('./server.js')
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a network address')
  baseUrl = `http://127.0.0.1:${address.port}`
  // The chokidar watcher needs a moment to finish its initial scan before it reports new files.
  await new Promise((resolve) => setTimeout(resolve, 300))
}, 30_000)

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  await fs.rm(tmpDir, { recursive: true, force: true })
  delete process.env.COCKPIT_DISPATCH_ENABLED
  vi.restoreAllMocks()
})

beforeEach(async () => {
  const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
  vi.mocked(writeTextToTmuxSession).mockClear()
  errorSpy.mockClear()
  vi.spyOn(os, 'loadavg').mockReturnValue([NORMAL_LOAD, NORMAL_LOAD, NORMAL_LOAD])
  await fs.writeFile(orchestratorTmuxPath, ORCHESTRATOR_TMUX_NAME)
  await clearTasks()
  await recordQaPolicy('ask-every-time')
})

afterEach(() => {
  vi.mocked(os.loadavg).mockRestore()
})

describe('POST /babysit', () => {
  it('submits exactly /pipelinely-babysit once and reports how many tasks the sweep will push', async () => {
    await seedCrReady('sweep-a')
    await seedCrReady('sweep-b')

    const res = await postBabysit()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: 'sent', planned: 2 })
    expect(await tmuxWriteCalls()).toEqual([[ORCHESTRATOR_TMUX_NAME, BABYSIT_COMMAND, { submit: true }]])
  })

  it('writes nothing and says so when the machine is above the load ceiling', async () => {
    vi.mocked(os.loadavg).mockReturnValue([OVERLOADED_LOAD, 1, 1])
    await seedCrReady('held')

    const res = await postBabysit()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: 'load-too-high', load1: OVERLOADED_LOAD })
    expect(await tmuxWriteCalls()).toEqual([])
    expect(await fs.readFile(path.join(tmpDir, 'held', 'TIMELINE'), 'utf-8').catch(() => '')).toBe('')
  })

  it('rounds the load reading to one decimal before the pill prints it', async () => {
    vi.mocked(os.loadavg).mockReturnValue([12.409765625, 1, 1])
    await seedCrReady('held-long-load')

    expect(await (await postBabysit()).json()).toEqual({ outcome: 'load-too-high', load1: OVERLOADED_LOAD })
  })

  it('writes nothing when no task has a step to push', async () => {
    await seedTask('idle-task', { status: 'working' })

    const res = await postBabysit()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: 'nothing' })
    expect(await tmuxWriteCalls()).toEqual([])
  })

  it('does not count a hand-off an earlier dispatch already sent: that alone is nothing', async () => {
    await seedTask('in-flight', {
      status: `waiting: ${CR_MARKER}`,
      timeline: '2026-08-10T12:00:00Z code-review auto-dispatched — auto mode\n',
    })

    const res = await postBabysit()

    expect(await res.json()).toEqual({ outcome: 'nothing' })
    expect(await tmuxWriteCalls()).toEqual([])
  })

  it('counts a ui-only QA hand-off only once the recorded qaStartPolicy pre-approves it', async () => {
    await seedCrReady('cr-step')
    await seedTask('qa-step', { status: `waiting: ${QA_MARKER}`, verifier: UI_VERIFY })

    expect(await (await postBabysit()).json()).toEqual({ outcome: 'sent', planned: 1 })

    await recordQaPolicy('cockpit-ai-ui-preapproved')
    expect(await (await postBabysit()).json()).toEqual({ outcome: 'sent', planned: 2 })
  })

  it('403s from an instance that is not the canonical dashboard, and writes nothing', async () => {
    await seedCrReady('not-canonical')
    delete process.env.COCKPIT_DISPATCH_ENABLED
    try {
      const res = await postBabysit()
      expect(res.status).toBe(403)
      expect((await res.json()).error).toBeTruthy()
      expect(await tmuxWriteCalls()).toEqual([])
    } finally {
      process.env.COCKPIT_DISPATCH_ENABLED = '1'
    }
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[babysit]'), expect.anything())
  })

  it('503s with the reason and logs it when no orchestrator tmux session is recorded', async () => {
    await fs.rm(orchestratorTmuxPath, { force: true })
    await seedCrReady('no-orchestrator')

    const res = await postBabysit()

    expect(res.status).toBe(503)
    expect((await res.json()).error).toContain('not running inside tmux')
    expect(await tmuxWriteCalls()).toEqual([])
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[babysit]'), expect.anything())
  })

  it('409s naming the reason when the orchestrator pane is showing a dialog, and logs it', async () => {
    const { writeTextToTmuxSession } = await import('./tmuxPaneWrite.js')
    vi.mocked(writeTextToTmuxSession).mockResolvedValueOnce({ status: 'refused', reason: 'dialog-open' })
    await seedCrReady('dialog-open')

    const res = await postBabysit()

    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe('dialog-open')
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[babysit]'), expect.anything())
  })

  it('500s and logs when planning the sweep throws', async () => {
    await seedCrReady('plan-throws')
    vi.mocked(os.loadavg).mockImplementation(() => { throw new Error('loadavg unavailable') })

    const res = await postBabysit()

    expect(res.status).toBe(500)
    expect(await tmuxWriteCalls()).toEqual([])
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[babysit]'), expect.any(Error))
  })
})
