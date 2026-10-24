import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'

// The auto pass must take QA consent from the recorded qaStartPolicy and from
// nothing else. Today QA has no intent brief, so the decision never dispatches
// it whatever the setting says; this suite gives QA a brief (the one input the
// wrapper below changes) so the setting is the only thing left deciding, and
// the wiring from SETTINGS.json to the pass is observable. No case can reach a
// real terminal or tmux: focusTab and tmuxPaneWrite are mocked, and with no
// ORCHESTRATOR_TMUX recorded a dispatch ends in an "auto-dispatch failed"
// TIMELINE line.

vi.mock('./tmuxPaneWrite.js', () => ({
  writeTextToTmuxSession: vi.fn(async () => ({ status: 'ok', paneId: '%7' })),
}))

vi.mock('./focusTab.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./focusTab.js')>()),
  getLiveTmuxSessions: vi.fn(async () => new Set<string>()),
  getLiveSessionIds: vi.fn(async () => null),
  getSessionTty: vi.fn(async () => null),
  tmuxSessionExists: vi.fn(async () => false),
  focusITermTab: vi.fn(async () => false),
}))

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

const QA_MARKER = 'CR approved, ready for QA'
const UI_VERIFY = 'npx playwright test --project=ui --grep-invert @pending'
const SETTLE_MS = 500

let tmpDir: string
let baseUrl: string
let server: Server

async function waitFor<T>(read: () => Promise<T | null | undefined | false>, what: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function fetchSettings(): Promise<{ autoMode: boolean; qaStartPolicy: string }> {
  return ((await (await fetch(`${baseUrl}/api/tasks`)).json()) as { settings: { autoMode: boolean; qaStartPolicy: string } }).settings
}

async function recordSettings(qaStartPolicy: string): Promise<void> {
  await fs.writeFile(path.join(tmpDir, 'SETTINGS.json'), JSON.stringify({ autoMode: true, creaturePlacement: 'header', qaStartPolicy }))
  await waitFor(async () => (await fetchSettings()).qaStartPolicy === qaStartPolicy, `qaStartPolicy ${qaStartPolicy} to load`)
}

async function seedWorkingTask(slug: string): Promise<void> {
  await fs.mkdir(path.join(tmpDir, slug), { recursive: true })
  await fs.writeFile(path.join(tmpDir, slug, 'TASK.md'), '# Task\n\n## Workspace\n- Repo: cockpit-ai\n- Branch: claude/x\n')
  await fs.writeFile(path.join(tmpDir, slug, 'VERIFY'), `${UI_VERIFY}\n`)
  await fs.writeFile(path.join(tmpDir, slug, 'STATUS'), 'working\n')
  await waitFor(async () => (await (await fetch(`${baseUrl}/api/tasks`)).json() as { tasks: { slug: string }[] }).tasks.some((task) => task.slug === slug), `${slug} to load`)
}

async function handOffToQa(slug: string): Promise<void> {
  await fs.writeFile(path.join(tmpDir, slug, 'STATUS'), `waiting: ${QA_MARKER}\n`)
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
}

async function readTimeline(slug: string): Promise<string> {
  return fs.readFile(path.join(tmpDir, slug, 'TIMELINE'), 'utf-8').catch(() => '')
}

beforeAll(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-auto-qa-consent-test-')))
  process.env.TASKS_DIR = tmpDir
  await fs.writeFile(path.join(tmpDir, 'SETTINGS.json'), JSON.stringify({ autoMode: true, creaturePlacement: 'header', qaStartPolicy: 'ask-every-time' }))
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)

  const { app } = await import('./server.js')
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a network address')
  baseUrl = `http://localhost:${address.port}`
  // The chokidar watcher needs a moment to finish its initial scan before it reports new files.
  await new Promise((resolve) => setTimeout(resolve, 300))
}, 30_000)

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  await fs.rm(tmpDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('auto mode reads QA consent from the recorded qaStartPolicy only', () => {
  it('does not dispatch QA while the setting is ask-every-time, even for a ui-only VERIFY with a brief and auto mode on', async () => {
    await recordSettings('ask-every-time')
    await seedWorkingTask('consent-asks')

    await handOffToQa('consent-asks')

    expect(await readTimeline('consent-asks')).toBe('')
  })

  it('dispatches QA once the setting records the pre-approval', async () => {
    await recordSettings('cockpit-ai-ui-preapproved')
    await seedWorkingTask('consent-given')

    await handOffToQa('consent-given')

    expect(await readTimeline('consent-given')).toMatch(/ qa auto-dispatch/)
  })

  it('asks again as soon as the setting is withdrawn', async () => {
    await recordSettings('ask-every-time')
    await seedWorkingTask('consent-withdrawn')

    await handOffToQa('consent-withdrawn')

    expect(await readTimeline('consent-withdrawn')).toBe('')
  })
})
